package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	hostwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/host/v2"
	protocolwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
)

// 宿主已装清单查询（sforum.core.extensions.inventory.list）是「这个扩展在这台
// 宿主上装了没、装的是哪个版本」的唯一来源：目录项的 installed / updateAvailable
// 全部由它派生，插件不读宿主的数据库，也不猜。
//
// 该查询在宿主侧要求清单声明 extensions.read 能力。能力未授予、宿主版本早于这条
// 查询、Host 通道没有握手、或者超时，一律降级为「没有已装信息」：目录与详情本身
// 不受影响，页面只是拿不到已装结论（installed 为 null、updateAvailable 为 false）。
//
// 成功与失败都缓存 inventoryTTL：一次能力缺失不该让每个目录请求都等满一次超时。
const (
	hostQueryInventoryID      = "sforum.core.extensions.inventory.list"
	hostQueryInventoryPlan    = "1"
	hostQueryInventoryResult  = "sforum.core.extensions.inventory"
	hostQueryInventoryVersion = "1"

	inventoryPageLimit = 100
	inventoryMaxPages  = 10
	inventoryTTL       = 60 * time.Second

	// inventoryTimeout 是整次读取（所有页）共用的预算，不是每页：清单是附加信息，
	// 不能把目录请求拖到路由自己的超时上限。
	inventoryTimeout = 2 * time.Second
)

var (
	errHostCallUnavailable  = errors.New("host query channel is not available")
	errInventoryUnavailable = errors.New("extension inventory query failed")
)

// installedExtension 是清单里的一行。version/status 是 installed 契约的全部内容；
// name 与 type 留在结构里，便于排障时对照宿主实际返回。
type installedExtension struct {
	ExtensionID string
	Name        string
	Version     string
	Type        string
	Status      string
}

// installedInventory 是一次清单读取的快照，键是扩展 id。空快照与「确实没装」在
// 本插件里是同一件事：页面拿不到已装结论就显示 null。快照发布后不再修改，
// 因此读取不需要加锁。
type installedInventory struct {
	items map[string]installedExtension
}

// lookup 只认非空的扩展 id：上游条目缺 extensionId 时不能跟空键撞上。
func (i installedInventory) lookup(extensionID string) (installedExtension, bool) {
	id := strings.TrimSpace(extensionID)
	if id == "" {
		return installedExtension{}, false
	}
	item, ok := i.items[id]
	if !ok {
		return installedExtension{}, false
	}
	return item, true
}

// inventoryCache 缓存一次清单读取。now 只给测试用：生产留空走 time.Now。
type inventoryCache struct {
	now func() time.Time

	mu        sync.RWMutex
	snapshot  installedInventory
	attemptAt time.Time
}

// inventoryPageFetcher 读一页清单：返回本页条目与下一页的 Offset，0 表示没有更多。
// 生产实现是一次 Host Query；测试注入内存实现，因此不需要 go-plugin 运行时。
type inventoryPageFetcher func(ctx context.Context, offset uint64) ([]installedExtension, uint64, error)

// installed 返回宿主已装清单快照。TTL 内直接用缓存（含失败结果）；过期后才重新
// 读取一次，读失败同样缓存一个 TTL。
func (s *storeServer) installed(ctx context.Context, routeCtx *protocolwire.RequestContext) installedInventory {
	cache := &s.inventoryCache
	now := time.Now
	if cache.now != nil {
		now = cache.now
	}

	cache.mu.RLock()
	snapshot, attemptAt := cache.snapshot, cache.attemptAt
	cache.mu.RUnlock()
	if !attemptAt.IsZero() && now().Sub(attemptAt) < inventoryTTL {
		return snapshot
	}

	// 读清单不阻塞目录的正确性：超时后按「没有已装信息」继续。
	timeoutCtx, cancel := context.WithTimeout(ctx, inventoryTimeout)
	defer cancel()
	items, err := collectInventory(timeoutCtx, s.inventoryPageFetcher(routeCtx))

	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.attemptAt = now()
	if err != nil {
		cache.snapshot = installedInventory{}
		return cache.snapshot
	}
	cache.snapshot = installedInventory{items: items}
	return cache.snapshot
}

// inventoryPageFetcher 选中本次读取的读页实现：测试注入优先，否则走 Host Query。
func (s *storeServer) inventoryPageFetcher(routeCtx *protocolwire.RequestContext) inventoryPageFetcher {
	if s.inventoryFetch != nil {
		return s.inventoryFetch
	}
	return func(ctx context.Context, offset uint64) ([]installedExtension, uint64, error) {
		return s.loadInventoryPage(ctx, routeCtx, offset)
	}
}

// collectInventory 按顶层 Offset 翻页，最多 inventoryMaxPages 页：宿主清单再大，
// 一次目录请求也不能无限翻下去。next 不前进时立刻停止，避免宿主回同一个 Offset
// 让循环空转。
func collectInventory(ctx context.Context, fetch inventoryPageFetcher) (map[string]installedExtension, error) {
	if fetch == nil {
		return nil, errInventoryUnavailable
	}
	items := make(map[string]installedExtension)
	offset := uint64(0)
	for page := 0; page < inventoryMaxPages; page++ {
		rows, next, err := fetch(ctx, offset)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if row.ExtensionID == "" {
				continue
			}
			items[row.ExtensionID] = row
		}
		if next == 0 || next <= offset {
			return items, nil
		}
		offset = next
	}
	return items, nil
}

// loadInventoryPage 通过 Host Query 读一页清单。ctx 已带着整次读取的 2 秒预算。
func (s *storeServer) loadInventoryPage(
	ctx context.Context,
	routeCtx *protocolwire.RequestContext,
	offset uint64,
) ([]installedExtension, uint64, error) {
	if s.Server == nil || routeCtx == nil {
		return nil, 0, errHostCallUnavailable
	}
	host, err := s.Host()
	if err != nil || host == nil || host.Queries == nil {
		return nil, 0, errHostCallUnavailable
	}

	response, err := host.Queries.Execute(ctx, &hostwire.QueryRequest{
		// Actor 必须清空：宿主拒绝未经 host-attested 的插件调用上下文。
		Context:             hostCallContext(routeCtx),
		QueryId:             hostQueryInventoryID,
		PlanVersion:         hostQueryInventoryPlan,
		ResultSchemaId:      hostQueryInventoryResult,
		ResultSchemaVersion: hostQueryInventoryVersion,
		// 只取与本插件有关的五行：清单行还含 capabilities / packageDigest 等字段。
		Fields: []string{"id", "name", "version", "type", "status"},
		Page:   &protocolwire.PageRequest{Limit: inventoryPageLimit},
		Offset: offset,
	})
	if err != nil {
		return nil, 0, err
	}
	// 能力未授予（清单没声明 extensions.read）时宿主回错误码而不是条目：这里一律
	// 按「没有已装信息」降级，目录不因此失败。
	if response == nil || response.GetError() != nil {
		return nil, 0, errInventoryUnavailable
	}

	rows := response.GetRows()
	items := make([]installedExtension, 0, len(rows))
	for _, row := range rows {
		if item, ok := installedExtensionFromRow(row); ok {
			items = append(items, item)
		}
	}
	return items, response.GetNextOffset(), nil
}

// installedExtensionFromRow 把一行清单文档映射成结构体；缺 id 的行直接丢弃
// （没有扩展 id 就无法与目录条目对上）。
func installedExtensionFromRow(row *protocolwire.TypedDocument) (installedExtension, bool) {
	if row == nil || row.GetValue() == nil {
		return installedExtension{}, false
	}
	values := row.GetValue().AsMap()
	id := strings.TrimSpace(stringValue(values["id"]))
	if id == "" {
		return installedExtension{}, false
	}
	return installedExtension{
		ExtensionID: id,
		Name:        strings.TrimSpace(stringValue(values["name"])),
		Version:     strings.TrimSpace(stringValue(values["version"])),
		Type:        strings.TrimSpace(stringValue(values["type"])),
		Status:      strings.TrimSpace(stringValue(values["status"])),
	}, true
}

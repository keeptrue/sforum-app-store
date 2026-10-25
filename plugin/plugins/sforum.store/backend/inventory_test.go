package main

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

// TestInstalledInventoryCollectsEveryPage 覆盖 Offset/NextOffset 翻页：第一页满
// inventoryPageLimit 条时继续读下一页，两页条目合并成一张表。
func TestInstalledInventoryCollectsEveryPage(t *testing.T) {
	firstPage := make([]installedExtension, 0, inventoryPageLimit)
	for index := 0; index < inventoryPageLimit; index++ {
		firstPage = append(firstPage, installedRow(fmt.Sprintf("sforum.plugin.p%03d", index), "1.0.0", "enabled"))
	}
	fake := newFakeInventory().
		page(0, inventoryPageLimit, firstPage...).
		page(inventoryPageLimit, 0, installedRow("sforum.store", "0.1.0", "enabled"))

	server := newTestStoreServer(t, storeSettings{})
	server.inventoryFetch = fake.fetch

	snapshot := server.installed(context.Background(), nil)
	if got := len(snapshot.items); got != inventoryPageLimit+1 {
		t.Fatalf("inventory rows = %d, want %d", got, inventoryPageLimit+1)
	}
	if got := fake.requests(); !reflect.DeepEqual(got, []uint64{0, inventoryPageLimit}) {
		t.Fatalf("offsets requested = %v, want [0 %d]", got, inventoryPageLimit)
	}
	item, ok := snapshot.lookup("sforum.store")
	if !ok || item.Version != "0.1.0" {
		t.Fatalf("lookup(sforum.store) = %v/%v, want 0.1.0", item, ok)
	}
	if _, ok := snapshot.lookup("sforum.plugin.p000"); !ok {
		t.Fatalf("the first page must be merged into the snapshot")
	}
}

// TestInstalledInventoryStopsAfterPageCap：宿主一直回「还有下一页」时最多读
// inventoryMaxPages 页，已读到的条目保留，不做无上限翻页。
func TestInstalledInventoryStopsAfterPageCap(t *testing.T) {
	fake := newFakeInventory()
	for page := uint64(0); page < 2*inventoryMaxPages; page++ {
		fake.page(page*inventoryPageLimit, (page+1)*inventoryPageLimit,
			installedRow(fmt.Sprintf("sforum.plugin.p%02d", page), "1.0.0", "enabled"))
	}
	server := newTestStoreServer(t, storeSettings{})
	server.inventoryFetch = fake.fetch

	snapshot := server.installed(context.Background(), nil)
	if got := len(fake.requests()); got != inventoryMaxPages {
		t.Fatalf("pages read = %d, want %d", got, inventoryMaxPages)
	}
	if got := len(snapshot.items); got != inventoryMaxPages {
		t.Fatalf("inventory rows = %d, want %d", got, inventoryMaxPages)
	}
}

// TestInstalledInventoryStopsWhenOffsetDoesNotAdvance：宿主回同一个 Offset 时立刻
// 停止，避免循环空转把 2 秒预算烧完。
func TestInstalledInventoryStopsWhenOffsetDoesNotAdvance(t *testing.T) {
	fake := newFakeInventory().
		page(0, inventoryPageLimit, installedRow("sforum.plugin.first", "1.0.0", "enabled")).
		page(inventoryPageLimit, inventoryPageLimit, installedRow("sforum.plugin.second", "1.0.0", "enabled"))

	server := newTestStoreServer(t, storeSettings{})
	server.inventoryFetch = fake.fetch

	snapshot := server.installed(context.Background(), nil)
	if got := fake.requests(); !reflect.DeepEqual(got, []uint64{0, inventoryPageLimit}) {
		t.Fatalf("offsets requested = %v, want the loop to stop after two reads", got)
	}
	if got := len(snapshot.items); got != 2 {
		t.Fatalf("inventory rows = %d, want 2", got)
	}
}

// TestInstalledInventoryCachesForAMinute：TTL 内重复请求不重新读宿主，TTL 之后
// 才刷新一次。
func TestInstalledInventoryCachesForAMinute(t *testing.T) {
	clock := newTestClock(baseTestTime())
	fake := newFakeInventory().page(0, 0, installedRow("sforum.store", "0.1.0", "enabled"))
	server := newTestStoreServer(t, storeSettings{})
	server.inventoryFetch = fake.fetch
	server.inventoryCache.now = clock.now

	server.installed(context.Background(), nil)
	clock.advance(inventoryTTL - time.Second)
	if _, ok := server.installed(context.Background(), nil).lookup("sforum.store"); !ok {
		t.Fatalf("cached snapshot lost the inventory row")
	}
	if got := len(fake.requests()); got != 1 {
		t.Fatalf("cache hit must not re-read the host, reads = %d", got)
	}

	clock.advance(2 * time.Second)
	server.installed(context.Background(), nil)
	if got := len(fake.requests()); got != 2 {
		t.Fatalf("expired cache must refresh once, reads = %d", got)
	}
}

// TestInstalledInventoryCachesFailures：失败也缓存一个 TTL，否则能力未授予的宿主
// 会让每个目录请求都重走一次超时。
func TestInstalledInventoryCachesFailures(t *testing.T) {
	clock := newTestClock(baseTestTime())
	fake := newFakeInventory().fail(0, errInventoryUnavailable)
	server := newTestStoreServer(t, storeSettings{})
	server.inventoryFetch = fake.fetch
	server.inventoryCache.now = clock.now

	snapshot := server.installed(context.Background(), nil)
	if _, ok := snapshot.lookup("sforum.store"); ok {
		t.Fatalf("failed read must not produce inventory rows")
	}
	server.installed(context.Background(), nil)
	if got := len(fake.requests()); got != 1 {
		t.Fatalf("failed read must be cached, reads = %d", got)
	}

	clock.advance(inventoryTTL + time.Second)
	server.installed(context.Background(), nil)
	if got := len(fake.requests()); got != 2 {
		t.Fatalf("expired failure must be retried, reads = %d", got)
	}
}

// TestInstalledInventoryDegradesWithoutHostChannel：没有握手的 Host（旧宿主或
// 测试环境）只能降级成空快照，不能 panic，也不能伪造条目。
func TestInstalledInventoryDegradesWithoutHostChannel(t *testing.T) {
	cases := map[string]struct {
		server   *storeServer
		routeCtx bool
	}{
		"no host but a route context": {server: newTestStoreServer(t, storeSettings{}), routeCtx: true},
		"no route context":            {server: newTestStoreServer(t, storeSettings{}), routeCtx: false},
		"server without embedded sdk": {server: &storeServer{store: newStoreClient()}, routeCtx: true},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			var snapshot installedInventory
			if testCase.routeCtx {
				snapshot = testCase.server.installed(context.Background(), emptyRequestContext())
			} else {
				snapshot = testCase.server.installed(context.Background(), nil)
			}
			if len(snapshot.items) != 0 {
				t.Fatalf("degraded snapshot = %#v, want an empty one", snapshot)
			}
			if _, ok := snapshot.lookup("sforum.store"); ok {
				t.Fatalf("degraded snapshot must not answer lookups")
			}
		})
	}
}

// TestInstalledInventoryLookupRejectsEmptyIDs：上游条目缺 extensionId 时不能与空键
// 撞上。
func TestInstalledInventoryLookupRejectsEmptyIDs(t *testing.T) {
	inventory := installedInventory{items: map[string]installedExtension{
		"": installedRow("", "1.0.0", "enabled"),
	}}
	for _, id := range []string{"", "   "} {
		if _, ok := inventory.lookup(id); ok {
			t.Fatalf("lookup(%q) must not match an empty inventory id", id)
		}
	}
	if _, ok := inventory.lookup("sforum.store"); ok {
		t.Fatalf("lookup of an absent extension must be false")
	}
}

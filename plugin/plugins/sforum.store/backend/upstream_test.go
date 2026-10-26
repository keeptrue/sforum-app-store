package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	pluginwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
)

func baseTestTime() time.Time {
	return time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
}

// testClock 让 TTL / stale 窗口的推进不需要 sleep。
type testClock struct {
	mu    sync.Mutex
	value time.Time
}

func newTestClock(value time.Time) *testClock {
	return &testClock{value: value}
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.value
}

func (c *testClock) advance(delta time.Duration) {
	c.mu.Lock()
	c.value = c.value.Add(delta)
	c.mu.Unlock()
}

func TestBaseEndpointRejectsUnsafeBases(t *testing.T) {
	for _, base := range []string{
		"",
		"   ",
		"http://store.example.test",
		"https://",
		"store.example.test",
		"https://user:secret@store.example.test",
		"https://store.example.test/?token=1",
		"https://store.example.test/#fragment",
	} {
		t.Run(base, func(t *testing.T) {
			if _, err := baseEndpoint(base, upstreamCatalogPath, nil); err == nil {
				t.Fatalf("base %q must be rejected", base)
			}
		})
	}

	endpoint, err := baseEndpoint(" https://store.example.test/ ", upstreamCatalogPath,
		catalogQuery{Channel: channelStable, Limit: 18}.values())
	if err != nil {
		t.Fatalf("valid base rejected: %v", err)
	}
	if !strings.HasPrefix(endpoint, "https://store.example.test/api/v1/catalog?") {
		t.Fatalf("endpoint = %q", endpoint)
	}
	if strings.Contains(endpoint, "sforum=") {
		t.Fatalf("endpoint must not carry sforum: %q", endpoint)
	}
}

func TestCatalogCacheServesFreshHitAndRevalidatesWithETag(t *testing.T) {
	clock := newTestClock(baseTestTime())
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		if call == 1 {
			writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), map[string]string{"ETag": `"v1"`})
			return
		}
		if got := r.Header.Get("If-None-Match"); got != `"v1"` {
			t.Errorf("If-None-Match = %q, want %q", got, `"v1"`)
		}
		w.WriteHeader(http.StatusNotModified)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.store.now = clock.now

	params := map[string]string{"channel": channelStable}
	first := assertJSONDocument(t, invokeRoute(t, server, routeCatalogID, params, nil), schemaCatalogResponse)
	assertFetchedAt(t, first, baseTestTime())

	// TTL 内：内存直出，上游没有新请求。
	clock.advance(5 * time.Minute)
	assertStatus(t, invokeRoute(t, server, routeCatalogID, params, nil), http.StatusOK)
	if hits := fake.hits(); hits != 1 {
		t.Fatalf("fresh cache hit should not call upstream, hits = %d", hits)
	}

	// 超过 TTL：带 If-None-Match 复验，304 复用缓存 body 并刷新 fetchedAt。
	clock.advance(6 * time.Minute)
	second := invokeRoute(t, server, routeCatalogID, params, nil)
	secondValues := assertJSONDocument(t, second, schemaCatalogResponse)
	if got := secondValues["stale"]; got != false {
		t.Fatalf("304 revalidation stale = %v, want false", got)
	}
	assertFetchedAt(t, secondValues, baseTestTime().Add(11*time.Minute))
	if !reflect.DeepEqual(first["items"], secondValues["items"]) {
		t.Fatalf("304 must reuse the cached body:\nfirst=%v\nsecond=%v", first["items"], secondValues["items"])
	}
	if hits := fake.hits(); hits != 2 {
		t.Fatalf("upstream hits = %d, want 2", hits)
	}

	// 复验成功也算一次成功读取：新的 TTL 从这里开始。
	clock.advance(5 * time.Minute)
	assertStatus(t, invokeRoute(t, server, routeCatalogID, params, nil), http.StatusOK)
	if hits := fake.hits(); hits != 2 {
		t.Fatalf("refreshed cache should serve memory, hits = %d", hits)
	}
}

func TestCatalogServesStaleWithinWindow(t *testing.T) {
	clock := newTestClock(baseTestTime())
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		if call == 1 {
			writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), map[string]string{"ETag": `"v1"`})
			return
		}
		writeUpstreamJSON(t, w, http.StatusInternalServerError, map[string]any{"code": "boom"}, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.store.now = clock.now

	params := map[string]string{"channel": channelStable}
	first := assertJSONDocument(t, invokeRoute(t, server, routeCatalogID, params, nil), schemaCatalogResponse)

	clock.advance(11 * time.Minute)
	response := invokeRoute(t, server, routeCatalogID, params, nil)
	assertStatus(t, response, http.StatusOK)
	stale := assertJSONDocument(t, response, schemaCatalogResponse)

	if got := stale["stale"]; got != true {
		t.Fatalf("stale = %v, want true", got)
	}
	// stale 响应的 fetchedAt 必须是原始抓取时间，不是「现在」。
	assertFetchedAt(t, stale, baseTestTime())
	if !reflect.DeepEqual(first["items"], stale["items"]) {
		t.Fatalf("stale body differs from cached body")
	}
}

func TestCatalogFailsAfterStaleWindow(t *testing.T) {
	clock := newTestClock(baseTestTime())
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		if call == 1 {
			writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
			return
		}
		writeUpstreamJSON(t, w, http.StatusInternalServerError, map[string]any{"code": "boom"}, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.store.now = clock.now

	params := map[string]string{"channel": channelStable}
	assertStatus(t, invokeRoute(t, server, routeCatalogID, params, nil), http.StatusOK)

	clock.advance(25 * time.Hour)
	assertError(t, invokeRoute(t, server, routeCatalogID, params, nil), http.StatusBadGateway, codeUpstreamError)
}

func TestProductNotFoundDoesNotServeStale(t *testing.T) {
	clock := newTestClock(baseTestTime())
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		if call == 1 {
			writeUpstreamJSON(t, w, http.StatusOK, productFixture(), nil)
			return
		}
		writeUpstreamJSON(t, w, http.StatusNotFound, map[string]any{"code": "product_not_found"}, nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.store.now = clock.now

	params := map[string]string{"slug": "demo-plugin"}
	assertStatus(t, invokeRoute(t, server, routeProductID, params, nil), http.StatusOK)

	// 404 是确定性答案：即使缓存还在 stale 窗口内也必须报 404，不能拿旧数据冒充。
	clock.advance(11 * time.Minute)
	assertError(t, invokeRoute(t, server, routeProductID, params, nil), http.StatusNotFound, codeProductNotFound)
}

func TestCatalogCachesPerQueryKey(t *testing.T) {
	clock := newTestClock(baseTestTime())
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.store.now = clock.now

	assertStatus(t, invokeRoute(t, server, routeCatalogID, map[string]string{"channel": channelStable}, nil), http.StatusOK)
	assertStatus(t, invokeRoute(t, server, routeCatalogID, map[string]string{"channel": channelBeta}, nil), http.StatusOK)
	if hits := fake.hits(); hits != 2 {
		t.Fatalf("different filters must not share a cache entry, hits = %d", hits)
	}
	server.store.mu.Lock()
	entries := len(server.store.entries)
	server.store.mu.Unlock()
	if entries != 2 {
		t.Fatalf("cache entries = %d, want 2", entries)
	}
}

func TestNotModifiedWithoutCacheIsUpstreamFailure(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		w.WriteHeader(http.StatusNotModified)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	assertError(t, invokeRoute(t, server, routeCatalogID, nil, nil), http.StatusBadGateway, codeUpstreamError)
}

func TestInstallURLIsNeverCached(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, downloadURLFixture(), map[string]string{"ETag": `"v1"`})
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	body := map[string]any{"slug": "demo-plugin", "os": "linux", "arch": "amd64"}
	for attempt := 0; attempt < 2; attempt++ {
		assertStatus(t, invokeRoute(t, server, routeInstallURLID, nil, body), http.StatusOK)
	}

	if hits := fake.hits(); hits != 2 {
		t.Fatalf("install-url must not be cached, hits = %d", hits)
	}
	for _, call := range fake.calls() {
		if call.Header.Get("If-None-Match") != "" {
			t.Fatalf("install-url must never send If-None-Match")
		}
	}
	server.store.mu.Lock()
	entries := len(server.store.entries)
	server.store.mu.Unlock()
	if entries != 0 {
		t.Fatalf("install-url wrote %d cache entries", entries)
	}
}

func TestCatalogTimeoutIsUpstreamFailure(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		time.Sleep(200 * time.Millisecond)
		writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), nil)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	client := newStoreHTTPClient()
	client.Transport = fake.client(t).Transport
	client.Timeout = 40 * time.Millisecond
	server.store.http = client

	assertError(t, invokeRoute(t, server, routeCatalogID, nil, nil), http.StatusBadGateway, codeUpstreamError)
}

func TestCatalogOversizedResponseIsRejected(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"items":[],"total":0,"pad":"`)
		_, _ = io.WriteString(w, strings.Repeat("a", upstreamMaxBodyBytes))
		_, _ = io.WriteString(w, `"}`)
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})

	assertError(t, invokeRoute(t, server, routeCatalogID, nil, nil), http.StatusBadGateway, codeUpstreamError)
	server.store.mu.Lock()
	entries := len(server.store.entries)
	server.store.mu.Unlock()
	if entries != 0 {
		t.Fatalf("oversized response must not be cached, entries = %d", entries)
	}
}

func TestCatalogConcurrentInvocations(t *testing.T) {
	clock := newTestClock(baseTestTime())
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, catalogFixture(), map[string]string{"ETag": `"v1"`})
	})
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
	server.store.now = clock.now

	const workers = 16
	const perWorker = 4
	var waitGroup sync.WaitGroup
	failures := make(chan error, workers*perWorker)
	for worker := 0; worker < workers; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for attempt := 0; attempt < perWorker; attempt++ {
				request := &pluginwire.RouteRequest{
					RouteId:         routeCatalogID,
					QueryParameters: map[string]string{"channel": channelStable},
				}
				response, err := server.InvokeRoute(context.Background(), request)
				if err != nil {
					failures <- err
					return
				}
				if got := int(response.GetStatusCode()); got != http.StatusOK {
					failures <- fmt.Errorf("status = %d", got)
					return
				}
			}
		}()
	}
	waitGroup.Wait()
	close(failures)
	for failure := range failures {
		t.Fatalf("concurrent invocation failed: %v", failure)
	}
	if hits := fake.hits(); hits < 1 {
		t.Fatalf("upstream hits = %d, want at least one fetch", hits)
	}
}

// TestCatalogQueryValuesKeepUnknownHostVersionOut 是转发规则的单元测试：宿主版本
// 未知时 sforum/sforumBuild 一律不出现，已知时原样出现在查询里。
func TestCatalogQueryValuesKeepUnknownHostVersionOut(t *testing.T) {
	known := catalogQuery{
		Channel: channelStable, Limit: 18, Compat: compatModeCompatible,
		SForum: "3.0.16", SForumBuild: "dev-abc12",
	}
	values := known.values()
	if got := values.Get("sforum"); got != "3.0.16" {
		t.Errorf("sforum = %q, want 3.0.16", got)
	}
	if got := values.Get("sforumBuild"); got != "dev-abc12" {
		t.Errorf("sforumBuild = %q, want dev-abc12", got)
	}
	if got := values.Get("compat"); got != compatModeCompatible {
		t.Errorf("compat = %q, want compatible", got)
	}

	unknown := catalogQuery{Channel: channelStable, Limit: 18, Compat: compatModeAll}
	values = unknown.values()
	for _, key := range []string{"sforum", "sforumBuild"} {
		if values.Has(key) {
			t.Errorf("unknown host version must not send %s: %v", key, values)
		}
	}
	if got := values.Get("compat"); got != compatModeAll {
		t.Errorf("compat = %q, want all", got)
	}
}

// TestProductCacheIsKeyedByHostVersion：上游按宿主版本求值约束，缓存必须把版本
// 算进键里，否则一台宿主的结论会被另一台读到。
func TestProductCacheIsKeyedByHostVersion(t *testing.T) {
	fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, call int) {
		writeUpstreamJSON(t, w, http.StatusOK, productFixture(), nil)
	})
	params := map[string]string{"slug": "demo-plugin"}

	newServer := func(coreVersion string) *storeServer {
		server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable})
		stubHostBuild(server, coreVersion, "dev")
		return server
	}
	assertStatus(t, invokeRoute(t, newServer("3.0.16"), routeProductID, params, nil), http.StatusOK)
	assertStatus(t, invokeRoute(t, newServer("3.0.17"), routeProductID, params, nil), http.StatusOK)

	if hits := fake.hits(); hits != 2 {
		t.Fatalf("different host versions must not share a cache entry, hits = %d", hits)
	}
	calls := fake.calls()
	if got := calls[0].Query.Get("sforum"); got != "3.0.16" {
		t.Errorf("first sforum = %q, want 3.0.16", got)
	}
	if got := calls[1].Query.Get("sforum"); got != "3.0.17" {
		t.Errorf("second sforum = %q, want 3.0.17", got)
	}
}

package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	pluginv2 "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2"
	pluginwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/plugin/v2"
	protocolwire "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2/gen/sforum/protocol/v2"
)

// 连接商城的插件侧：PKCE、状态机、secret 写入、401 语义。
//
// 上游用 httptest 假商城（newFakeUpstream），宿主 secret 用 secretStore 测试缝，
// 因此这里不需要 go-plugin 运行时，也不会碰到任何真实凭据。

// fakeSecret 记录插件写了什么，并按需失败。
type fakeSecret struct {
	mu        sync.Mutex
	value     string
	puts      int
	clears    int
	failPut   bool
	failClear bool
}

func (f *fakeSecret) put(_ context.Context, credential accountCredential) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.puts++
	if f.failPut {
		return errors.New("secret put failed")
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	f.value = string(encoded)
	return nil
}

func (f *fakeSecret) clear(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clears++
	if f.failClear {
		return errors.New("secret clear failed")
	}
	f.value = ""
	return nil
}

func (f *fakeSecret) stored() accountCredential {
	f.mu.Lock()
	defer f.mu.Unlock()
	credential, _ := parseAccountCredential(f.value)
	return credential
}

// authServer 组装一台「已配置商城地址 + 假上游 + 假 secret」的服务。
func authServer(t *testing.T, fake *fakeUpstream, secret *fakeSecret, token string) *storeServer {
	t.Helper()
	server := newBoundStoreServer(t, fake, storeSettings{Channel: channelStable, AccountToken: token})
	server.secretOverride = secret
	return server
}

func invokeAuthPoll(t *testing.T, server *storeServer, requestID string) *pluginwire.RouteResponse {
	t.Helper()
	document, err := pluginv2.NewTypedDocument(schemaAuthPollRequest, map[string]any{"requestId": requestID})
	if err != nil {
		t.Fatalf("build request document: %v", err)
	}
	response, err := server.InvokeRoute(context.Background(), &pluginwire.RouteRequest{
		RouteId: routeAuthPollID,
		Body:    document,
	})
	if err != nil {
		t.Fatalf("invoke poll: %v", err)
	}
	return response
}

func TestPKCEPair(t *testing.T) {
	verifier, err := newCodeVerifier()
	if err != nil {
		t.Fatal(err)
	}
	if len(verifier) != 43 {
		t.Fatalf("verifier length = %d, want 43", len(verifier))
	}
	if strings.ContainsAny(verifier, "+/=") {
		t.Fatalf("verifier is not base64url: %q", verifier)
	}

	sum := sha256.Sum256([]byte(verifier))
	want := base64.RawURLEncoding.EncodeToString(sum[:])
	if got := challengeFor(verifier); got != want {
		t.Fatalf("challenge = %q, want %q", got, want)
	}
	if challengeFor(verifier) == verifier {
		t.Fatal("challenge must not equal the verifier")
	}

	second, err := newCodeVerifier()
	if err != nil {
		t.Fatal(err)
	}
	if second == verifier {
		t.Fatal("two verifiers collided")
	}
}

func TestAuthStatusModes(t *testing.T) {
	t.Run("anonymous store", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, _ int) {
			if r.URL.Path != upstreamAuthModePath {
				t.Errorf("unexpected path %s", r.URL.Path)
			}
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"mode": "anonymous", "token_ttl_seconds": 2592000}, nil)
		})
		server := authServer(t, fake, &fakeSecret{}, "")

		values := assertJSONDocument(t, invokeRoute(t, server, routeAuthStatusID, nil, nil), schemaAuthStatusResponse)
		if values["mode"] != authModeAnonymous {
			t.Fatalf("mode = %v", values["mode"])
		}
		if values["connected"] != false {
			t.Fatalf("connected = %v", values["connected"])
		}
	})

	t.Run("account_required with a live credential", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"mode": "account_required"}, nil)
		})
		token := credentialJSON(t, "sfo_"+strings.Repeat("a", 43), time.Now().Add(time.Hour), "ada")
		server := authServer(t, fake, &fakeSecret{}, token)

		values := assertJSONDocument(t, invokeRoute(t, server, routeAuthStatusID, nil, nil), schemaAuthStatusResponse)
		if values["mode"] != authModeAccountRequired || values["connected"] != true {
			t.Fatalf("status = %#v", values)
		}
		account, _ := values["account"].(map[string]any)
		if account["username"] != "ada" {
			t.Fatalf("account = %#v", account)
		}
	})

	t.Run("an expired credential reads as not connected", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"mode": "account_required"}, nil)
		})
		token := credentialJSON(t, "sfo_"+strings.Repeat("b", 43), time.Now().Add(-time.Minute), "ada")
		server := authServer(t, fake, &fakeSecret{}, token)

		values := assertJSONDocument(t, invokeRoute(t, server, routeAuthStatusID, nil, nil), schemaAuthStatusResponse)
		if values["connected"] != false {
			t.Fatalf("expired credential counted as connected: %#v", values)
		}
	})

	t.Run("a store without the auth routes is unsupported", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
			w.WriteHeader(http.StatusNotFound)
		})
		server := authServer(t, fake, &fakeSecret{}, "")

		values := assertJSONDocument(t, invokeRoute(t, server, routeAuthStatusID, nil, nil), schemaAuthStatusResponse)
		if values["mode"] != authModeUnsupported {
			t.Fatalf("mode = %v", values["mode"])
		}
	})

	t.Run("an unconfigured store says so", func(t *testing.T) {
		server := newTestStoreServer(t, storeSettings{})
		assertErrorFor(t, invokeRoute(t, server, routeAuthStatusID, nil, nil), schemaAuthStatusResponse, http.StatusServiceUnavailable, codeNotConfigured)
	})
}

func TestAuthStart(t *testing.T) {
	t.Run("returns the authorize url and keeps the verifier", func(t *testing.T) {
		var fake *fakeUpstream
		fake = newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, _ int) {
			switch r.URL.Path {
			case upstreamAuthModePath:
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"mode": "account_required"}, nil)
			case upstreamAuthRequestsPath:
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{
					"id":            "11111111-1111-4111-8111-111111111111",
					"authorize_url": fake.baseURL() + "/connect/11111111-1111-4111-8111-111111111111",
					"expires_in":    300,
					"interval":      2,
				}, nil)
			default:
				t.Errorf("unexpected path %s", r.URL.Path)
			}
		})
		server := authServer(t, fake, &fakeSecret{}, "")

		values := assertJSONDocument(t, invokeRoute(t, server, routeAuthStartID, nil, nil), schemaAuthStartResponse)
		if values["requestId"] != "11111111-1111-4111-8111-111111111111" {
			t.Fatalf("requestId = %v", values["requestId"])
		}
		if values["interval"] != float64(2) && values["interval"] != 2 {
			t.Fatalf("interval = %v", values["interval"])
		}
		// 插件交给商城的 challenge 必须是 43 字符 base64url，且 verifier 不在响应里。
		var challenge string
		for _, call := range fake.calls() {
			if call.Path != upstreamAuthRequestsPath {
				continue
			}
			var body map[string]any
			if err := json.Unmarshal(call.Body, &body); err != nil {
				t.Fatalf("decode create body: %v", err)
			}
			challenge, _ = body["code_challenge"].(string)
		}
		if len(challenge) != 43 {
			t.Fatalf("challenge = %q", challenge)
		}
		for _, value := range values {
			if text, ok := value.(string); ok && text == challenge {
				t.Fatal("challenge leaked into the response")
			}
		}
	})

	t.Run("refuses an authorize url on another origin", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, _ int) {
			if r.URL.Path == upstreamAuthModePath {
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"mode": "account_required"}, nil)
				return
			}
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{
				"id":            "22222222-2222-4222-8222-222222222222",
				"authorize_url": "https://evil.example/connect/22222222-2222-4222-8222-222222222222",
				"expires_in":    300,
				"interval":      2,
			}, nil)
		})
		server := authServer(t, fake, &fakeSecret{}, "")
		assertErrorFor(t, invokeRoute(t, server, routeAuthStartID, nil, nil), schemaAuthStartResponse, http.StatusBadGateway, codeUpstreamError)
	})

	t.Run("anonymous mode has nothing to connect", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"mode": "anonymous"}, nil)
		})
		server := authServer(t, fake, &fakeSecret{}, "")
		assertErrorFor(t, invokeRoute(t, server, routeAuthStartID, nil, nil), schemaAuthStartResponse, http.StatusConflict, codeAuthNotRequired)
	})

	t.Run("an old store is unsupported", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
			w.WriteHeader(http.StatusNotFound)
		})
		server := authServer(t, fake, &fakeSecret{}, "")
		assertErrorFor(t, invokeRoute(t, server, routeAuthStartID, nil, nil), schemaAuthStartResponse, http.StatusServiceUnavailable, codeAuthUnsupported)
	})
}

func TestAuthPoll(t *testing.T) {
	const requestID = "33333333-3333-4333-8333-333333333333"

	// startAuth 走一遍 start，让 pending 里有 verifier。
	startAuth := func(t *testing.T, fake *fakeUpstream, secret *fakeSecret) *storeServer {
		t.Helper()
		server := authServer(t, fake, secret, "")
		assertJSONDocument(t, invokeRoute(t, server, routeAuthStartID, nil, nil), schemaAuthStartResponse)
		return server
	}

	handler := func(status string, exchange func(w http.ResponseWriter), base func() string) func(w http.ResponseWriter, r *http.Request, _ int) {
		return func(w http.ResponseWriter, r *http.Request, _ int) {
			switch {
			case r.URL.Path == upstreamAuthModePath:
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"mode": "account_required"}, nil)
			case r.URL.Path == upstreamAuthRequestsPath:
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{
					"id":            requestID,
					"authorize_url": base() + "/connect/" + requestID,
					"expires_in":    300,
					"interval":      2,
				}, nil)
			case strings.HasSuffix(r.URL.Path, "/token"):
				exchange(w)
			default:
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"status": status}, nil)
			}
		}
	}

	t.Run("pending stays pending", func(t *testing.T) {
		var fake *fakeUpstream
		fake = newFakeUpstream(t, handler(authStatusPending, func(w http.ResponseWriter) {
			t.Error("exchange must not be called while pending")
		}, func() string { return fake.baseURL() }))
		server := startAuth(t, fake, &fakeSecret{})
		values := assertJSONDocument(t, invokeAuthPoll(t, server, requestID), schemaAuthPollResponse)
		if values["status"] != authStatusPending {
			t.Fatalf("status = %v", values["status"])
		}
	})

	t.Run("approved exchanges, writes the secret and reports the account", func(t *testing.T) {
		secret := &fakeSecret{}
		var fake *fakeUpstream
		fake = newFakeUpstream(t, handler(authStatusApproved, func(w http.ResponseWriter) {
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{
				"access_token": "sfo_" + strings.Repeat("c", 43),
				"token_type":   "Bearer",
				"expires_in":   2592000,
				"expires_at":   time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339),
				"scope":        "download:issue",
				"account": map[string]any{
					"id": "acc-1", "issuerKey": "forum", "username": "ada",
					"displayName": "Ada", "avatarUrl": "",
				},
			}, nil)
		}, func() string { return fake.baseURL() }))
		server := startAuth(t, fake, secret)

		values := assertJSONDocument(t, invokeAuthPoll(t, server, requestID), schemaAuthPollResponse)
		if values["status"] != authStatusConnected {
			t.Fatalf("status = %v", values["status"])
		}
		account, _ := values["account"].(map[string]any)
		if account["username"] != "ada" {
			t.Fatalf("account = %#v", account)
		}
		stored := secret.stored()
		if stored.Token != "sfo_"+strings.Repeat("c", 43) {
			t.Fatalf("secret = %#v", stored)
		}
		// 响应里不能出现令牌本身。
		encoded, _ := json.Marshal(values)
		if strings.Contains(string(encoded), stored.Token) {
			t.Fatal("token leaked into the poll response")
		}
		// 写完之后缓存必须失效：下一次 settings 读取要回 Host。
		server.settingsCache.mu.RLock()
		fetchedAt := server.settingsCache.fetchedAt
		server.settingsCache.mu.RUnlock()
		if !fetchedAt.IsZero() {
			t.Fatal("settings cache was not invalidated after the secret write")
		}
	})

	t.Run("denied and expired are terminal", func(t *testing.T) {
		for _, status := range []string{authStatusDenied, authStatusExpired, authStatusConsumed} {
			var fake *fakeUpstream
			fake = newFakeUpstream(t, handler(status, func(w http.ResponseWriter) {
				t.Errorf("exchange must not run for %s", status)
			}, func() string { return fake.baseURL() }))
			server := startAuth(t, fake, &fakeSecret{})
			values := assertJSONDocument(t, invokeAuthPoll(t, server, requestID), schemaAuthPollResponse)
			if values["status"] != status {
				t.Fatalf("status = %v, want %s", values["status"], status)
			}
			// pending 已被清掉：再轮询就是 request_unknown。
			assertErrorFor(t, invokeAuthPoll(t, server, requestID), schemaAuthPollResponse, http.StatusNotFound, codeRequestUnknown)
		}
	})

	t.Run("a secret write failure revokes the fresh token", func(t *testing.T) {
		secret := &fakeSecret{failPut: true}
		var revoked bool
		var fake *fakeUpstream
		fake = newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, _ int) {
			switch {
			case r.URL.Path == upstreamAuthModePath:
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"mode": "account_required"}, nil)
			case r.URL.Path == upstreamAuthRequestsPath:
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{
					"id":            requestID,
					"authorize_url": fake.baseURL() + "/connect/" + requestID,
					"expires_in":    300,
					"interval":      2,
				}, nil)
			case r.URL.Path == upstreamAuthRevokePath:
				revoked = true
				w.WriteHeader(http.StatusNoContent)
			case strings.HasSuffix(r.URL.Path, "/token"):
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{
					"access_token": "sfo_" + strings.Repeat("d", 43),
					"token_type":   "Bearer",
					"expires_in":   2592000,
					"expires_at":   time.Now().Add(time.Hour).UTC().Format(time.RFC3339),
					"scope":        "download:issue",
					"account":      map[string]any{"id": "acc-1", "issuerKey": "forum", "username": "ada", "displayName": "Ada", "avatarUrl": ""},
				}, nil)
			default:
				writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"status": authStatusApproved}, nil)
			}
		})
		server := startAuth(t, fake, secret)
		assertErrorFor(t, invokeAuthPoll(t, server, requestID), schemaAuthPollResponse, http.StatusBadGateway, codeSecretWriteFailed)
		if !revoked {
			t.Fatal("a token that could not be stored must be revoked upstream")
		}
	})

	t.Run("an unknown request id is a clean miss", func(t *testing.T) {
		var fake *fakeUpstream
		fake = newFakeUpstream(t, handler(authStatusPending, func(http.ResponseWriter) {}, func() string { return fake.baseURL() }))
		server := authServer(t, fake, &fakeSecret{}, "")
		assertErrorFor(t, invokeAuthPoll(t, server, "99999999-9999-4999-8999-999999999999"), schemaAuthPollResponse, http.StatusNotFound, codeRequestUnknown)
	})
}

func TestAuthDisconnect(t *testing.T) {
	t.Run("revokes upstream and clears the secret", func(t *testing.T) {
		var revoked bool
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, _ int) {
			if r.URL.Path == upstreamAuthRevokePath {
				if r.Header.Get("Authorization") != "Bearer sfo_"+strings.Repeat("e", 43) {
					t.Errorf("revoke without bearer: %q", r.Header.Get("Authorization"))
				}
				revoked = true
				w.WriteHeader(http.StatusNoContent)
				return
			}
			t.Errorf("unexpected path %s", r.URL.Path)
		})
		secret := &fakeSecret{}
		token := credentialJSON(t, "sfo_"+strings.Repeat("e", 43), time.Now().Add(time.Hour), "ada")
		server := authServer(t, fake, secret, token)

		values := assertJSONDocument(t, invokeRoute(t, server, routeAuthDisconnectID, nil, nil), schemaAuthDisconnectResponse)
		if values["connected"] != false || values["revoked"] != true {
			t.Fatalf("disconnect = %#v", values)
		}
		if !revoked || secret.stored().Token != "" {
			t.Fatalf("revoked=%t stored=%#v", revoked, secret.stored())
		}
	})

	t.Run("an upstream failure still disconnects locally", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
			w.WriteHeader(http.StatusInternalServerError)
		})
		secret := &fakeSecret{}
		token := credentialJSON(t, "sfo_"+strings.Repeat("f", 43), time.Now().Add(time.Hour), "ada")
		server := authServer(t, fake, secret, token)

		values := assertJSONDocument(t, invokeRoute(t, server, routeAuthDisconnectID, nil, nil), schemaAuthDisconnectResponse)
		if values["connected"] != false || values["revoked"] != false {
			t.Fatalf("disconnect = %#v", values)
		}
		if secret.stored().Token != "" {
			t.Fatal("local credential survived a disconnect")
		}
	})

	t.Run("a clear failure is reported", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
			w.WriteHeader(http.StatusNoContent)
		})
		secret := &fakeSecret{failClear: true}
		token := credentialJSON(t, "sfo_"+strings.Repeat("g", 43), time.Now().Add(time.Hour), "ada")
		server := authServer(t, fake, secret, token)
		assertErrorFor(t, invokeRoute(t, server, routeAuthDisconnectID, nil, nil), schemaAuthDisconnectResponse, http.StatusBadGateway, codeSecretWriteFailed)
	})
}

func TestInstallURLUsesTheAccountToken(t *testing.T) {
	const token = "sfo_" + "0123456789012345678901234567890123456789012"

	t.Run("sends the bearer when connected", func(t *testing.T) {
		var seen string
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, _ int) {
			seen = r.Header.Get("Authorization")
			writeUpstreamJSON(t, w, http.StatusOK, downloadURLFixture(), nil)
		})
		credential := credentialJSON(t, token, time.Now().Add(time.Hour), "ada")
		server := authServer(t, fake, &fakeSecret{}, credential)

		assertJSONDocument(t, invokeRoute(t, server, routeInstallURLID, nil, map[string]any{
			"slug": "markdown-plus", "os": "linux", "arch": "amd64",
		}), schemaInstallURLResponse)
		if seen != "Bearer "+token {
			t.Fatalf("authorization = %q", seen)
		}
	})

	t.Run("a 401 clears the secret and asks the page to connect", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
			w.WriteHeader(http.StatusUnauthorized)
		})
		secret := &fakeSecret{}
		credential := credentialJSON(t, token, time.Now().Add(time.Hour), "ada")
		server := authServer(t, fake, secret, credential)

		assertErrorFor(t, invokeRoute(t, server, routeInstallURLID, nil, map[string]any{
			"slug": "markdown-plus", "os": "linux", "arch": "amd64",
		}), schemaInstallURLResponse, http.StatusUnauthorized, codeLoginRequired)
		if secret.clears == 0 {
			t.Fatal("a rejected token must be cleared locally")
		}
	})

	t.Run("an already expired credential never reaches the store", func(t *testing.T) {
		fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
			t.Error("store must not be called with an expired credential")
		})
		secret := &fakeSecret{}
		credential := credentialJSON(t, token, time.Now().Add(-time.Minute), "ada")
		server := authServer(t, fake, secret, credential)

		assertErrorFor(t, invokeRoute(t, server, routeInstallURLID, nil, map[string]any{
			"slug": "markdown-plus", "os": "linux", "arch": "amd64",
		}), schemaInstallURLResponse, http.StatusUnauthorized, codeLoginRequired)
		if secret.clears == 0 {
			t.Fatal("expired credential must be cleared")
		}
	})

	t.Run("not connected still installs anonymously", func(t *testing.T) {
		var seen string
		fake := newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, _ int) {
			seen = r.Header.Get("Authorization")
			writeUpstreamJSON(t, w, http.StatusOK, downloadURLFixture(), nil)
		})
		server := authServer(t, fake, &fakeSecret{}, "")
		assertJSONDocument(t, invokeRoute(t, server, routeInstallURLID, nil, map[string]any{
			"slug": "markdown-plus", "os": "linux", "arch": "amd64",
		}), schemaInstallURLResponse)
		if seen != "" {
			t.Fatalf("anonymous install sent an authorization header: %q", seen)
		}
	})
}

func TestAuthRoutesAreNotLeakingTheTokenIntoErrors(t *testing.T) {
	// 上游 500：错误响应与日志里都不该出现令牌或商城地址。
	token := "sfo_" + strings.Repeat("h", 43)
	fake := newFakeUpstream(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	secret := &fakeSecret{}
	credential := credentialJSON(t, token, time.Now().Add(time.Hour), "ada")
	server := authServer(t, fake, secret, credential)

	response := invokeRoute(t, server, routeInstallURLID, nil, map[string]any{
		"slug": "markdown-plus", "os": "linux", "arch": "amd64",
	})
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	if strings.Contains(body, token) {
		t.Fatal("token leaked into a failure response")
	}
	if strings.Contains(body, fake.baseURL()) {
		t.Fatal("upstream base url leaked into a failure response")
	}
}

func TestAuthFlowKeepsTheTokenOutOfLogs(t *testing.T) {
	// 令牌是长期 bearer：日志里出现一次就等于泄露。整条流程（含兑换与写入）
	// 只允许写路由 id 与账号 id。
	const requestID = "44444444-4444-4444-8444-444444444444"
	token := "sfo_" + strings.Repeat("i", 43)

	var buffer strings.Builder
	previous := log.Writer()
	log.SetOutput(&buffer)
	t.Cleanup(func() { log.SetOutput(previous) })

	var fake *fakeUpstream
	fake = newFakeUpstream(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		switch {
		case r.URL.Path == upstreamAuthModePath:
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"mode": "account_required"}, nil)
		case r.URL.Path == upstreamAuthRequestsPath:
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{
				"id":            requestID,
				"authorize_url": fake.baseURL() + "/connect/" + requestID,
				"expires_in":    300,
				"interval":      2,
			}, nil)
		case strings.HasSuffix(r.URL.Path, "/token"):
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{
				"access_token": token,
				"token_type":   "Bearer",
				"expires_in":   2592000,
				"expires_at":   time.Now().Add(30 * 24 * time.Hour).UTC().Format(time.RFC3339),
				"scope":        "download:issue",
				"account":      map[string]any{"id": "acc-1", "issuerKey": "forum", "username": "ada", "displayName": "Ada", "avatarUrl": ""},
			}, nil)
		default:
			writeUpstreamJSON(t, w, http.StatusOK, map[string]any{"status": authStatusApproved}, nil)
		}
	})
	secret := &fakeSecret{}
	server := authServer(t, fake, secret, "")
	assertJSONDocument(t, invokeRoute(t, server, routeAuthStartID, nil, nil), schemaAuthStartResponse)
	polled := assertJSONDocument(t, invokeAuthPoll(t, server, requestID), schemaAuthPollResponse)
	if polled["status"] != authStatusConnected {
		t.Fatalf("poll did not connect: %#v", polled)
	}

	logged := buffer.String()
	if logged == "" {
		t.Fatal("expected the flow to log something, so the assertion is meaningful")
	}
	if strings.Contains(logged, token) {
		t.Fatalf("token leaked into logs: %s", logged)
	}
	if strings.Contains(logged, fake.baseURL()) {
		t.Fatalf("upstream base url leaked into logs: %s", logged)
	}
	if secret.stored().Token != token {
		t.Fatal("the token must land in the host secret, not in the logs")
	}
}

// credentialJSON 造一份 secret 设置里的凭据 JSON。
func credentialJSON(t *testing.T, token string, expiry time.Time, username string) string {
	t.Helper()
	encoded, err := json.Marshal(accountCredential{
		Token:     token,
		ExpiresAt: expiry.UTC().Format(time.RFC3339),
		Account: authAccount{
			ID: "acc-1", IssuerKey: "forum", Username: username,
			DisplayName: strings.ToUpper(username[:1]) + username[1:], AvatarURL: "",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

var _ = protocolwire.RequestContext{}

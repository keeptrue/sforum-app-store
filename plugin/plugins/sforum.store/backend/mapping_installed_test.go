package main

import "testing"

// updateAvailable 只在两端都能被 semver 解析时给结论：清单里的版本可能是 dev
// 标签或历史写法，解析失败保持 false；等值不算可升级。
func TestUpdateAvailable(t *testing.T) {
	cases := []struct {
		name      string
		installed string
		latest    string
		want      bool
	}{
		{name: "older installed", installed: "1.2.0", latest: "2.0.0", want: true},
		{name: "numeric compare instead of lexical", installed: "1.9.0", latest: "1.10.0", want: true},
		{name: "v prefix is tolerated", installed: "v1.2.0", latest: "1.3.0", want: true},
		{name: "prerelease sorts below its release", installed: "2.0.0-rc.1", latest: "2.0.0", want: true},
		{name: "equal versions", installed: "1.2.0", latest: "1.2.0", want: false},
		{name: "installed is newer", installed: "2.0.0", latest: "1.9.9", want: false},
		{name: "unparseable installed", installed: "dev-abc12", latest: "1.2.0", want: false},
		{name: "unparseable latest", installed: "1.2.0", latest: "nightly", want: false},
		{name: "both empty", installed: "", latest: "", want: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := updateAvailable(testCase.installed, testCase.latest); got != testCase.want {
				t.Fatalf("updateAvailable(%q, %q) = %v, want %v",
					testCase.installed, testCase.latest, got, testCase.want)
			}
		})
	}
}

// installedValues 未知一律 null；已知只透出契约要求的两项。
func TestInstalledValues(t *testing.T) {
	if got := installedValues(installedExtension{Version: "1.2.0", Status: "enabled"}, false); got != nil {
		t.Fatalf("unknown installed = %v, want nil", got)
	}

	got, ok := installedValues(installedExtension{Version: "1.2.0", Status: "enabled"}, true).(map[string]any)
	if !ok {
		t.Fatalf("known installed is not an object")
	}
	if len(got) != 2 {
		t.Fatalf("installed keys = %v, want exactly version and status", got)
	}
	if got["version"] != "1.2.0" || got["status"] != "enabled" {
		t.Fatalf("installed = %v", got)
	}
}

// installedRelation 把「选中版本相对已装版本的位置」算成四个稳定值。它是安装门禁的唯一
// 依据：页面不再自己比版本，所以这里必须覆盖等值、升降、预发布与不可解析两种情况。
func TestInstalledRelation(t *testing.T) {
	cases := []struct {
		name      string
		installed string
		known     bool
		release   string
		want      string
	}{
		{name: "no inventory row means no verdict", installed: "", known: false, release: "1.0.0", want: ""},
		{name: "release above installed", installed: "1.5.0", known: true, release: "2.0.0", want: relationNewer},
		{name: "numeric not lexical", installed: "1.9.0", known: true, release: "1.10.0", want: relationNewer},
		{name: "same version", installed: "1.5.0", known: true, release: "1.5.0", want: relationSame},
		{name: "v prefix is tolerated", installed: "v1.5.0", known: true, release: "1.5.0", want: relationSame},
		{name: "release below installed", installed: "2.0.0", known: true, release: "1.5.0", want: relationOlder},
		{name: "prerelease below its release", installed: "2.0.0-rc.1", known: true, release: "2.0.0", want: relationNewer},
		{name: "unparseable installed", installed: "dev-abc12", known: true, release: "1.5.0", want: relationUnknown},
		{name: "unparseable release", installed: "1.5.0", known: true, release: "nightly", want: relationUnknown},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := installedRelation(testCase.installed, testCase.known, testCase.release)
			if got != testCase.want {
				t.Fatalf("installedRelation(%q, %v, %q) = %q, want %q",
					testCase.installed, testCase.known, testCase.release, got, testCase.want)
			}
		})
	}
}

// authorValues 只发真实存在的那一半，绝不用另一半的名字填空；链接与头像地址由插件
// 重新拼/校验，不直接透传上游整串。
func TestAuthorValues(t *testing.T) {
	username := "ada"
	displayName := "Ada Lovelace"
	avatar := "https://forum.example/avatars/ada.png"
	profile := "https://forum.example/u/ada"

	t.Run("both halves", func(t *testing.T) {
		got, ok := authorValues(&upstreamAuthor{
			Username:    &username,
			DisplayName: &displayName,
			AvatarURL:   &avatar,
			ProfileURL:  &profile,
			Github:      &upstreamGithub{Login: "acme", URL: "https://evil.example/steal"},
		}).(map[string]any)
		if !ok {
			t.Fatalf("author is not an object")
		}
		if got["username"] != "ada" || got["displayName"] != "Ada Lovelace" || got["avatarUrl"] != avatar {
			t.Fatalf("author forum half = %v", got)
		}
		if got["profileUrl"] != profile {
			t.Fatalf("author profileUrl = %v", got["profileUrl"])
		}
		// The upstream URL is ignored: the only legal address is built from the login.
		github, ok := got["github"].(map[string]any)
		if !ok || github["login"] != "acme" || github["url"] != "https://github.com/acme" {
			t.Fatalf("author github half = %v", got["github"])
		}
	})

	t.Run("repository only", func(t *testing.T) {
		got, ok := authorValues(&upstreamAuthor{Github: &upstreamGithub{Login: "acme"}}).(map[string]any)
		if !ok {
			t.Fatalf("author is not an object")
		}
		if got["username"] != nil || got["displayName"] != nil || got["avatarUrl"] != nil {
			t.Fatalf("forum half must stay absent: %v", got)
		}
		if github, _ := got["github"].(map[string]any); github == nil || github["login"] != "acme" {
			t.Fatalf("github half = %v", got["github"])
		}
	})

	t.Run("forum account only", func(t *testing.T) {
		got, ok := authorValues(&upstreamAuthor{Username: &username}).(map[string]any)
		if !ok {
			t.Fatalf("author is not an object")
		}
		if got["github"] != nil {
			t.Fatalf("github half must stay absent: %v", got["github"])
		}
	})

	t.Run("nothing at all", func(t *testing.T) {
		if got := authorValues(nil); got != nil {
			t.Fatalf("author = %v, want nil", got)
		}
		if got := authorValues(&upstreamAuthor{}); got != nil {
			t.Fatalf("author = %v, want nil", got)
		}
	})

	t.Run("hostile fields are dropped", func(t *testing.T) {
		// A login that would change the link target, and an avatar with a non-http scheme.
		evil := "acme/../../evil"
		script := "javascript:alert(1)"
		got, ok := authorValues(&upstreamAuthor{
			Username:   &username,
			AvatarURL:  &script,
			ProfileURL: &script,
			Github:     &upstreamGithub{Login: evil},
		}).(map[string]any)
		if !ok {
			t.Fatalf("author is not an object")
		}
		if got["github"] != nil {
			t.Fatalf("illegal login must be dropped: %v", got["github"])
		}
		if got["avatarUrl"] != nil {
			t.Fatalf("non-http avatar must be dropped: %v", got["avatarUrl"])
		}
		if got["profileUrl"] != nil {
			t.Fatalf("non-http profile must be dropped: %v", got["profileUrl"])
		}
		if got["username"] != "ada" {
			t.Fatalf("the surviving half = %v", got["username"])
		}
	})
}

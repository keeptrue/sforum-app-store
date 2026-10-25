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

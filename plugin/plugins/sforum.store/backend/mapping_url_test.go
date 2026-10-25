package main

import "testing"

// 面板里的 <img> 需要绝对地址：商城发的是 /api/assets/<sha>，相对地址会落到论坛域名上。
// 拼不出来时宁可返回 nil（页面退回字母块），也不要给浏览器一个必然 404 的相对路径。
func TestAbsoluteAssetURL(t *testing.T) {
	sha := "/api/assets/8f" + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd"

	cases := []struct {
		name string
		base string
		path *string
		want any
	}{
		{name: "relative path against the store base", base: "https://store.example.com", path: &sha, want: "https://store.example.com" + sha},
		{name: "base with a path prefix keeps only the origin", base: "https://store.example.com/store", path: &sha, want: "https://store.example.com" + sha},
		{name: "already absolute is left alone", base: "https://store.example.com", path: strPtr("https://cdn.example.com/a.png"), want: "https://cdn.example.com/a.png"},
		{name: "nil stays nil", base: "https://store.example.com", path: nil, want: nil},
		{name: "empty stays nil", base: "https://store.example.com", path: strPtr("  "), want: nil},
		{name: "a base without scheme yields nothing", base: "store.example.com", path: &sha, want: nil},
		{name: "an empty base yields nothing", base: "", path: &sha, want: nil},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := absoluteAssetURL(testCase.base, testCase.path)
			if got != testCase.want {
				t.Fatalf("absoluteAssetURL(%q, %v) = %v, want %v", testCase.base, testCase.path, got, testCase.want)
			}
		})
	}
}

func strPtr(value string) *string { return &value }

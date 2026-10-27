package main

import "testing"

// own-settings 的三种输入必须分开对待：键缺失走默认地址，显式清空/非法值按未配置。
func TestResolveCatalogBaseURL(t *testing.T) {
	tests := []struct {
		name      string
		container map[string]any
		want      string
	}{
		{
			name:      "键缺失：新装用默认地址",
			container: map[string]any{},
			want:      defaultCatalogBaseURL,
		},
		{
			name: "键缺失但频道存在：仍然用默认地址",
			container: map[string]any{
				settingChannel: "beta",
			},
			want: defaultCatalogBaseURL,
		},
		{
			name: "合法 https：去掉尾斜杠",
			container: map[string]any{
				settingCatalogBaseURL: " https://store.example.com/ ",
			},
			want: "https://store.example.com",
		},
		{
			name: "显式清空：保持未配置",
			container: map[string]any{
				settingCatalogBaseURL: "",
			},
			want: "",
		},
		{
			name: "只有空白：按显式清空处理",
			container: map[string]any{
				settingCatalogBaseURL: "   ",
			},
			want: "",
		},
		{
			name: "http 不接受：保持未配置",
			container: map[string]any{
				settingCatalogBaseURL: "http://store.example.com",
			},
			want: "",
		},
		{
			name: "缺 host：保持未配置",
			container: map[string]any{
				settingCatalogBaseURL: "https://",
			},
			want: "",
		},
		{
			name: "非字符串：按显式清空处理",
			container: map[string]any{
				settingCatalogBaseURL: 42,
			},
			want: "",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := resolveCatalogBaseURL(test.container); got != test.want {
				t.Fatalf("resolveCatalogBaseURL() = %q, want %q", got, test.want)
			}
		})
	}
}

// 默认值只用于「键缺失」；显式清空后不能因为默认值又被拉回运营方商城。
func TestDefaultCatalogBaseURLIsNotFallbackForExplicitClear(t *testing.T) {
	cleared := map[string]any{settingCatalogBaseURL: ""}
	if got := resolveCatalogBaseURL(cleared); got != "" {
		t.Fatalf("explicit clear must stay unconfigured, got %q", got)
	}
	if defaultCatalogBaseURL != "https://app-store.dalao.me" {
		t.Fatalf("defaultCatalogBaseURL = %q, want https://app-store.dalao.me", defaultCatalogBaseURL)
	}
}

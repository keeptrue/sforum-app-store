module github.com/zhuchunshu/sforum-app-store/plugins/sforum.store/backend

go 1.26.10

require (
	github.com/Masterminds/semver/v3 v3.5.0
	github.com/zhuchunshu/sforum/apps/api v0.0.0
	google.golang.org/protobuf v1.36.11
)

require (
	github.com/fatih/color v1.13.0 // indirect
	github.com/golang/protobuf v1.5.4 // indirect
	github.com/hashicorp/go-hclog v1.6.3 // indirect
	github.com/hashicorp/go-plugin v1.8.0 // indirect
	github.com/hashicorp/yamux v0.1.2 // indirect
	github.com/mattn/go-colorable v0.1.15 // indirect
	github.com/mattn/go-isatty v0.0.22 // indirect
	github.com/oklog/run v1.1.0 // indirect
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.2 // indirect
	golang.org/x/net v0.60.0 // indirect
	golang.org/x/sys v0.49.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260526163538-3dc84a4a5aaa // indirect
	google.golang.org/grpc v1.83.2 // indirect
)

// SForum 的 apps/api 尚未作为 Go module 发布，插件用本地检出解析 SDK。
// 默认约定：本仓库与 SForum 检出同级（Code/github/…）；CI 用
// `go mod edit -replace` 覆盖为它自己的检出路径。
replace github.com/zhuchunshu/sforum/apps/api => ../../../../../SForum/apps/api

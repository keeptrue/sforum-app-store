// sforum.store 插件入口：把商城目录代理到论坛后台，并把选中的包交给 Host 安装。
package main

import (
	"log"

	pluginv2 "github.com/keeptrue/sforum/apps/api/sdk/plugin/v2"
)

func main() {
	server, err := newStoreServer()
	if err != nil {
		log.Fatalf("configure sforum.store: %v", err)
	}
	// 清单 lifecycle.* 声明后宿主会走 V2 生命周期（换摘要时重新发布注册表）；
	// 步骤实现见 lifecycle.go，全部是幂等 no-op。
	server.WithRuntimeStreams(pluginv2.RuntimeStreams{Lifecycle: runLifecycle})
	pluginv2.Serve(server)
}

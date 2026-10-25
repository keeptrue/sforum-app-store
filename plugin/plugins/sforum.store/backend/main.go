// sforum.store 插件入口：把商城目录代理到论坛后台，并把选中的包交给 Host 安装。
package main

import (
	"log"

	pluginv2 "github.com/zhuchunshu/sforum/apps/api/sdk/plugin/v2"
)

func main() {
	server, err := newStoreServer()
	if err != nil {
		log.Fatalf("configure sforum.store: %v", err)
	}
	pluginv2.Serve(server)
}

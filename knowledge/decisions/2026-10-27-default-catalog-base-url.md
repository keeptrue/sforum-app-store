# 插件默认商城地址指向 app-store.dalao.me

Status: accepted
Date: 2026-10-27

## 背景

`sforum.store.catalog_base_url` 的默认值是空串：新装的论坛打开「应用商城」只看到
「还没配置商城地址」，管理员必须先手填一个 https 基址才有任何目录请求。商城已有稳定入口
`https://app-store.dalao.me`（`/api/health` 的 `publicUrl` 与 `publicUrlSource=database`
都指向它），空默认把「装上就能用」变成了「装上先配置」，而绝大多数站点用的就是运营方商城。

## 决定

- 清单 `manifest/settings.json` 的 `default` 改为 `https://app-store.dalao.me`：设置页预填，
  「恢复推荐默认值」回到这个地址。
- 插件后端只在宿主 own-settings **没有这个键**时用同一默认值（新装、或从未保存过设置）。
  键存在但为空、只有空白、或不是合法 https，一律按「运营显式清空」处理：保持未配置，
  管理页只显示配置提示、不发任何请求。
- 默认值不覆盖人的选择：自建商城、内网部署、要停用商城的站点，清空字段并保存即可。

## 代价

- 新装论坛的第一次目录请求会打到运营方商城。出站面不变：`net.outbound` 的抓取地址本来就由
  配置的基址构造，默认值只是把「要填什么」变成「已经填好」。
- 已保存过空值的存量站点不会自动获得新默认（文档键存在即显式值），需要手填或点
  「恢复推荐默认值」。这是刻意的：不能把「我清空过」读成「我没配过」。

## 验证

- `backend/settings_test.go` 覆盖键缺失 → 默认地址、显式空/空白/http/非字符串 → 未配置。
- 发布包在宿主上过 `extension validate` / `extension test` / `brand check`；
  `bash plugin/scripts/build.sh` 后清单摘要可复现。

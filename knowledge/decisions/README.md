# Decisions

架构与产品的**取舍记录**。只写「为什么选它、放弃了什么、什么条件下重开」，不写教程。

## 何时必须写

- 选了某个第三方库/服务，或决定自己写基础设施。
- 引入新的数据域、状态机、跨产物契约。
- 触碰信任边界：谁能触发安装、谁能改 issuer、谁能看私钥。
- 推翻本仓 AGENTS.md 里的一条约定。

## 命名

`YYYY-MM-DD-<kebab-topic>.md`，例如 `2026-10-24-app-store-out-of-tree.md`。

## 结构

```md
# <标题>

Status: proposed | accepted | superseded
Date: YYYY-MM-DD

## 背景
## 决定
## 放弃的方案
## 代价与重开条件
```

## 待创建（批准实施时）

- `2026-10-24-app-store-out-of-tree.md` —— 商城为什么在 SForum 之外，边界在哪。
- `2026-10-24-app-store-identity-and-distribution.md` —— issuer 拓扑与下载分发口径。

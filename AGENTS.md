# dsh-outcomes —— 插件工作区指针

> 本仓库是 `D:\dsh\plugins\` 产品组合中的**旗舰产品**。开工前先读：
> 1. [`../PRODUCT-PLAN.md`](../PRODUCT-PLAN.md) — 组合定位、90 天目标、发布日历
> 2. [`../RELEASING.md`](../RELEASING.md) — 发布规则、冻结期、checklist
> 3. [`../README.md`](../README.md) — 组合清单与当前版本
> 4. 本仓库 `README.md` / `docs/PUBLISHING.md` — 安装、发布状态、边界

## 当前状态

- 版本：**0.1.4**（GitHub tag/Release `v0.1.4` 已发；npm `latest` 待 approve —— 见下面 2026-11-24 那条）
- 市场：PR **#18429 已提（2026-11-24，钉 v0.1.4，待合并）**；此前条目钉的是 0.1.3
- 测试：`npm test` → **104/104**；`npm run preflight` 通过
- 定位：成果清单（agent 登记 / 人看图 / 脚本能查）；只记路径，不搬文件

### 2026-11-24（0.1.4）：HTTP 路由补 DSH 访问检查

- 由来：市场维护者的 post-merge 审计在 `dsh-button` 上指出同一处问题后，复查本插件发现 `/__dsh-outcomes/*`
  前缀路由（含**写**操作）只做了自造 loopback + 同源，没有走宿主准入 —— 浏览器里任意网页都能读清单、改清单。
- 改法：`guardHttp()` 第一道问 `ctx.connection.requestRejection(req)`，401/403 原样回、被拒写入不落盘；
  `inject` 加 `connection`；loopback / 同源保留为纵深防御；`SECURITY.md` 删掉「路由没有鉴权」那条已知取舍。
- 验证：`npm test` **104/104**（新增 3 例 + 钉 inject）；反向验证（fence 改恒假 → `actual: 200, expected: 403`）；
  `npm run preflight` 通过；`npm pack` = 32 文件 / 223.5 kB，shasum `dcf15b76…`。
- 发布：tag `v0.1.4` + GitHub Release（资产 `dsh-outcomes-0.1.4.tgz`，223,466 B，URL HEAD 200）；市场 PR **#18429**。
- 未做：**宿主半部要重启 DSH 才生效**，重启后真机未点（重启后 GET 一次 `/__dsh-outcomes/api/status` 看是否 200）。
- 顺带纠正：老文档写「npm 0.1.3 / 市场钉 0.1.2」已过时 —— 0.1.3 曾发布、条目后来跟到了 v0.1.3，但从没为 0.1.3 开过 PR。

## 硬规则

- 不为了 P2/文档/CI 单独发版；攒到下一次 release train。
- 安全/数据丢失例外：允许立即 patch，但发完进入冻结。
- 发布前：`npm test`、`npm run preflight`、`npm pack --dry-run`、README/CHANGELOG 对齐、干净工作树。
- 市场 PR 只钉一个已发布版本；合并前不改 tarball。
- 不改 `~/.dsh/profiles`；profile 只 `link:` 本目录。

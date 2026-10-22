# dsh-outcomes —— 插件工作区指针

> 本仓库是 `D:\dsh\plugins\` 产品组合中的**旗舰产品**。开工前先读：
> 1. [`../PRODUCT-PLAN.md`](../PRODUCT-PLAN.md) — 组合定位、90 天目标、发布日历
> 2. [`../RELEASING.md`](../RELEASING.md) — 发布规则、冻结期、checklist
> 3. [`../README.md`](../README.md) — 组合清单与当前版本
> 4. 本仓库 `README.md` / `docs/PUBLISHING.md` — 安装、发布状态、边界

## 当前状态

- 版本：**0.1.2**（npm `latest`；GitHub `v0.1.2`）
- 市场：时间门 **2026-10-23 20:31** 后提交；钉 0.1.2，不追新 patch
- 测试：`npm test` → 99/99；`npm run preflight` 通过
- 定位：成果清单（agent 登记 / 人看图 / 脚本能查）；只记路径，不搬文件

## 硬规则

- 不为了 P2/文档/CI 单独发版；攒到下一次 release train。
- 安全/数据丢失例外：允许立即 patch，但发完进入冻结。
- 发布前：`npm test`、`npm run preflight`、`npm pack --dry-run`、README/CHANGELOG 对齐、干净工作树。
- 市场 PR 只钉一个已发布版本；合并前不改 tarball。
- 不改 `~/.dsh/profiles`；profile 只 `link:` 本目录。

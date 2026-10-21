# 进度与路线（把控制台改写成可发布的 DSH 成果管理工具）

> 目标（会话 goal）：**将控制台改写为可以向社区发布的 DSH 成果管理工具**。
> 这份是**跨轮次状态板**：每轮结束更新。**逐轮细节在 [`CHANGELOG.md`](CHANGELOG.md)**（那里按轮记了"改了什么 + 被实测纠正了什么"）。

**产物**：`D:\dsh\dsh-outcomes\`（独立包，与个人控制台**并存**，至今**未改动控制台**）。
**当前**：`dsh-outcomes@0.1.0` · **93 条测试**全绿 · 随包 **31 文件** · 真机验收三种模式全过
（`acceptance.mjs` / `--from-pack` / `--tools-check`）· **7 个守卫变体全部被抓住**（`npm run guards`）。

## 已经做完并且验过的

| 能力 | 判据（怎么验的） |
|---|---|
| 包骨架符合生态契约 | 官方 `dsh plugin add` 装进 profile；`--dump-config` 里出现 `# == dsh-outcomes` |
| 装载 + 运行 | `tools/acceptance.mjs`：临时 `DSH_HOME` + 临时端口起隔离实例，管理页/登记/列表/文件服务全过，退出码 0 |
| **发布产物**可用 | `--from-pack`：先 `npm pack`，把 **.tgz** 装进全新 profile 再跑一遍（`files` 白名单漏文件只有这步能发现） |
| 配置在真宿主里生效 | 起实例前写用户设置文件，断言 `dir` 正好生效且来源报 `settings-file` |
| 清单核心 | 只追加 JSONL / 删除留档可放回 / `.bak`→`.tmp`→rename / 重写自愈（坏行只跳过自己） |
| 并发安全 | 读—改—写带内容哈希复核，冲突时**拒绝且不写入**（`concurrent-modification`），不留 `.tmp` |
| agent 工具 | 6 个：`add / list / update / check / remove / restore`；`remove` 过审批闸门 |
| 管理页 | 请求期渲染、自包含、中英双语、搜索**走服务端**（窗口满了也搜得到）、缺文件横幅 |
| 客户端半部 | 设置 → Outcomes 分节；`id` 必须等于包名（静默失败），测试钉住 |
| 迁移 | `tools/import-registry.mjs`：id 原样保留、缺文件不丢条目、拒绝覆盖非空目标、幂等；**副本实测 115+20 全部可导、0 缺失** |
| 截图 | `tools/screenshots.mjs` 跑起来真拍中英两张，随包发布；README 引用 |
| 文档 | README（中/英）、DESIGN（取舍 12 条＋代价表）、**TROUBLESHOOTING（按症状查）**、CLIENT-HALF、CAPABILITY-DISCLOSURE、PUBLISHING、SECURITY、CONTRIBUTING、CHANGELOG |
| 守卫可信度 | `npm run guards`：把包**故意改坏**（7 个变体，临时副本上），确认每个守卫都会叫 —— **"检查通过"只有在"检查能失败"的前提下才有意义**（第 24/26 轮） |
| 测试 | **93 条**：store / paths / host / page / client / client-render（真执行客户端半部）/ e2e / import / shipped / docs —— 重心是**防实现与说明书的漂移** |

## 逐轮做了什么（细节见 CHANGELOG）

1. 做出可发布形态的包（核心 + 工具 + 页面 + 客户端半部 + CLI + 60 条测试）
2. **真机装载验收**（隔离实例，没碰日常 DSH）+ 迁移工具 + 自动化验收脚本
3. `pageSize` 落地（此前只在配置里解析、没人用）+ 搜索改走服务端 + 配置层测试
4. README 截图（跑起来真拍）；修掉"`spawnSync` 饿死演示服务"与"截图印出本机用户名"
5. `tools/chrome.mjs` 收拢浏览器相关；验收第 10 步改走真浏览器，读不到就**如实降级**
6. `outcome_update` 工具（补上"API 能改、工具不能改"）+ `SECURITY.md`
7. **乐观并发**：并发冲突从"静默覆盖丢一条"改成"明确拒绝"
8. 验收对象换成**会发布的 tgz 产物**
9. 补上**渲染页面**这一层的测试（占位符 / 内联脚本 / 词典一致性）
10. `docs/DESIGN.md`：把 9 轮的取舍收成一份，每条写清代价
11. 四项待决事项写成**可执行清单＋回滚**（`控制台\_survey\adopt-dsh-outcomes.md`）；实测查清 npm 名字可用
12. 验收补上"配置在真宿主里真的生效" + `CONTRIBUTING.md`
13. 随包文档**链接完整性**测试（防"README 指向包外文件"这类发布后才发现的断链）

## 未做 —— 全部是"需要用户决定"的（不做任何一项都不影响包本身可用）

| # | 事项 | 卡在哪 | 已查清的事实 |
|---|---|---|---|
| 1 | **装进日常 profile**（`~/.dsh/profiles/desktop`） | 会动用户每天在用的 DSH，**且需要重启一次**（当前会话就跑在那上面） | 命令、预期输出、验证点、回滚都写在 `控制台\_survey\adopt-dsh-outcomes.md` §1 |
| 2 | ~~包名是否可用~~ | ✅ **已解决** | **2026-10-16 实测 registry.npmjs.org 返回 404 → 名字可用**；三个 optional peer 也都在 |
| 3 | 发布到 GitHub / npm | 会**公开身份与提交邮箱** | 本机 npm **未登录**；registry 指向**镜像站**（发版须显式 `--registry=https://registry.npmjs.org`）；npm 有 72 小时撤回限制 |
| 4 | 控制台「成果」页签：**指向插件** 还是 **退役** | 涉及 **115 条历史登记**与一个**正在跑**的服务 | 迁移已在副本上验过（0 缺失）；两条路各带回滚，见 `adopt-dsh-outcomes.md` §4 |

**触发词**：「装日常」/「发版」/「发 npm」/「页签指向插件」/「页签退役」/「迁清单」。

## 下一轮计划

- ✅ **缺陷已修（第 16 轮）**：无 Web 服务的 profile 里插件不激活 → 拆成两条 entry
  （工具半 `lib/tools.js` `inject: ['tools']`、页面半 `lib/index.js` `inject: ['webServer']`，包主入口是工具半）。
  **实测**：headless 里模型找到并调用 `outcome_add`（隔离清单出现 `20261016-030303-d61d`）、
  web 侧 `acceptance.mjs` 9 步全过；回归测试钉死结构。
- 顺带核对：日常 profile 有 20 个 bundle（十几社区插件），确认我的路由前缀／工具名／slot id／bundle id
  与它们都不冲突。
- 不再动任何需要用户决定的东西（下面四项仍等答复）。

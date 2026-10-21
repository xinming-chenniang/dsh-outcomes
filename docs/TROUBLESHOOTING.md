# 排查手册（症状 → 原因 → 怎么查 → 怎么办）

> 这个插件的失败方式**大多是静默的**（不会报错，只是"东西不见了"）。这份手册按**症状**组织，
> 每条都来自实测，不是推测。查不清时先跑 `node tools/acceptance.mjs`：它在隔离实例里把整条链路走一遍。

## 设置里没有「Outcomes」这一节

**最可能的原因**：客户端半部的 `id` 与包名不一致。宿主按**包名**索引这条插件，写错**不报错**，
只是这一节不存在（`docs/CLIENT-HALF.md` 第 ⑤ 步）。

**怎么查**：打开 DSH 的 Web 端口（带启动日志里那行 `?token=` 的地址），在页面源码里搜
`dsh-outcomes/client.js` —— 出现了就说明宿主**认得**这个包。

**怎么办**：确认 `lib/client.js` 里 `window.__ModuleLoader__.load({ id: 'dsh-outcomes', … })`
与 `package.json` 的 `name` 完全一致；`npm test` 里有断言钉着这一点。
另外确认 `package.json` 的 `dsh.client.platform === 'web'`、`exports["./client"]` 存在。

## 管理页打不开（`/__dsh-outcomes/` 404）

**原因 A**：包只在 `dependencies` 里，**没进 `dsh.profile.bundles`** —— 装了 ≠ 装载。
**怎么查**：`dsh --profile <名> --dump-config | Select-String dsh-outcomes`，看有没有 `# == dsh-outcomes`。

**原因 B**：你把它装进了**没有 Web 服务**的 profile（headless / 纯 agent）。
**这是正常的**：页面半声明了 `inject: ['webServer']`，没有该服务时它会打印一行
`dsh-outcomes-web: pending (waiting for service: webServer)` 并保持等待 ——
**工具半照样可用**（见下一条）。想用页面就装进 Web 形态的 profile。

**原因 C**：改了 `cordis.patch.yml` 或 `package.json` 之后**没重启 DSH** —— bundle 只在启动时装载。

## agent 说"没有 outcome_add 这个工具"

**原因**：只有**页面半**被装上了，没有工具半。0.1.0 起宿主被拆成两条 entry：

| entry | 依赖的服务 | 什么时候激活 |
|---|---|---|
| `dsh-outcomes`（工具半，包主入口） | `tools` | **几乎总是**（headless / 纯 agent 也可以） |
| `dsh-outcomes-web`（页面半） | `webServer` | 有 Web 服务的 profile |

**怎么查**：启动输出里若出现 `dsh: warning: N entry did not activate`，看是哪一条 pending。
**怎么办**：确认 `cordis.patch.yml` 里**两条 entry 都在**（0.1.0 之前只有一个模块，
你如果**自己手写过 patch**，升级后必须补上 `dsh-outcomes-web` 那一条）。

## 登记了，但在别的目录找不到 / 页面显示的目录不是我想要的

**原因**：配置有四层来源，你改的那层不是生效的那层。
**怎么查**：`GET /__dsh-outcomes/api/status` 里的 `sources.dir` 会**如实报告**是哪一层生效的
（`config` / `env` / `settings-file` / `default`）。
**优先顺序**：profile 的 `cordis.patch.yml` config → 环境变量（`DSH_OUTCOMES_DIR`）→
`$DSH_HOME/.dsh-outcomes.json` → 默认 `$DSH_HOME/plugin-data/dsh-outcomes`。
**改配置要重启**：插件只在装载时解析一次。

## 自动化里「取消登记」总是失败

**症状**：`tool "outcome_remove" requires approval, but no approval channel is available`

**这是故意的**：`outcome_remove` 挂在宿主的审批闸门上，非交互环境里**失败关闭**（不会偷偷执行），
清单不会变。其余五个工具不受影响。
**怎么办**：自动化里用 CLI（`dsh-outcomes remove <id>`）或管理页。

## 清单里冒出 `why: "auto-archived"` 的记录

**这是自愈**：某次重写时发现"这条不见了、删除留档里也没有"，于是替它留了档。
正常来源是"别的进程/别的工具/手工编辑删掉了它"。看 `deleted.jsonl` 就能知道时间与原因；
`dsh-outcomes restore <id>` 可以放回来。

## 报 `concurrent-modification`

**含义**：你（或另一个进程）在读—改—写之间改动了清单。**这次写入被拒绝、文件一个字没动**（这是有意设计：
宁可明确失败，也不要静默覆盖掉别人的一条登记）。
**怎么办**：错误里带 id，重跑那条命令即可。CLI 与插件同时写同一份清单时最容易遇到。

## 预览里 SVG 是"下载"而不是内联

**故意的**：SVG 是图片但能携带脚本，所以内联白名单里**没有它**。其余常见图片格式（png/jpg/gif/webp/avif/bmp/ico）
与 html/htm/pdf 会内联；内联的 HTML 额外带沙箱 CSP。

## 拿脚本直接 `fetch` 宿主的 `/` 会 401

**原因**：宿主的 Web 入口有**浏览器信任围栏**，脚本直连会被挡（`tools/acceptance.mjs` 也踩过）。
**怎么办**：用浏览器打开启动日志那行带 `?token=` 的地址。插件的路由（`/__dsh-outcomes/…`）不受此限。

## 写请求返回 403

**原因**：非 GET 请求必须带写守卫头 `x-dsh-outcomes: 1`（挡跨站误写，**不是鉴权**）。
`curl`/脚本忘了带这个头就会 403；管理页自己带。
**注意**：路由**不做鉴权**，能访问宿主端口的人就能改清单 —— 见 [`SECURITY.md`](../SECURITY.md)。

## 还是不对

1. `npm test` —— 覆盖清单核心、配置、并发、渲染页面、客户端半部；
2. `node tools/check.mjs` —— 语法 + CLI 冒烟 + 随包文件泄漏扫描；
3. `node tools/acceptance.mjs`（可加 `--from-pack` / `--tools-check`）—— 隔离实例里跑真链路；
4. 报告问题时附上：包版本、DSH 版本、`/api/status` 的输出、以及启动输出里所有 `dsh-outcomes` 相关的行。

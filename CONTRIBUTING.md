# 参与开发

零依赖、无构建步骤：克隆下来就能跑。需要 **Node ≥ 20**（用 `node --test`，不装测试框架）。

```bash
npm test        # 96 条：store / paths / host / page / client / e2e / import / shipped / docs
npm run check   # 逐文件语法 + CLI 冒烟 + 泄漏扫描
npm run preflight   # 上面两条 + 打包清单，退出码即结论
```

## 提交前

1. **`npm run preflight` 必须全过**（它同时检查语法、CLI 冒烟、随包文件里有没有本机专有内容）。
2. 改了页面或客户端半部 → 重跑 `node tools/screenshots.mjs`（README 里的图就是这么来的，别让图过期）。
3. 改了 bundle / 客户端契约 → 先读 [`docs/CLIENT-HALF.md`](docs/CLIENT-HALF.md)：
   `dsh.client` 的 `id` **必须等于包名**，写错是**静默不加载**。
4. 改了行为 → 同步 [`docs/DESIGN.md`](docs/DESIGN.md) 里对应那条的**代价**栏。
   取舍变了却只改代码，等于把"为什么"丢了。
5. 准备发版 → `node tools/acceptance.mjs --from-pack`（验的是打包产物，不是工作树）。
6. **动过任何守卫或扫描规则** → 跑 `npm run guards`：它把包**故意改坏**（7 个变体，都在临时副本上），
   看守卫会不会叫。第 24 轮的教训是"扫描器报干净，但规则本身有盲区" ——
   **"检查通过"只有在"检查能失败"的前提下才有意义**。
   它**先验基线**：未改动的副本自己不绿就 `exit 2`（"基线不绿，结论无效"），
   而不是把 7 个变体全算成"被抓住"（那是假绿，2026-10-18 补）。

## 这套测试防的是什么

**不是覆盖率，是"实现与说明书之间的漂移"** —— 这类错误是静默的：

| 文件 | 钉住什么 |
|---|---|
| `test/docs.test.mjs` | 工具名序列、配置键、README 里引用的图，都要与实现/磁盘对得上 |
| `test/page.test.mjs` | 渲染结果不留占位符、内联脚本能过 `node --check`、中英词典 key 一致 |
| `test/shipped.test.mjs` | `files` 白名单里每个文件都存在、随包文件无本机专有内容 |
| `test/e2e.test.mjs` | 真起 HTTP 打一遍（曾靠它发现"按条目类型决定 disposition"的 bug） |
| `test/paths.test.mjs` | 四层配置优先级、非数值回落、坏 JSON 不抛错 |

**加功能就要同时加断言**，而且要加在"能发现漂移"的位置上。历史上的实际例子：
加第 6 个工具时，是 `docs.test.mjs` 当场把 README 没同步这件事抓出来的。

## 不要提交

- 本机路径、用户名、凭据（泄漏扫描会拦，但别指望它兜住一切）；
- `.demo-tmp-*/`（截图脚本的临时现场，跑完自动删）、`*.tgz`、`node_modules/`、任何生成物。

## 文档与语言

代码注释与 `docs/` 以中文为主，README 提供中英两份。**PR 用中文或英文都可以** ——
但新增的用户可见文案要同时给两种语言（词典 key 必须成对，`page.test.mjs` 会检查）。

## 安全

漏洞报告方式与威胁模型见 [`SECURITY.md`](SECURITY.md)。特别提一句：**路由不做鉴权**，
这是明说的取舍（与宿主 UI 同等可达），请不要"顺手加半套鉴权" —— 详见 [`docs/DESIGN.md`](docs/DESIGN.md) §9。

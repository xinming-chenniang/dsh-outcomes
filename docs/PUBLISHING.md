# 发布流程（发布前逐条走一遍）

> 目标：**别人拿到包能装上、能用、并且看得出它会碰什么**。npm 发布是可选的最后一步；
> 主路径是 GitHub（社区清单靠 topic 与 `dsh-plugin` 关键字收录）。

## 0. 发布状态（2026-10-22）

- **GitHub 已发布**：<https://github.com/xinming-chenniang/dsh-outcomes>（public，`main` + tag `v0.1.0`
  + Release 资产 `dsh-outcomes-0.1.0.tgz`；**`v0.1.1` + Release 资产 `dsh-outcomes-0.1.1.tgz`** 是 npm 修复版）。
  下面的 `git init` / `gh repo create` 是当时的动作记录。
- **npm 已发布**：`dsh-outcomes@0.1.1` 是 `latest`（CLI `bin` 已确认在 tarball 里）；`0.1.0` 也在
  versions 里。`npm whoami --registry=https://registry.npmjs.org` = `xinming-chenniang`。
- **真机装载验收**：本机 desktop profile 以 `link:` 装载并日常使用；隔离 `--from-pack` 验收**尚未重跑**
  （发布后补，见第 4 步）。
- **社区收录**：仓库已加 `dsh-plugin` / `deepseek-harness` topic；awesome 清单 PR 需等仓库满 1 天
  （2026-10-23 20:31 北京时间后）。

## 1. 版本与变更记录

- 改 `package.json` 的 `version`，同时在 `CHANGELOG.md` 里写同版本的一节（Release notes 直接贴它）。
- CHANGELOG 用 `## x.y.z — YYYY-MM-DD` 标题；没有自动 bump 脚本，是刻意的（版本号是人决定的事）。

## 2. 自检（一条命令，退出码即结论）

```bash
npm run preflight      # = npm test && npm run check && npm run pack:check
```

`npm run check`（`tools/check.mjs`）会做三件事：逐文件 `node --check`、CLI 在临时目录上的冒烟往返、
以及对随包文本的**泄漏扫描**（个人绝对路径、本机专有名词、会话 id）。

## 3. 看清单，别猜清单

```bash
npm run pack:check     # npm pack --dry-run --json
```

逐条核对：**只应有** `lib/` `bin/` `tools/` `docs/` `cordis.patch.yml` `config.example.json`
`README.md` `README.en.md` `CHANGELOG.md` `LICENSE`。

> ⚠️ 有 `files` 字段时 `.npmignore` 与 `.gitignore` **对打包完全不生效** ——
> 要排掉目录里的运行期文件，只能靠 `!` 取反项。本包目前没有需要取反的项；
> 哪天往 `tools/` 或 `lib/` 里放运行期数据，就必须同时加取反项，并在 `test/shipped.test.mjs` 里钉住。

## 4. 真机装载验收（**必须做，且必须在别的机器/别的 profile 上做**）

```bash
node tools/acceptance.mjs            # 在装有 DSH 的机器上；默认端口 19399，可 --port 换
node tools/acceptance.mjs --from-pack  # 装 **npm pack 的 tgz 产物**（发版前该跑这条）
node tools/acceptance.mjs --tools-check # 再起 headless profile，让真模型调 agent 工具（需凭据，拿不到会如实标已跳过）
node tools/acceptance.mjs --keep     # 出问题想留现场时用（临时 DSH_HOME 不删）
```

它做的是**隔离实例**验收：临时 `DSH_HOME` + `--from-default-profile web` 建一个 profile、
官方 CLI 装本包、`--dump-config` 断言 bundle 进了 profile 树、起 Web 服务、打一遍真实 HTTP，
最后关实例（**失败也会收尾**，不留后台实例占端口）。9 步全过 = 退出码 0。

**发版前跑 `--from-pack`**：它验的是打包产物本身。`files` 白名单漏文件时，工作树怎么跑都正常，
只有装上 `.tgz` 才会暴露 —— 这类错要是漏到发版之后，代价最大。

命令覆盖不到、**仍然要人眼看一遍**的两件事：

- [ ] 在浏览器里打开启动日志那行带 token 的地址，**设置 → Outcomes** 这一节真的出现了
      （宿主对 `/` 有浏览器信任围栏，脚本拿不到；客户端 id 写错就是这种静默失败）；
- [ ] 点进去，登记一个真实产物、刷新页面能看到、预览能打开、取消登记后**文件仍在**。

（第 2 轮实测：脚本 9 步全过；客户端半部在宿主启动清单里确认到
`{"id":"dsh-outcomes","url":"plugins/??dsh-outcomes/client.js&rev=…"}`，`inject` 与声明一致。
因此"设置里出现这一节"只剩**目测**这一步。）

## 5. 建仓与推远端

```bash
git init -b main
git add -A            # 首次提交前先看清 npm pack 的清单，别把运行期文件带进去
git commit -m "feat: dsh-outcomes v0.1.0 — 成果清单（agent 工具 + 管理页 + CLI）"
gh repo create dsh-outcomes --public --source=. --push --description "Deliverables registry for DeepSeek Harness"
```

两条硬约束（踩过就回不来）：

1. **历史也会泄漏**：`git rm --cached` 只清新提交，**已推出去的 blob 仍在历史里** —— 第一次提交前就把清单看干净。
2. **提交作者邮箱会随推送公开**：先 `git config user.email` 确认想公开的那个。

## 6. 打 tag 与 Release

```bash
git tag -a v0.1.0 -m "dsh-outcomes 0.1.0"
git push origin main --tags
gh release create v0.1.0 --notes-file CHANGELOG.md
```

## 7. npm（可选）

```bash
npm publish --access public
```

- 包名 `dsh-outcomes` 在 npm 上是否可用要先查（`npm view dsh-outcomes`）；被占了就加 scope，并同步改
  `package.json.name`、`cordis.patch.yml` 的 `id`/`name`、`lib/client.js` 的 `id`——**这三处必须一致**。
- 仓库里没有 `.npmrc`：用的是全局 registry 配置（镜像由使用者自己决定）。

## 8. 让社区搜得到

- GitHub 仓库加 topic：`dsh-plugin`、`deepseek-harness`。
- `package.json` 的 `keywords` 保留 `dsh` / `dsh-plugin` / `deepseek-harness-plugin`。
- README 顶部一句话说清"它解决什么问题"（社区清单通常只抓这一句与仓库描述）。

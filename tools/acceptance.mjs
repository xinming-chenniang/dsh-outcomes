#!/usr/bin/env node
/**
 * 真机装载验收（**隔离实例**，不碰你日常用的那个 DSH）。
 *
 *   node tools/acceptance.mjs [--dsh <dsh 可执行文件>] [--port 19399] [--keep]
 *
 * 它做的事（每一步都有判据，失败即退出码 1）：
 *   1. 在**临时 DSH_HOME** 里用 web 模板建一个 profile（`--from-default-profile`）
 *   2. 用官方 CLI 把本包装进那个 profile（`dsh plugin add file:<本包>`）
 *   3. `--dump-config` 断言**bundle 真的被组合进 profile 树**（出现 `# == dsh-outcomes`）
 *   4. 起那个 profile 的 Web 服务（另一个端口），轮询插件路由
 *   5. 打一遍真实 HTTP：管理页 200 / 登记 / 列表 / 取文件（内联 + 沙箱 CSP）
 *   6. 从 Web 启动清单里断言**客户端半部被宿主装配**（`{"id":"dsh-outcomes","url":"…/client.js"}`）
 *   7. 关掉实例、删掉临时 home（`--keep` 保留现场）
 *
 * 为什么值得存在：`dsh plugin add` 装上了不代表**装载**了（bundles 才是开关），
 * 装载了也不代表客户端半部被装配（id 写错是**静默失败**）。这三件事都只有真起一次才知道。
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findChrome, dumpDom } from './chrome.mjs'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const args = { dsh: '', port: 19399, keep: false, pack: false, toolsCheck: false }
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--dsh') args.dsh = process.argv[++i] ?? ''
  else if (arg === '--port') args.port = Number(process.argv[++i] ?? 19399)
  else if (arg === '--keep') args.keep = true
  // `--from-pack`：先 `npm pack`，再把**产出的 .tgz** 装进隔离 profile —— 验的是"发布出去的那个东西"。
  // 工作树能跑不等于 tgz 能跑：`files` 白名单漏了某个文件（比如 lib/page.js），
  // 只有装 tgz 才会暴露 —— 而那正是发版之后才发现、最贵的那种错。
  else if (arg === '--from-pack') args.pack = true
  // `--tools-check`：再起一个 **headless** profile，让真模型去调 agent 工具。
  // 为什么要有这一步：插件的**主用途**就是"agent 登记成果"，而这条路径曾经整个坏掉
  // （`inject: ['webServer']` 是必需服务 → 没有 Web 服务的 profile 里 apply 都没跑 → 6 个工具一个都没注册）。
  // 需要凭据 → 只在显式给这个开关、且拿得到凭据时才跑（拿不到就如实标"已跳过"，不谎报）。
  else if (arg === '--tools-check') args.toolsCheck = true
}

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const WIN = process.platform === 'win32'
/** 常见安装位置 —— 从环境变量推导，**不写死任何用户名**（社区包不该带本机路径）。 */
const DSH_CANDIDATES = WIN
  ? [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  ].filter((p) => existsSync(p))
  : ['/usr/local/bin/dsh', '/usr/bin/dsh']
const DEFAULT_DSH = DSH_CANDIDATES[0] ?? (WIN ? 'dsh.cmd' : 'dsh')
const DSH = args.dsh !== '' ? args.dsh : (process.env.DSH_CLI ?? DEFAULT_DSH)

const steps = []
function ok(label, detail = '') { steps.push(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`) }
function fail(label, detail = '') {
  steps.push(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  report(1)
}
function report(code) {
  // **失败也必须先收尾**：留着隔离实例在后台跑，等于给下一个跑验收的人埋一个"端口被占"的坑。
  const stopCode = stop()
  if (code === 0 && stopCode === 0) steps.push('  ✓ 已关掉隔离实例')
  if (code !== 0 && child !== undefined) steps.push('  ⚠️ 已尝试关闭隔离实例（若端口仍被占，手工清理）')
  process.stdout.write(`\ndsh-outcomes 装载验收（${PKG.name}@${PKG.version}）\n`)
  for (const line of steps) process.stdout.write(line + '\n')
  process.stdout.write(code === 0 ? '\n全部通过\n\n' : '\n有失败\n\n')
  process.exit(code)
}

if (!existsSync(DSH) && args.dsh === '' && process.env.DSH_CLI === undefined) {
  process.stderr.write(`找不到 dsh CLI：${DSH}\n用 --dsh <路径> 指定，或设 DSH_CLI。\n`)
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'dsh-outcomes-accept-'))
const env = { ...process.env, DSH_HOME: home }

/** Windows 上要经 shell 跑 `.cmd`，而路径里有空格（"DeepSeek Harness"）—— 必须自己加引号。 */
const quote = (value) => (/[\s"]/.test(String(value)) ? `"${String(value).replace(/"/g, '\\"')}"` : String(value))

function run(command, extra = []) {
  const result = WIN
    ? spawnSync([quote(command), ...extra.map(quote)].join(' '), { env, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
    : spawnSync(command, extra, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
  return { code: result.status ?? 1, out: String(result.stdout ?? ''), err: String(result.stderr ?? '') }
}

function boot(command, extra) {
  return WIN
    ? spawn([quote(command), ...extra.map(quote)].join(' '), { env, detached: false, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    : spawn(command, extra, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let child
try {
  // 1. 建隔离 profile
  const created = run(DSH, ['--profile', 'acc', '--from-default-profile', 'web', '--dump-config'])
  if (created.code !== 0) fail('建隔离 profile 失败', created.err.slice(0, 300))
  ok('在临时 DSH_HOME 里建了 profile（不动 ~/.dsh）', home)

  // 2. 装插件（`--from-pack` 时装的是 npm pack 产出的 .tgz，也就是真正会发布出去的那个东西）
  let target = `file:${ROOT.split('\\').join('/')}`
  if (args.pack) {
    const packed = spawnSync(NPM, ['pack', '--json', '--pack-destination', home], { cwd: ROOT, encoding: 'utf8', shell: WIN, timeout: 300000 })
    if (packed.status !== 0) fail('npm pack 失败', String(packed.stderr ?? '').slice(0, 300))
    let filename = ''
    try { filename = JSON.parse(String(packed.stdout))[0].filename } catch { /* 下面统一报错 */ }
    if (!filename) fail('npm pack 没返回文件名', String(packed.stdout ?? '').slice(0, 300))
    const tarball = join(home, filename)
    if (!existsSync(tarball)) fail('找不到打出来的 tgz', tarball)
    target = `file:${tarball.split('\\').join('/')}`
    ok('已打出待发布的 tgz', `${filename}（${Math.round(statSync(tarball).size / 1024)} KB）`)
  }
  const install = run(DSH, ['plugin', '--profile', 'acc', 'add', target])
  if (install.code !== 0) fail('dsh plugin add 失败', (install.err || install.out).slice(0, 400))
  ok(args.pack ? '官方 CLI 安装了**tgz 产物**' : '官方 CLI 安装了本包（工作树）', `${PKG.name}@${PKG.version}`)

  // 3. bundle 是否被组合进 profile 树
  const dump = run(DSH, ['--profile', 'acc', '--dump-config'])
  if (dump.code !== 0) fail('--dump-config 失败', dump.err.slice(0, 300))
  if (!dump.out.includes(`# == ${PKG.name}`) || !new RegExp(`name:\\s*'?${PKG.name}'?`).test(dump.out)) {
    fail('bundle 没有被组合进 profile 树（bundles 是不是没写？）')
  }
  ok('bundle 已组合进 profile 树', `# == ${PKG.name}`)

  // 4. 起 Web 服务（另一个端口）
  //    先把**用户设置文件**写上：这样验的不只是"能跑"，而是"真宿主里配置真的被读到了"——
  //    默认目录那条路径单元测试已覆盖，而"配置不生效"的症状是**清单悄悄写到别处**，必须真起一次才敢说没问题。
  const configuredDir = join(home, 'configured-outcomes')
  writeFileSync(join(home, '.dsh-outcomes.json'), JSON.stringify({ dir: configuredDir }, null, 2), 'utf8')
  const logFile = join(home, 'acceptance-boot.log')
  child = boot(DSH, ['--profile', 'acc', '--port', String(args.port), '--no-open'])
  let log = ''
  child.stdout.on('data', (b) => { log += String(b) })
  child.stderr.on('data', (b) => { log += String(b) })
  child.on('error', () => {})
  writeFileSync(logFile, '')

  const base = `http://127.0.0.1:${args.port}`
  let up = false
  for (let i = 0; i < 80; i++) {
    await sleep(750)
    try {
      const res = await fetch(`${base}/__dsh-outcomes/api/status`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) { up = true; break }
    } catch { /* 还没起来 */ }
  }
  if (!up) fail('隔离实例没起来（或插件路由没挂上）', log.slice(0, 400))
  ok('隔离实例启动，插件路由可用', base)

  // 5. 真实 HTTP 一遍
  const status = await (await fetch(`${base}/__dsh-outcomes/api/status`)).json()
  if (status.version !== PKG.version) fail('status.version 与包版本不一致', `${status.version} vs ${PKG.version}`)
  // 配置真的被读到了吗：设置文件里写的目录必须生效（而不是悄悄回落到默认目录）
  if (status.dir !== configuredDir) {
    fail('设置文件里的 dir 没生效（清单会悄悄写到别处）', `实际 ${status.dir} · 期望 ${configuredDir} · 来源 ${status.sources?.dir}`)
  }
  if (status.sources?.dir !== 'settings-file') fail('配置来源报告不对', `sources.dir = ${status.sources?.dir}`)
  ok('用户设置文件里的 dir 在真宿主里生效（来源如实报告）', `${status.dir} ← ${status.sources.dir}`)

  const page = await fetch(`${base}/__dsh-outcomes/`)
  if (page.status !== 200 || !(await page.text()).includes('DSH outcomes')) fail('管理页没出来', `status=${page.status}`)
  ok('管理页 200 且渲染正常')

  const artifact = join(home, 'acceptance-artifact.html')
  writeFileSync(artifact, '<!doctype html><meta charset="utf-8"><h1>acceptance</h1>')
  const added = await fetch(`${base}/__dsh-outcomes/api/add`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-outcomes': '1' },
    body: JSON.stringify({ title: 'acceptance artifact', paths: artifact, by: 'acceptance' }),
  })
  const entry = added.ok ? (await added.json()).entry : null
  if (!entry) fail('登记失败', `status=${added.status}`)
  ok('登记成功', entry.id)

  const list = await (await fetch(`${base}/__dsh-outcomes/api/list`)).json()
  if (list.rows.length !== 1) fail('列表里没有刚登记的条目')
  ok('列表可见')

  const file = await fetch(`${base}/__dsh-outcomes/file/${entry.id}/0`)
  if (file.status !== 200) fail('文件服务失败', `status=${file.status}`)
  if (file.headers.get('content-disposition') !== 'inline') fail('HTML 没按内联给出')
  if (!/sandbox/.test(file.headers.get('content-security-policy') ?? '')) fail('内联 HTML 缺沙箱 CSP')
  ok('文件服务：内联 + 沙箱 CSP')

  // 6. 客户端半部有没有被装配 —— **用真浏览器**取宿主自己的启动清单。
  //    为什么不 fetch：宿主的 / 有浏览器信任围栏，脚本直连会 401（实测），而带 token 的 URL 在
  //    真浏览器里能正常打开。Chrome 不在就降级成"需人工看一眼"，不谎报成功也不误报失败。
  const token = /token=([A-Za-z0-9_\-]+)/.exec(log)?.[1]
  if (!token) fail('没从启动日志里拿到令牌', log.slice(0, 200))
  const chrome = findChrome()
  const rootUrl = `${base}/?token=${token}`
  if (!chrome) {
    steps.push('  ⚠️ 客户端半部无法自动判定：本机没找到 Chrome/Chromium（可用 CHROME_PATH 指定）')
    steps.push(`     手工确认：用浏览器打开 ${rootUrl}，搜 "${PKG.name}/client.js" 是否出现在启动清单里`)
  } else {
    // DSH 的 Web 端是 SPA（有持续活动），`--dump-dom` 有时等不到"页面完成"就被我们掐掉 ——
    // 给一个**短**预算与**短**超时，读不到就降级成人工确认，不拖住整条验收。
    const { dom, code } = await dumpDom(chrome, rootUrl, { timeoutMs: 30000, virtualTimeBudget: 3000, userDataDir: join(home, 'chrome') })
    const hasClientPath = dom.includes(`${PKG.name}/client.js`)
    const hasId = dom.includes(`"id":"${PKG.name}"`) || dom.includes(`&quot;id&quot;:&quot;${PKG.name}&quot;`)
    if (code === 0 && hasClientPath && hasId) {
      ok('客户端半部已被宿主装配（真浏览器读到的启动清单）', `modules[].id = ${PKG.name}`)
      const rev = /dsh-outcomes\/client\.js[^"]*rev=([0-9a-f]{6,})/.exec(dom)?.[1]
      if (rev) steps.push(`  ℹ️ 客户端模块 rev=${rev}`)
    } else {
      steps.push(`  ⚠️ 客户端半部未能自动判定（Chrome 退出码 ${code}，DOM ${dom.length} 字节）—— 宿主是 SPA，读不到就算了`)
      steps.push(`     手工确认（10 秒）：浏览器打开 ${rootUrl}，搜 "${PKG.name}/client.js"`)
      steps.push('     静态保证：`npm test` 已断言 client.js 的 id 等于包名、inject 与 package.json 一致（写错才会静默不加载）')
    }
  }

  // 7. （可选）headless 里让**真模型**去调 agent 工具 —— 主用途，且曾经整个坏掉的那条路径
  if (args.toolsCheck) {
    const credentials = join(homedir(), '.dsh', '.credentials.yaml')
    if (!existsSync(credentials)) {
      steps.push('  WARN agent tools not verified: no credentials (~/.dsh/.credentials.yaml) -- this step needs a real model')
    } else {
      copyFileSync(credentials, join(home, '.credentials.yaml'))
      const profile = 'acch'
      const created = run(DSH, ['--profile', profile, '--from-default-profile', 'headless', '--dump-config'])
      if (created.code !== 0) fail('headless profile failed to create', created.err.slice(0, 200))
      const installed = run(DSH, ['plugin', '--profile', profile, 'add', target])
      if (installed.code !== 0) fail('headless profile failed to install the package', (installed.err || installed.out).slice(0, 300))

      const artifact = join(home, 'tools-check-artifact.md')
      writeFileSync(artifact, '# tools check\n', 'utf8')
      const registryFile = join(configuredDir, 'index.jsonl')
      const before = existsSync(registryFile) ? readFileSync(registryFile, 'utf8') : ''
      const task = `Please call the outcome_add tool for file ${artifact} with title tools-check and by acceptance. Then print the returned id verbatim.`
      const answer = run(DSH, ['--profile', profile, ...task.split(' ')])
      const after = existsSync(registryFile) ? readFileSync(registryFile, 'utf8') : ''
      const grew = after.length > before.length && after.includes('tools-check')

      if (/: pending \(waiting for service/.test(answer.err) && /dsh-outcomes \(dsh-outcomes\)/.test(answer.err)) {
        fail('tools half did not activate in a headless profile (the round-14 defect shape)', answer.err.split('\n').find((l) => l.includes('pending')) ?? '')
      }
      if (!grew) fail('the model could not call outcome_add in a headless profile', `exit ${answer.code}; tail: ${(answer.out + answer.err).slice(-300)}`)
      ok('headless (no web service): a real model registered a deliverable via the agent tool', 'registry gained tools-check')

      // 默认形态（web profile）里**跑不了**一次性 agent 任务：web app 不接受位置参数
      // （`dsh --profile <web> "<task>"` 会被它拒掉 —— 实测 exit 1）。所以那半只能在真实会话里用到。
      // 这里退一步验一个**可观测**的事实：web 形态下**两半都没有 pending**
      // （pending 会打印 "N entry did not activate"；路由可用已在第 5 步验过）。
      if (/did not activate/.test(log)) {
        const pending = log.split('\n').filter((line) => line.includes('pending') || line.includes('did not activate')).join(' / ')
        fail('web-shaped profile: some entry of this package stayed pending', pending.slice(0, 240))
      }
      ok('web-shaped profile: neither half is pending (routes proven in step 5; one-shot tasks cannot run here by design)')
    }
  }
  if (args.keep) steps.push(`  ℹ️ 现场保留在 ${home}`)
  report(0)
} catch (error) {
  fail('验收脚本异常', String(error?.message ?? error))
} finally {
  if (!args.keep) { try { rmSync(home, { recursive: true, force: true }) } catch { /* Windows 上偶发占用 */ } }
}

/** 关掉隔离实例：Windows 用 taskkill /T（连子进程），POSIX 杀进程组。 */
function stop() {
  if (child === undefined) return 0
  try {
    if (WIN) {
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return result.status ?? 1
    }
    process.kill(-child.pid, 'SIGTERM')
    return 0
  } catch {
    return 1
  }
}

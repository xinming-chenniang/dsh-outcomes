#!/usr/bin/env node
/**
 * 生成 README 用的截图（**真的跑起来再拍**，不是摆拍）。
 *
 *   node tools/screenshots.mjs [--chrome <路径>] [--out assets/screenshots] [--width 1440] [--height 900]
 *
 * 做法：
 *   1. 造一个临时数据目录 + 一组**假的分发文件**（报告 / 数据集 / 笔记 / 一个已被删掉的文件）
 *   2. 用真的 `apply()` 把插件路由挂到本机临时端口（与 e2e 测试同一套方式）
 *   3. 用 headless Chrome 打开管理页，`--screenshot` 存 PNG（中英各一张）
 *   4. 写 `screenshots.json`（清单，随包发布），最后关服务、删临时目录
 *
 * 为什么值得单独一个脚本：README 里的图最容易"过期"，因为没人愿意重拍。
 * 这条命令让重拍的成本变成 10 秒 —— 图过期了就跑一遍。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, ROUTE_PREFIX } from '../lib/index.js'
import { createStore } from '../lib/store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const args = { chrome: '', out: join(ROOT, 'assets', 'screenshots'), width: 1440, height: 900, serve: 0 }
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--chrome') args.chrome = process.argv[++i] ?? ''
  else if (arg === '--out') args.out = resolve(process.argv[++i] ?? args.out)
  else if (arg === '--width') args.width = Number(process.argv[++i] ?? 1440)
  else if (arg === '--height') args.height = Number(process.argv[++i] ?? 900)
  // `--serve <端口>`：只起演示服务、打印地址、不截图 —— 想手工看一眼页面（或调试截图）时用。
  else if (arg === '--serve') args.serve = Number(process.argv[++i] ?? 0)
}

const CHROME_CANDIDATES = [
  args.chrome,
  process.env.CHROME_PATH ?? '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((value) => value !== '')
const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (!chrome) {
  process.stderr.write('找不到 Chrome/Chromium。用 --chrome <路径> 指定，或设 CHROME_PATH。\n')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 跑一次 Chrome 并等它退出。
 *
 * **不能用 `spawnSync`**：演示服务就跑在本进程的事件循环里，同步等待会把事件循环整个卡住 ——
 * 于是 Chrome 请求页面永远拿不到响应，脚本挂到超时（实测卡满 120 秒，退出 signal=SIGTERM）。
 * 这个坑很像"Chrome 有问题"，其实是自己把服务器饿死了。
 */
function runChrome(command, argv, timeoutMs = 120000) {
  return new Promise((resolve_) => {
    const child = spawn(command, argv, { stdio: 'ignore' })
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, timeoutMs)
    child.on('error', () => { clearTimeout(timer); resolve_({ code: null, signal: 'spawn-error' }) })
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve_({ code, signal }) })
  })
}
function seed(dir) {
  const files = join(dir, 'files')
  mkdirSync(join(files, 'reports'), { recursive: true })
  mkdirSync(join(files, 'data'), { recursive: true })
  mkdirSync(join(files, 'exports'), { recursive: true })

  const report = join(files, 'reports', 'q3-revenue.html')
  writeFileSync(report, `<!doctype html><meta charset="utf-8">
<style>body{font:13px/1.5 -apple-system,"Segoe UI",sans-serif;margin:18px;color:#1c2126}
h1{font-size:16px;margin:0 0 10px}table{border-collapse:collapse}td,th{border:1px solid #e0e4ea;padding:4px 10px;text-align:right}
th{background:#f6f8fa;text-align:left}td:first-child,th:first-child{text-align:left}</style>
<h1>Q3 revenue — by channel</h1>
<table><tr><th>Channel</th><th>Revenue</th><th>Δ QoQ</th></tr>
<tr><td>Direct</td><td>412,300</td><td>+8.1%</td></tr>
<tr><td>Partners</td><td>188,940</td><td>+2.4%</td></tr>
<tr><td>Retail</td><td>96,120</td><td>−3.7%</td></tr></table>`)
  const csv = join(files, 'data', 'numbers.csv')
  writeFileSync(csv, 'month,units,revenue\n2026-07,1204,402300\n2026-08,1310,455900\n2026-09,1188,412100\n')
  const notes = join(files, 'notes', 'readme.md')
  mkdirSync(join(files, 'notes'), { recursive: true })
  writeFileSync(notes, '# Notes\n\nNumbers reconciled against the ledger on 2026-10-14.\n')

  const store = createStore({ dir: join(dir, 'data-outcomes'), cwd: files, env: {}, treatSystemTempAsWarning: false })
  // 顺序有讲究：清单按 `at` 倒序、页面自动选中第一条 —— **最后加的**要放那条能预览的网页报告，
  // 否则 README 截图右侧会是"没有可预览的内容"。
  store.add({ title: 'Old export (file already gone)', paths: join(files, 'exports', 'q3-old.pdf'), by: 'archive', note: 'Kept as a registration; the file itself was cleaned up.', allowMissing: true })
  store.add({ title: 'Reconciliation notes', paths: notes, by: 'finance' })
  store.add({ title: 'Raw monthly numbers', paths: csv, by: 'finance', note: 'Feeds the report above — regenerate with `npm run report`.' })
  store.add({ title: 'Q3 revenue — by channel', paths: report, by: 'finance', note: 'Reconciled against the ledger on 2026-10-14; tax inclusive.' })
  return { store, files }
}

function mount(store, port = 0) {
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn() },
    get() { return undefined },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  apply(ctx, { dir: store.dir, treatSystemTempAsWarning: false })
  const server = createServer((req, res) => {
    const match = routes.find((route) => route.kind === 'prefix' && (req.url ?? '').startsWith(route.path))
    if (!match) { res.writeHead(404).end('no route'); return }
    match.handler(req, res)
  })
  return new Promise((resolve_) => {
    server.listen(port, '127.0.0.1', () => resolve_({ server, port: server.address().port }))
  })
}

// 演示数据放项目内而不是系统临时目录：截图里会显示路径，C:\Users\<用户名> 不该出现在发布出去的图上。
const root = mkdtempSync(join(ROOT, '.demo-tmp-'))
const shots = []
let server
try {
  const { store } = seed(root)
  const mounted = await mount(store)
  server = mounted.server
  const base = `http://127.0.0.1:${mounted.port}${ROUTE_PREFIX}/`

  if (args.serve) {
    // 手工看页面用：换到用户指定端口（或就用随机端口），打印地址后**保持运行**。
    if (args.serve !== mounted.port) {
      await new Promise((r) => server.close(r))
      const again = await mount(store, args.serve)
      server = again.server
    }
    const port = args.serve || mounted.port
    process.stdout.write(`演示服务已起：http://127.0.0.1:${port}${ROUTE_PREFIX}/  （Ctrl+C 结束；数据目录 ${store.dir}）\n`)
    await new Promise(() => {})   // 挂住，等人工 Ctrl+C
  }

  mkdirSync(args.out, { recursive: true })

  for (const [lang, name] of [['en', 'manager-en.png'], ['zh', 'manager-zh.png']]) {
    const out = join(args.out, name)
    // `--user-data-dir` **必须有**：本机 Chrome 通常已经在跑，不给独立 profile 时新进程会把请求
    // 交给已有实例，然后自己退出 —— 结果是"命令成功、图没生成"。踩过一次。
    const profile = join(root, `chrome-${lang}`)
    // Chrome 的 stdout/stderr 走**文件描述符**而不是管道：它的 updater 会持续刷错误，
    // 管道模式下曾把进程挂住（实测 120 秒不返回）。落文件同时也留下可查的诊断。
    const logOut = openSync(join(root, `chrome-${lang}.out.log`), 'w')
    const logErr = openSync(join(root, `chrome-${lang}.err.log`), 'w')
    const result = await runChrome(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
      `--user-data-dir=${profile}`,
      `--window-size=${args.width},${args.height}`,
      '--virtual-time-budget=4000',
      `--screenshot=${out}`,
      lang === 'en' ? base : `${base}?lang=zh`,
    ])
    closeSync(logOut)
    closeSync(logErr)
    if (!existsSync(out)) {
      const tail = (file) => { try { return readFileSync(file, 'utf8').slice(-300) } catch { return '' } }
      process.stderr.write(`截图失败（${lang}）\n  exit: ${result.status} (signal ${result.signal})\n  out: ${tail(join(root, `chrome-${lang}.out.log`))}\n  err: ${tail(join(root, `chrome-${lang}.err.log`))}\n`)
      process.exit(1)
    }
    shots.push({ lang, path: `assets/screenshots/${name}`, page: lang === 'en' ? '/__dsh-outcomes/' : '/__dsh-outcomes/?lang=zh' })
    process.stdout.write(`  ✓ ${name}\n`)
  }

  writeFileSync(join(ROOT, 'screenshots.json'), JSON.stringify(shots, null, 2) + '\n', 'utf8')
  process.stdout.write(`  ✓ screenshots.json（${shots.length} 张）\n`)
} finally {
  if (server) await new Promise((r) => server.close(r))
  rmSync(root, { recursive: true, force: true })
}

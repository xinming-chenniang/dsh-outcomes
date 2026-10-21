/**
 * Chrome 的小封装（截图工具与装载验收共用）。
 *
 * 两条实测教训就写在这里，免得下次再踩：
 * 1. **必须给 `--user-data-dir`**：本机 Chrome 通常已经在跑，不给独立 profile 时新进程会把请求
 *    交给已有实例然后自己退出 —— 表现为"命令成功、图没生成"。
 * 2. **不能用 `spawnSync`**：调用方往往在同一个事件循环里跑着一个本地 HTTP 服务（截图/验收都是），
 *    同步等待会把事件循环卡死，Chrome 请求页面永远等不到响应，最后被超时杀掉。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 常见安装位置 + 环境变量；找不到返回 undefined（调用方决定是降级还是报错）。 */
export function findChrome(explicit = '') {
  const candidates = [
    explicit,
    process.env.CHROME_PATH ?? '',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((value) => value !== '')
  return candidates.find((candidate) => existsSync(candidate))
}

/** 跑一次 Chrome 并等它退出；返回 { code, signal, stdout, stderr }。 */
export function runChrome(chrome, argv, { timeoutMs = 120000, capture = false, userDataDir } = {}) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      `--user-data-dir=${userDataDir ?? join(tmpdir(), `dsh-chrome-${process.pid}-${Math.random().toString(16).slice(2, 8)}`)}`,
      ...argv,
    ]
    const child = spawn(chrome, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, signal: 'spawn-error', stdout, stderr: String(error?.message ?? error) }) })
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }) })
  })
}

/**
 * 用浏览器取一份渲染后的 DOM。
 * 走浏览器而不是 `fetch`：宿主的 Web 入口有浏览器信任围栏，脚本直连会 401（实测），
 * 而带 token 的 URL 在真浏览器里能正常打开。
 */
export async function dumpDom(chrome, url, { timeoutMs = 90000, userDataDir, virtualTimeBudget = 5000 } = {}) {
  const result = await runChrome(chrome, [`--virtual-time-budget=${virtualTimeBudget}`, '--dump-dom', url], {
    timeoutMs, capture: true, userDataDir,
  })
  return { ...result, dom: result.stdout }
}

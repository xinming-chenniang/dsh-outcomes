#!/usr/bin/env node
/**
 * 守卫体检（guard check）—— **故意把包改坏，看守卫会不会叫**。
 *
 *   node tools/guard-check.mjs
 *
 * 为什么需要它：第 24 轮的真实教训是"扫描器报干净，但规则本身有盲区" —— 那处真泄漏就躺在随包里。
 * 也就是说：**"检查通过" 只有在"检查能失败"的前提下才有意义**。这个脚本对每一类该被拦住的问题
 * 各造一个变体（在**临时副本**上，绝不动真包），然后看 `npm test` 与 `npm run check` 是否报错。
 *
 * 判据：每个变体都必须被**至少一个**守卫抓住。抓不住的会以 `✗ 漏网` 列出，退出码 1。
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = join(tmpdir(), `dsh-outcomes-guards-${process.pid}`)

/** 变体用的"泄漏样本"在**运行时拼**出来：本文件是要被自己的扫描器扫的，
 *  直接写字面量会让"守卫体检"自己变成一个泄漏（第 26 轮实测被自己的规则拦下）。 */
const LEAK_SAMPLE = ['C:', '\\Users', '\\someone', '\\AppData', '\\Local'].join('')

/** 每个变体：改哪个文件、怎么改、期望被谁抓（只用于报告）。 */
const MUTATIONS = [
  {
    name: '随包文件里写入真实用户名路径',
    file: 'lib/kind.js',
    mutate: (text) => `${text}\n// leaked: ${LEAK_SAMPLE}\n`,
    expect: '泄漏扫描（check.mjs / shipped.test）',
  },
  {
    name: '客户端 half 的 id 与包名不一致（宿主会静默不加载）',
    file: 'lib/client.js',
    mutate: (text) => text.replace("id: 'dsh-outcomes'", "id: 'dsh-outcomes-typo'"),
    expect: 'client 相关测试',
  },
  {
    name: '工具改名但文档没跟（说明书漂移）',
    file: 'lib/tools.js',
    mutate: (text) => text.replace("name: 'outcome_list'", "name: 'outcome_list_renamed'"),
    expect: 'docs.test（工具名序列）',
  },
  {
    name: '宿主路由前缀改了、客户端没跟（按钮会 403）',
    file: 'lib/index.js',
    mutate: (text) => text.replace("ROUTE_PREFIX = '/__dsh-outcomes'", "ROUTE_PREFIX = '/__dsh-outcomes-v2'"),
    expect: 'client-render.test（常量交叉核对）',
  },
  {
    name: 'files 白名单里写了一个不存在的文件',
    file: 'package.json',
    mutate: (text) => text.replace('"files": [', '"files": [\n    "lib/does-not-exist.js",'),
    expect: 'shipped.test（白名单逐项存在）',
  },
  {
    name: '工具 half 又被改成依赖 webServer（第 14 轮的缺陷形态）',
    file: 'lib/tools.js',
    mutate: (text) => text.replace("export const inject = ['tools']", "export const inject = ['webServer']"),
    expect: 'shipped.test（两半 inject 结构）',
  },
  {
    name: 'README 里的截图被删掉',
    file: 'assets/screenshots/manager-en.png',
    mutate: null,   // 特殊：删文件
    expect: 'shipped.test（截图存在 / screenshots.json 一致）',
  },
]

rmSync(WORK, { recursive: true, force: true })
cpSync(ROOT, WORK, { recursive: true, filter: (src) => !/node_modules|\.git$/.test(src) })

function run(command, argv) {
  return spawnSync(command, argv, { cwd: WORK, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] })
}

// ---------------------------------------------------------------- 基线
// 未改动的副本必须**自己先绿**。否则下面每个变体都会"被抓住"——那不是守卫在叫，
// 而是**测试入口本身坏了**（2026-10-18 补：本页实测 `package.json` 的
// `node --test test/` 在 Node 24 上直接报 MODULE_NOT_FOUND，那种情形下
// "变体全部被抓住"是假绿，且看不出问题）。
const baselineTests = run(process.execPath, ['--test'])
const baselineCheck = run(process.execPath, ['tools/check.mjs'])
if (baselineTests.status !== 0 || baselineCheck.status !== 0) {
  rmSync(WORK, { recursive: true, force: true })
  writeSync(1, [
    '',
    '守卫体检：基线不绿，结论无效',
    '',
    `  node --test        exit ${baselineTests.status}`,
    `  tools/check.mjs    exit ${baselineCheck.status}`,
    '',
    '先把基线修绿再跑本脚本；否则"变体全部被抓住"只证明测试入口坏了，不证明守卫有效。',
    '',
  ].join('\n'))
  process.exit(2)
}

const results = []
for (const mutation of MUTATIONS) {
  // 先还原该文件（上一轮变体可能改的就是它）
  if (mutation.mutate === null) {
    const target = join(WORK, mutation.file)
    if (existsSync(target)) rmSync(target, { force: true })
  } else {
    cpSync(join(ROOT, mutation.file), join(WORK, mutation.file))
    const before = readFileSync(join(WORK, mutation.file), 'utf8')
    const after = mutation.mutate(before)
    if (after === before) {
      results.push({ ...mutation, caught: false, by: '（变体没生效：锚点没匹配上，脚本要修）' })
      continue
    }
    writeFileSync(join(WORK, mutation.file), after, 'utf8')
  }

  const tests = run(process.execPath, ['--test'])
  const check = run(process.execPath, ['tools/check.mjs'])
  const by = []
  if (tests.status !== 0) by.push('npm test')
  if (check.status !== 0) by.push('npm run check')
  results.push({ ...mutation, caught: by.length > 0, by: by.join(' + ') || '（无人发现）' })

  // 还原全部改动，进入下一个变体
  if (mutation.mutate === null) cpSync(join(ROOT, mutation.file), join(WORK, mutation.file))
  else cpSync(join(ROOT, mutation.file), join(WORK, mutation.file))
}

rmSync(WORK, { recursive: true, force: true })

process.stdout.write('\n守卫体检：把包改坏，看守卫会不会叫\n\n')
let escaped = 0
for (const r of results) {
  const mark = r.caught ? '✓ 被抓住' : '✗ 漏网  '
  if (!r.caught) escaped++
  process.stdout.write(`  ${mark}  ${r.name}\n            期望：${r.expect}\n            实际：${r.by}\n`)
}
process.stdout.write(escaped === 0
  ? `\n${results.length} 个变体全部被抓住：这些守卫不是摆设。\n\n`
  : `\n有 ${escaped} 个变体漏网 —— 说明对应守卫形同虚设，要修。\n\n`)
process.exitCode = escaped === 0 ? 0 : 1

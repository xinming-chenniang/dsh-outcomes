#!/usr/bin/env node
/**
 * 仓库自检（`npm run check`）。三件事，都不需要 DSH：
 *
 *   1. 语法：`lib/` `bin/` `tools/` `test/` 下每个 js/mjs 过 `node --check`
 *      （子进程用 `stdio: 'ignore'`：受限沙箱里管道 stdio 会 EPERM，本机踩过）
 *   2. 冒烟：CLI 在一个**临时数据目录**上跑 `add → list → check → stats → remove → restore → dir`
 *      —— 断言退出码与关键输出，绝不碰真实清单
 *   3. 泄漏扫描：随包文本里不许出现个人绝对路径 / 本机专有名词 / 会话 id
 *
 * 退出码：0 全过；1 有失败。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative } from 'node:path'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function ok(label) { notes.push(`  ✓ ${label}`) }
function bad(label, detail) { failures.push(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }

// ------------------------------------------------------------------ 1. 语法
const SCAN_DIRS = ['lib', 'bin', 'tools', 'test']
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}
const scripts = SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir))).filter((file) => ['.js', '.mjs'].includes(extname(file)))
let syntaxBad = 0
for (const file of scripts) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' })
  } catch {
    syntaxBad++
    bad('语法', relative(ROOT, file))
  }
}
if (syntaxBad === 0) ok(`${scripts.length} 个脚本通过 node --check`)

// ------------------------------------------------------------------ 2. CLI 冒烟
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-outcomes-check-'))
function cli(args, expectCode = 0) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'bin', 'dsh-outcomes.mjs'), '--dir', sandbox, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (expectCode !== 0) bad(`CLI ${args[0]}`, `期望退出码 ${expectCode}，实际 0`)
    return out
  } catch (error) {
    const code = error.status ?? 1
    if (code !== expectCode) bad(`CLI ${args[0]}`, `期望退出码 ${expectCode}，实际 ${code}：${String(error.stderr ?? '').slice(0, 200)}`)
    return String(error.stdout ?? '')
  }
}
try {
  const target = join(sandbox, 'artifact.md')
  writeFileSync(target, '# hello\n')
  const added = cli(['add', '--title', 'Smoke artifact', '--paths', target, '--by', 'check'])
  const id = /已登记 (\S+)/.exec(added)?.[1]
  if (!id) bad('CLI add', `输出里没看到 id：${added.trim().slice(0, 120)}`)
  else {
    cli(['list'])
    cli(['check'])
    cli(['stats'])
    cli(['list', '--json'])
    cli(['remove', id, '--why', 'smoke'])
    cli(['restore', id])
    const dir = cli(['dir']).trim()
    if (dir !== sandbox) bad('CLI dir', `期望 ${sandbox}，实际 ${dir}`)
    // 文件必须原地不动
    if (!existsSync(target)) bad('CLI remove', '把文件删掉了（不该发生）')
    else ok('CLI 冒烟：add → list → check → stats → remove → restore → dir，文件未被触碰')
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

// ------------------------------------------------------------------ 3. 泄漏扫描
const FORBIDDEN = [
  [/[A-Za-z]:\\\\?dsh/i, '个人绝对路径（本机盘符 + dsh）'],
  [/控制台中心/, '本机目录名'],
  [/个人项目/, '本机目录名'],
  // 只看"路径语境"里的用户名：GitHub 账号名里出现同样几位数字是公开信息，不是泄漏。
  // ⚠️ 分隔符要容忍 **1~2 个**：JS 源码里的路径是转义的（`C:\\Users\\<名>\\`），
  // 只写一个分隔符的规则会**永远匹配不上**（第 24 轮实测的盲区）。
  [/[\\/]{1,2}Users[\\/]{1,2}28402\b/i, '本机用户目录'],
  // 通用规则：任何 Windows 用户目录（不管用户名是什么）都不该出现在随包文件里。
  [/[A-Za-z]:[\\/]{1,2}[Uu]sers[\\/]{1,2}[A-Za-z0-9._-]+/, 'Windows 用户目录（写死了用户名）'],
  [/session-[0-9a-f]{8}-/, '真实会话 id'],
  [/dsh-worklog/, '本机仓库名'],
  [/\.dsh-kb-sync/, '本机另一个插件的数据文件'],
]
const SHIPPED = ['lib', 'bin', 'tools', 'docs'].flatMap((dir) => walk(join(ROOT, dir)))
  .concat(['README.md', 'README.en.md', 'CHANGELOG.md', 'package.json', 'cordis.patch.yml', 'config.example.json']
    .map((file) => join(ROOT, file)))
  // 规则表自己就写着这些禁忌串，当然会被自己匹配到 —— 跳过它们（不是掩盖，是规则的定义处）。
  .filter((file) => !['check.mjs', 'forbidden.mjs'].includes(basename(relative(ROOT, file))))
const leaks = []
for (const file of SHIPPED) {
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const [pattern, label] of FORBIDDEN) {
    const match = pattern.exec(text)
    if (match) leaks.push(`${relative(ROOT, file)}: ${label} (${match[0]})`)
  }
}
if (leaks.length) bad('泄漏扫描', `\n      ${leaks.join('\n      ')}`)
else ok(`泄漏扫描（${SHIPPED.length} 个随包文件）没有本机专有内容`)

// ------------------------------------------------------------------ 汇总
process.stdout.write('\ndsh-outcomes check\n')
for (const line of notes) process.stdout.write(line + '\n')
for (const line of failures) process.stdout.write(line + '\n')
process.stdout.write(failures.length ? `\n${failures.length} 项失败\n` : '\n全部通过\n')
process.exitCode = failures.length ? 1 : 0

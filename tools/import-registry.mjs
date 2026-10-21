#!/usr/bin/env node
/**
 * 一次性迁移：把**旧格式**的成果清单导进新清单。
 *
 *   node tools/import-registry.mjs --from <旧 index.jsonl> [--deleted <旧 deleted.jsonl>] --dir <目标目录>
 *                                 [--dry-run] [--force] [--json]
 *
 * 设计原则（都是"迁移"这件事的固有要求）：
 * - **id 原样保留**：旧清单里的 id 可能已经写在文档、提交信息、别的页面上，换 id 等于断链。
 * - **文件缺失不丢条目**：历史记录的价值在于"当年登记过"。缺文件的条目照常导入，
 *   由 `dsh-outcomes check` 事后报告（`--dry-run` 会先把缺文件数摆出来）。
 * - **不覆盖**：目标清单已存在且非空时**拒绝**执行；`--force` 也只做"按 id 去重后追加"，
 *   不重写、不删任何已有行。
 * - **幂等**：同一份旧清单导两次，第二次全是 skipped。
 *
 * 旧格式（个人控制台版）与新格式的字段对应：
 *   `session` → `sessionId`；`path`（单个）→ `paths: [path]`；缺 `kind` 时按扩展名补算；
 *   `removedAt` / `why` 原样进删除日志。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createStore } from '../lib/store.js'
import { kindOf } from '../lib/kind.js'

function parseArgs(argv) {
  const out = { from: '', deleted: '', dir: '', dryRun: false, force: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--from') out.from = argv[++i] ?? ''
    else if (arg === '--deleted') out.deleted = argv[++i] ?? ''
    else if (arg === '--dir') out.dir = argv[++i] ?? ''
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--force') out.force = true
    else if (arg === '--json') out.json = true
    else if (arg === '-h' || arg === '--help') out.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return out
}

const USAGE = `把旧格式的成果清单导入新清单

  node tools/import-registry.mjs --from <旧 index.jsonl> [--deleted <旧 deleted.jsonl>] --dir <目标目录>
                                [--dry-run] [--force] [--json]

  --from     旧清单（一行一条 JSON；来自个人控制台版的 index.jsonl）
  --deleted  旧的删除留档（可选；导入后仍可 restore）
  --dir      目标数据目录（新清单放这里）
  --dry-run  只报告要导什么，不写盘
  --force    目标非空时也继续（按 id 去重后追加，绝不重写已有行）

id 原样保留；缺文件的条目照常导入（用 dsh-outcomes check 事后报告）。`

function readJsonl(file) {
  const rows = []
  const errors = []
  let line = 0
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    line++
    const text = raw.trim()
    if (text === '') continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push(parsed)
      else errors.push({ line, error: 'not-an-object' })
    } catch (error) {
      errors.push({ line, error: String(error?.message ?? error) })
    }
  }
  return { rows, errors }
}

/** 旧条目 → 新条目（幂等：字段已在新格式里就原样保留）。 */
function convert(row) {
  const paths = Array.isArray(row.paths) ? row.paths.map(String) : (row.path ? [String(row.path)] : [])
  const entry = {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    kind: typeof row.kind === 'string' && row.kind !== '' ? row.kind : kindOf(paths[0] ?? ''),
    paths,
    by: String(row.by ?? ''),
    note: String(row.note ?? ''),
    sessionId: String(row.sessionId ?? row.session ?? ''),
    cwd: String(row.cwd ?? ''),
    at: String(row.at ?? row.createdAt ?? ''),
  }
  if (typeof row.removedAt === 'string') entry.removedAt = row.removedAt
  if (typeof row.why === 'string') entry.why = row.why
  return entry
}

const args = (() => {
  try { return parseArgs(process.argv.slice(2)) } catch (error) { process.stderr.write(`  ✗ ${error.message}\n${USAGE}\n`); process.exit(2) }
})()

if (args.help === true || args.from === '' || args.dir === '') {
  process.stdout.write(USAGE + '\n')
  process.exit(args.help === true ? 0 : 2)
}
if (!existsSync(args.from)) {
  process.stderr.write(`  ✗ 找不到旧清单：${args.from}\n`)
  process.exit(2)
}

const store = createStore({ dir: args.dir })
const old = readJsonl(args.from)
const oldDeleted = args.deleted !== '' && existsSync(args.deleted) ? readJsonl(args.deleted) : { rows: [], errors: [] }

const existing = new Set(store.list({ state: 'all' }).map((row) => row.id))
const existingDeleted = new Set(store.deleted().map((row) => row.id))
const targetNonEmpty = existing.size > 0 || existingDeleted.size > 0

const report = {
  from: args.from,
  dir: store.dir,
  target: store.registry,
  dryRun: args.dryRun,
  active: { read: old.rows.length, imported: 0, skipped: 0, missingFiles: 0, badId: 0 },
  deleted: { read: oldDeleted.rows.length, imported: 0, skipped: 0 },
  parseErrors: [...old.errors, ...oldDeleted.errors].length,
}

// 先算出"到底要写什么"，再决定拦不拦 —— 这样"同一份清单导第二次"是一次**无害的空跑**，
// 而不是被"目标非空"挡住（幂等要能用，否则脚本没法重跑）。
const pendingDeleted = []
for (const row of oldDeleted.rows) {
  const entry = convert(row)
  if (entry.id === '' || existingDeleted.has(entry.id)) { report.deleted.skipped++; continue }
  if (!entry.removedAt) entry.removedAt = new Date().toISOString()
  if (!entry.why) entry.why = 'imported'
  pendingDeleted.push(entry)
}

const pendingActive = []
for (const row of old.rows) {
  const entry = convert(row)
  if (entry.id === '' || entry.paths.length === 0) { report.active.badId++; continue }
  if (existing.has(entry.id)) { report.active.skipped++; continue }
  report.active.missingFiles += entry.paths.filter((file) => !existsSync(file)).length
  pendingActive.push(entry)
}

const hasWork = pendingActive.length > 0 || pendingDeleted.length > 0
if (targetNonEmpty && hasWork && !args.force && !args.dryRun) {
  process.stderr.write(`  ✗ 目标清单非空（${existing.size} 条在用 / ${existingDeleted.size} 条已删除）：${store.registry}\n`)
  process.stderr.write('    迁移请用空目录；确实要并入已有清单就加 --force（只按 id 去重后追加）。\n')
  process.stderr.write(`    本次要导入 ${pendingActive.length} 条在用 / ${pendingDeleted.length} 条删除留档。\n`)
  process.exit(1)
}

if (!args.dryRun) {
  for (const entry of pendingDeleted) { store.appendRaw(entry, { deleted: true }); report.deleted.imported++ }
  for (const entry of pendingActive) { store.appendRaw(entry); report.active.imported++ }
}

if (args.json) {
  process.stdout.write(JSON.stringify({ ...report, wouldImport: { active: pendingActive.length, deleted: pendingDeleted.length } }, null, 2) + '\n')
} else {
  process.stdout.write(`\n  旧清单：${report.from}\n  目标　：${report.target}${args.dryRun ? '（dry-run，未写盘）' : ''}\n`)
  process.stdout.write(`  在用条目：读到 ${report.active.read} → ${args.dryRun ? '将导入' : '导入'} ${args.dryRun ? pendingActive.length : report.active.imported}，跳过（已存在）${report.active.skipped}\n`)
  if (report.active.badId) process.stdout.write(`  ⚠️ 缺 id 或缺 paths 被跳过：${report.active.badId}\n`)
  if (report.deleted.read) process.stdout.write(`  删除留档：读到 ${report.deleted.read} → ${args.dryRun ? '将导入' : '导入'} ${args.dryRun ? pendingDeleted.length : report.deleted.imported}，跳过 ${report.deleted.skipped}\n`)
  if (report.active.missingFiles) process.stdout.write(`  ⚠️ 有 ${report.active.missingFiles} 个登记的文件现在已经不在（条目照常导入，用 check 查看）\n`)
  if (report.parseErrors) process.stdout.write(`  ⚠️ 有 ${report.parseErrors} 行解析失败被跳过\n`)
  process.stdout.write(args.dryRun ? '  没有写任何文件。\n\n' : '  完成。\n\n')
}

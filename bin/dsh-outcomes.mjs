#!/usr/bin/env node
/**
 * dsh-outcomes CLI —— 不依赖 DSH 也能用（脚本、CI、别的 agent 都能调它）。
 *
 *   dsh-outcomes add --title "季度报告" --paths "a.html;b.csv" [--by 来源] [--note 口径]
 *   dsh-outcomes list [--q 关键词] [--kind html] [--state active|deleted|all] [--limit 20]
 *   dsh-outcomes check            # 有没有登记的文件已经不在了（缺失 → 退出码 1）
 *   dsh-outcomes remove <id> [--why "换版本了"]
 *   dsh-outcomes restore <id>
 *   dsh-outcomes deleted
 *   dsh-outcomes stats
 *   dsh-outcomes dir              # 打印当前生效的数据目录（给脚本用）
 *
 * 全局开关：`--dir <路径>` 覆盖数据目录、`--json` 机器可读输出。
 * 数据目录解析顺序见 `lib/paths.js`（config → DSH_OUTCOMES_DIR 等环境变量 → 用户设置文件 → 默认）。
 */
import { parseArgs } from 'node:util'
import { createStore } from '../lib/store.js'
import { kindLabel } from '../lib/kind.js'

const USAGE = `dsh-outcomes —— DSH 成果清单的 CLI

用法：
  dsh-outcomes add --title <标题> --paths <路径[;路径…]> [--by <来源>] [--note <说明>]
                   [--kind <类型>] [--allow-missing] [--session <会话 id>]
  dsh-outcomes list [--q <关键词>] [--kind <类型>] [--state active|deleted|all] [--limit <n>]
  dsh-outcomes check
  dsh-outcomes remove <id> [--why <原因>]
  dsh-outcomes restore <id>
  dsh-outcomes deleted
  dsh-outcomes stats
  dsh-outcomes dir

全局：--dir <数据目录>  --json
文档：包内 README.md 与 docs/（安装、配置、安全模型、已知限制）
`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: 'string' },
    paths: { type: 'string' },
    by: { type: 'string' },
    note: { type: 'string' },
    kind: { type: 'string' },
    session: { type: 'string' },
    why: { type: 'string' },
    q: { type: 'string' },
    state: { type: 'string' },
    limit: { type: 'string' },
    dir: { type: 'string' },
    json: { type: 'boolean', default: false },
    'allow-missing': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

const json = values.json === true
const command = positionals[0] ?? ''
const store = createStore({
  dir: values.dir,
  config: {},
  cwd: process.cwd(),
})

function out(value) {
  if (json) process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

function fail(result) {
  if (json) out(result)
  else process.stderr.write(`  ✗ ${result.error}${result.id ? ` (${result.id})` : ''}\n`)
  process.exitCode = result.error === 'usage' ? 2 : 1
}

function humanRow(row) {
  const missing = row.missing?.length ? ` ⚠️ 缺 ${row.missing.length}` : ''
  const at = String(row.removedAt ?? row.at ?? '').slice(0, 16).replace('T', ' ')
  const by = row.by ? ` · ${row.by}` : ''
  const note = row.note ? ` — ${row.note}` : ''
  return `  ${row.id}  ${at}  [${kindLabel(row.kind, 'zh')}] ${row.title}${by}${note}${missing}\n      ${(row.paths ?? []).join('\n      ')}`
}

if (values.help === true || command === '' || command === 'help') {
  process.stdout.write(USAGE)
  process.exitCode = command === '' ? 0 : 0
} else if (command === 'dir') {
  if (json) out({ dir: store.dir, registry: store.registry, deleted: store.deletedFile, sources: store.sources })
  else process.stdout.write(store.dir + '\n')
} else if (command === 'add') {
  const paths = typeof values.paths === 'string' ? values.paths : ''
  if (paths.trim() === '' || typeof values.title !== 'string') {
    if (paths.trim() === '') fail({ error: 'usage', hint: 'add 必须有 --paths（分号分隔）' })
  }
  const result = store.add({
    title: values.title,
    paths,
    by: values.by,
    note: values.note,
    kind: values.kind,
    sessionId: values.session,
    allowMissing: values['allow-missing'] === true || values.force === true,
  })
  if (result.ok !== true) fail(result)
  else if (json) out(result)
  else {
    process.stdout.write(`  已登记 ${result.entry.id}  [${kindLabel(result.entry.kind, 'zh')}] ${result.entry.title}\n`)
    for (const path of result.entry.paths) process.stdout.write(`      ${path}\n`)
    for (const warning of result.warnings ?? []) {
      if (warning.code === 'already-registered') process.stdout.write(`  ⚠️ 同一批文件已登记过：${warning.id}（${warning.title}）\n`)
      else if (warning.code === 'missing-file') process.stdout.write(`  ⚠️ 文件此刻不存在（仍已登记）：${warning.paths.join(', ')}\n`)
      else if (warning.code === 'system-temp') process.stdout.write(`  ⚠️ 路径在系统临时目录里，随时可能被清掉：${warning.paths.join(', ')}\n`)
    }
    process.stdout.write(`  数据目录：${store.dir}\n`)
  }
} else if (command === 'list') {
  const rows = store.list({
    q: values.q ?? '',
    kind: values.kind ?? '',
    state: values.state ?? 'active',
    limit: values.limit ? Number(values.limit) : undefined,
  })
  if (json) out({ rows })
  else if (rows.length === 0) process.stdout.write('  （清单是空的）\n')
  else process.stdout.write(rows.map(humanRow).join('\n') + '\n')
} else if (command === 'deleted') {
  const rows = store.deleted()
  if (json) out({ rows })
  else if (rows.length === 0) process.stdout.write('  （没有已删除的登记）\n')
  else process.stdout.write(rows.map(humanRow).join('\n') + '\n')
} else if (command === 'check') {
  const result = store.check()
  if (json) out(result)
  else if (result.ok) process.stdout.write(`  ✓ ${result.total} 条登记，文件都在\n`)
  else {
    process.stdout.write(`  ⚠️ ${result.missing.length} 个文件不在了（登记保留，文件要你自己找回来）：\n`)
    for (const item of result.missing) process.stdout.write(`      ${item.id}  ${item.title}\n        ${item.path}\n`)
  }
  if (!result.ok) process.exitCode = 1
} else if (command === 'stats') {
  const result = store.stats()
  if (json) out(result)
  else {
    process.stdout.write(`  清单：${result.registry}\n  在用 ${result.active} 条 · 已删除登记 ${result.deleted} 条 · 缺文件 ${result.missing} 条\n`)
    for (const [kind, count] of Object.entries(result.byKind)) process.stdout.write(`    ${kindLabel(kind, 'zh')}(${kind}) ${count}\n`)
  }
} else if (command === 'remove') {
  const id = positionals[1] ?? ''
  if (id === '') fail({ error: 'usage', hint: 'remove 需要 <id>' })
  else {
    const result = store.remove(id, values.why ?? 'unregistered')
    if (result.ok !== true) fail(result)
    else if (json) out(result)
    else process.stdout.write(`  已从清单删除 ${id}（${result.entry.title}）—— 只删登记，文件原地没动\n  留档：${store.deletedFile}\n`)
  }
} else if (command === 'restore') {
  const id = positionals[1] ?? ''
  if (id === '') fail({ error: 'usage', hint: 'restore 需要 <id>' })
  else {
    const result = store.restore(id)
    if (result.ok !== true) fail(result)
    else if (json) out(result)
    else process.stdout.write(`  已放回清单 ${id}（${result.entry.title}）\n`)
  }
} else {
  fail({ error: 'usage', hint: `未知命令：${command}` })
}

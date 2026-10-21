/**
 * 迁移脚本的测试：拿"旧格式"夹具跑真实 CLI，验证
 * id 保留 / 缺文件不丢条目 / 拒绝覆盖非空目标 / 幂等 / 删除留档一起搬。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'tools', 'import-registry.mjs')

/** 造一份"个人控制台版"的旧清单（字段名刻意用旧的：session / 单数 path）。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-outcomes-import-'))
  const old = join(root, 'old')
  const data = join(root, 'new')
  mkdirSync(old, { recursive: true })
  const report = join(root, 'report.html')
  writeFileSync(report, '<h1>r</h1>')

  const rows = [
    { id: '20260101-010101', title: '季度报告', kind: 'html', paths: [report], by: '财务', note: '口径：含税', session: 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', cwd: root, at: '2026-01-01T01:01:01.000Z' },
    { id: '20260102-020202', title: '丢了的文件', paths: [join(root, 'gone.csv')], by: 'demo', at: '2026-01-02T02:02:02.000Z' },
    { id: '20260103-030303', title: '旧格式单数路径', path: report, at: '2026-01-03T03:03:03.000Z' },
  ]
  writeFileSync(join(old, 'index.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const removed = [
    { id: '20251231-235959', title: '早就取消登记的', paths: [report], removedAt: '2025-12-31T23:59:59.000Z', why: 'superseded' },
  ]
  writeFileSync(join(old, 'deleted.jsonl'), removed.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return { root, old, data, report, rows, removed }
}

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

test('导入：id 原样保留、字段映射正确、缺文件照常导入', () => {
  const { old, data, report } = fixture()
  const out = run(['--from', join(old, 'index.jsonl'), '--deleted', join(old, 'deleted.jsonl'), '--dir', data, '--json'])
  const reportJson = JSON.parse(out)
  assert.equal(reportJson.active.read, 3)
  assert.equal(reportJson.active.imported, 3)
  assert.equal(reportJson.deleted.imported, 1)
  assert.equal(reportJson.active.missingFiles, 1, '有一个文件不在，但条目仍要导入')

  const store = createStore({ dir: data })
  const rows = store.list()
  assert.equal(rows.length, 3)
  const first = rows.find((row) => row.id === '20260101-010101')
  assert.ok(first, 'id 必须原样保留')
  assert.equal(first.sessionId, 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'session → sessionId')
  assert.equal(first.kind, 'html')
  assert.equal(first.by, '财务')
  // 单数 path 也要能吃进来，并补算 kind
  const single = rows.find((row) => row.id === '20260103-030303')
  assert.deepEqual(single.paths, [report])
  assert.equal(single.kind, 'html')
  // 删除留档搬过来后仍可 restore
  assert.equal(store.deleted().length, 1)
  const back = store.restore('20251231-235959')
  assert.equal(back.ok, true)
  assert.equal(store.list().length, 4)
})

test('幂等：同一份旧清单导两次，第二次全部跳过、清单不变', () => {
  const { old, data } = fixture()
  const args = ['--from', join(old, 'index.jsonl'), '--dir', data, '--json']
  run(args)
  const before = readFileSync(join(data, 'index.jsonl'), 'utf8')
  const second = JSON.parse(run(args))
  assert.equal(second.active.imported, 0)
  assert.equal(second.active.skipped, 3)
  assert.equal(readFileSync(join(data, 'index.jsonl'), 'utf8'), before)
})

test('目标非空 → 拒绝（退出码 1，且不动任何文件）', () => {
  const { old, data, report } = fixture()
  const store = createStore({ dir: data })
  store.add({ title: 'already here', paths: report, cwd: dirname(report) })
  const before = readFileSync(store.registry, 'utf8')
  assert.throws(() => run(['--from', join(old, 'index.jsonl'), '--dir', data]), /status 1|Command failed/)
  assert.equal(readFileSync(store.registry, 'utf8'), before, '拒绝时不许改目标清单')
})

test('--force：并入已有清单，按 id 去重后追加（不重写已有行）', () => {
  const { old, data, report } = fixture()
  const store = createStore({ dir: data })
  store.add({ title: 'already here', paths: report, cwd: dirname(report) })
  const before = readFileSync(store.registry, 'utf8')
  const out = JSON.parse(run(['--from', join(old, 'index.jsonl'), '--dir', data, '--force', '--json']))
  assert.equal(out.active.imported, 3)
  const after = readFileSync(store.registry, 'utf8')
  assert.ok(after.startsWith(before), '已有行必须原样在前面')
  assert.equal(createStore({ dir: data }).list().length, 4)
})

test('--dry-run：只报告"将导入多少"，不建目录、不写文件', () => {
  const { old, data } = fixture()
  const out = JSON.parse(run(['--from', join(old, 'index.jsonl'), '--dir', data, '--dry-run', '--json']))
  assert.equal(out.dryRun, true)
  assert.equal(out.wouldImport.active, 3, 'dry-run 报的是"将导入"')
  assert.equal(out.active.imported, 0, '实际写入数必须是 0')
  assert.equal(existsSync(join(data, 'index.jsonl')), false, 'dry-run 不许写盘')
})

test('缺参数 / 找不到旧清单 → 退出码 2 并给用法', () => {
  assert.throws(() => run(['--dir', 'x']), /status 2|Command failed/)
  assert.throws(() => run(['--from', 'C:/definitely/not/here.jsonl', '--dir', 'x']), /status 2|Command failed/)
})

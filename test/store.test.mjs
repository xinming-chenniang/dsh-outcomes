/**
 * 清单核心的测试。夹具一律用 mkdtemp（绝不碰真实清单）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, readRegistry, readDeleted, readJsonl, missingAfterRewrite, stamp } from '../lib/store.js'
import { kindOf, kindLabel, previewOf } from '../lib/kind.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-outcomes-'))
  const files = join(root, 'files')
  mkdirSync(files, { recursive: true })
  // 夹具本身就在系统临时目录里，所以这里显式关掉「临时路径」那条启发式警告；
  // 专门验证它的用例自己把开关打开（见下面 system-temp 测试）。
  const store = createStore({
    dir: join(root, 'data'), cwd: files, env: {},
    now: () => new Date('2026-10-16T01:30:45'),
    treatSystemTempAsWarning: false,
  })
  return { root, files, store }
}

test('add：登记一条，标题缺省取文件名，路径相对 cwd 解析成绝对', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'report.html'), '<h1>hi</h1>')
  const result = store.add({ title: '', paths: 'report.html', by: 'demo', note: '口径' })
  assert.equal(result.ok, true)
  assert.equal(result.entry.title, 'report.html')
  assert.equal(result.entry.kind, 'html')
  assert.equal(result.entry.paths[0], join(files, 'report.html'))
  assert.equal(result.entry.by, 'demo')
  assert.equal(result.entry.sessionId, '')
  assert.deepEqual(result.warnings, [])
})

test('add：多文件用分号分隔、去重、保持顺序', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  writeFileSync(join(files, 'b.csv'), 'y')
  const result = store.add({ title: 'bundle', paths: 'a.html; b.csv;a.html' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.entry.paths, [join(files, 'a.html'), join(files, 'b.csv')])
  assert.equal(result.entry.kind, 'html')
})

test('add：文件不存在默认拒收；allowMissing 时登记但带警告', () => {
  const { store } = fixture()
  const rejected = store.add({ title: 'x', paths: 'nope.html' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'missing-file')
  assert.equal(readRegistry(store.registry).length, 0)

  const accepted = store.add({ title: 'x', paths: 'nope.html', allowMissing: true })
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.warnings.map((w) => w.code), ['missing-file'])
  assert.equal(accepted.entry.exists, false)
})

test('add：同一批路径重复登记会给出 already-registered 警告（但不阻止）', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  const first = store.add({ title: 'one', paths: 'a.html' })
  const second = store.add({ title: 'two', paths: 'a.html' })
  assert.equal(second.ok, true)
  assert.equal(second.warnings[0].code, 'already-registered')
  assert.equal(second.warnings[0].id, first.entry.id)
  assert.equal(readRegistry(store.registry).length, 2)
})

test('add：系统临时目录下的路径会给警告（开关打开时）', () => {
  const { root, files, store: plain } = fixture()
  const store = createStore({
    dir: plain.dir, cwd: files, env: {}, treatSystemTempAsWarning: true,
  })
  const tempFile = join(files, 'probe.html')
  writeFileSync(tempFile, 'x')
  const result = store.add({ title: 'temp', paths: tempFile })
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((w) => w.code === 'system-temp'), JSON.stringify(result.warnings))
  assert.ok(root.length > 0)
})

test('add：allowOutsideCwd 默认 true —— cwd 之外的路径照收', () => {
  const { root, files, store } = fixture()
  const outside = join(root, 'elsewhere.html')
  writeFileSync(outside, 'x')
  const result = store.add({ title: 'outside', paths: outside })
  assert.equal(result.ok, true)
  assert.deepEqual(result.entry.paths, [outside])
  assert.ok(files.length > 0)
})

test('add/update：allowOutsideCwd=false 时拒收 cwd 之外的路径（该配置此前只解析、从未生效）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-outcomes-'))
  const files = join(root, 'files')
  const outsideDir = join(root, 'outside')
  mkdirSync(files, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  const insideFile = join(files, 'in.html')
  const outsideFile = join(outsideDir, 'out.html')
  writeFileSync(insideFile, 'x')
  writeFileSync(outsideFile, 'x')
  const store = createStore({
    dir: join(root, 'data'), cwd: files, env: {},
    allowOutsideCwd: false, treatSystemTempAsWarning: false,
  })

  const accepted = store.add({ title: 'in', paths: 'in.html' })
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.entry.paths, [insideFile])

  const rejected = store.add({ title: 'out', paths: outsideFile })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'outside-cwd')
  assert.deepEqual(rejected.outside, [outsideFile])

  // `../` 逃逸同样被拦：相对路径先按 cwd 解析，再判是否在 cwd 之内
  const escape = store.add({ title: 'escape', paths: '../outside/out.html' })
  assert.equal(escape.ok, false)
  assert.equal(escape.error, 'outside-cwd')

  // update 换路径受同一条约束，且失败时不落盘
  const updated = store.update(accepted.entry.id, { paths: outsideFile })
  assert.equal(updated.ok, false)
  assert.equal(updated.error, 'outside-cwd')
  assert.equal(readRegistry(store.registry).length, 1)
})

test('add：id 同秒不重复（随机后缀兜底）', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  const ids = new Set()
  for (let i = 0; i < 20; i++) ids.add(store.add({ title: `t${i}`, paths: 'a.html' }).entry.id)
  assert.equal(ids.size, 20)
})

test('add：标题过长会被截断（maxTitleLength）', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  const result = store.add({ title: 'T'.repeat(200), paths: 'a.html', })
  assert.ok(result.entry.title.length <= 120)
})

test('list：按 at 倒序、支持 q/kind/state/limit 过滤', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  writeFileSync(join(files, 'b.csv'), 'y')
  const older = createStore({ dir: store.dir, cwd: files, env: {}, now: () => new Date('2026-01-01T00:00:00') })
  older.add({ title: '财务季报', paths: 'a.html', by: '财务' })
  store.add({ title: '健康快照', paths: 'b.csv', by: '健康' })

  const all = store.list()
  assert.equal(all.length, 2)
  assert.equal(all[0].title, '健康快照')
  assert.equal(store.list({ q: '财务' }).length, 1)
  assert.equal(store.list({ kind: 'data' }).length, 1)
  assert.equal(store.list({ limit: 1 }).length, 1)
  assert.equal(store.list({ state: 'deleted' }).length, 0)
  // 多词 AND
  assert.equal(store.list({ q: '财务 季报' }).length, 1)
  assert.equal(store.list({ q: '财务 不存在' }).length, 0)
})

test('remove：只删登记不删文件、留档可查、带去重后的 why', () => {
  const { files, store } = fixture()
  const target = join(files, 'a.html')
  writeFileSync(target, 'x')
  const entry = store.add({ title: 'will-remove', paths: 'a.html' }).entry

  const result = store.remove(entry.id, '换版本了')
  assert.equal(result.ok, true)
  assert.equal(existsSync(target), true, '文件必须原地不动')
  assert.equal(readRegistry(store.registry).length, 0)

  const removed = readDeleted(store.deletedFile)
  assert.equal(removed.length, 1)
  assert.equal(removed[0].id, entry.id)
  assert.equal(removed[0].why, '换版本了')
  assert.ok(typeof removed[0].removedAt === 'string')
  // 清单重写留下了 .bak
  assert.equal(existsSync(`${store.registry}.bak`), true)
})

test('remove：未知 id 报 not-found 且不动清单', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  store.add({ title: 'keep', paths: 'a.html' })
  const before = readFileSync(store.registry, 'utf8')
  const result = store.remove('20260101-000000-0000')
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not-found')
  assert.equal(readFileSync(store.registry, 'utf8'), before)
  assert.equal(readDeleted(store.deletedFile).length, 0)
})

test('restore：放回清单、从删除日志移除、重复放回被拒', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  const entry = store.add({ title: 'x', paths: 'a.html' }).entry
  store.remove(entry.id)
  assert.equal(readDeleted(store.deletedFile).length, 1)

  const back = store.restore(entry.id)
  assert.equal(back.ok, true)
  assert.equal(readRegistry(store.registry).length, 1)
  assert.equal(readDeleted(store.deletedFile).length, 0)
  assert.equal(store.restore(entry.id).error, 'already-active')
  assert.equal(store.restore('20990101-000000-0000').error, 'not-found')
})

test('update：改标题/备注/关联会话；未知 id 报错', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  const entry = store.add({ title: 'old', paths: 'a.html' }).entry
  const updated = store.update(entry.id, { title: 'new', note: 'n', sessionId: 'session-1' })
  assert.equal(updated.ok, true)
  assert.equal(updated.entry.title, 'new')
  assert.equal(updated.entry.note, 'n')
  assert.equal(updated.entry.sessionId, 'session-1')
  assert.equal(store.update('20990101-000000-0000', { title: 'x' }).error, 'not-found')
})

test('check：文件都在时 ok=true；文件丢了 → ok=false，登记保留', () => {
  const { files, store } = fixture()
  const target = join(files, 'gone.html')
  writeFileSync(target, 'x')
  store.add({ title: 'gone', paths: 'gone.html' })
  assert.equal(store.check().ok, true)

  rmSync(target)
  const result = store.check()
  assert.equal(result.ok, false)
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].path, target)
  assert.equal(store.list().length, 1, '登记不该因为文件丢了而消失')
})

test('并发：提交前发现清单被别的进程改过 → 拒绝写入，清单/留档/.tmp 全都不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-outcomes-race-'))
  const files = join(root, 'files')
  mkdirSync(files, { recursive: true })
  for (const name of ['a.md', 'b.md', 'c.md']) writeFileSync(join(files, name), name)

  // 模拟另一个进程（另一个 CLI / 插件的另一次调用）在同一次"读—改—写"中间插了一笔
  const intruder = { id: '20990101-000000-9999', title: 'added by another process', kind: 'text', paths: [join(files, 'c.md')], by: '', note: '', sessionId: '', cwd: files, at: '2026-10-16T01:00:00.000Z' }
  let armed = false
  let expectedAfter = ''
  const store = createStore({
    dir: join(root, 'data'), cwd: files, env: {}, treatSystemTempAsWarning: false,
    beforeCommit: (file) => {
      if (!armed) return
      armed = false
      // 记下"只被另一个进程改过"应该长什么样：拒绝之后文件必须**正好**是这个内容
      expectedAfter = readFileSync(file, 'utf8') + JSON.stringify(intruder) + '\n'
      appendFileSync(file, JSON.stringify(intruder) + '\n', 'utf8')
    },
  })

  const first = store.add({ title: 'first', paths: 'a.md' })
  const second = store.add({ title: 'second', paths: 'b.md' })

  armed = true
  const updated = store.update(first.entry.id, { title: 'should not land' })
  assert.equal(updated.ok, false)
  assert.equal(updated.error, 'concurrent-modification')
  assert.equal(readFileSync(store.registry, 'utf8'), expectedAfter, '拒绝时清单里只该有另一个进程那一笔')

  armed = true
  const removed = store.remove(second.entry.id)
  assert.equal(removed.ok, false)
  assert.equal(removed.error, 'concurrent-modification')

  assert.equal(readFileSync(store.registry, 'utf8'), expectedAfter, '第二次拒绝同样不许改动清单')
  assert.equal(existsSync(store.deletedFile), false, '拒绝时不该产生删除留档（否则它指向的条目其实还在用）')
  assert.equal(existsSync(`${store.registry}.tmp`), false, '不许留下 .tmp 半成品')
  assert.ok(readRegistry(store.registry).some((row) => row.id === '20990101-000000-9999'), '另一进程写的那条必须还在（这正是"没被覆盖"）')
  assert.ok(store.list().some((row) => row.id === first.entry.id), '被改的那条还在，只是没被改')
})

test('并发：没有冲突时照常写入（复核不能把正常路径也拦掉）', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'one.md'), '1')
  writeFileSync(join(files, 'two.md'), '2')
  const one = store.add({ title: 'one', paths: 'one.md' })
  const two = store.add({ title: 'two', paths: 'two.md' })
  assert.equal(store.update(one.entry.id, { title: 'renamed' }).ok, true)
  assert.equal(store.remove(two.entry.id).ok, true)
  assert.equal(store.list().length, 1)
  assert.equal(store.restore(two.entry.id).ok, true)
  assert.equal(store.list().length, 2)
})

test('自愈：重写时消失的登记自动补记 why=auto-archived', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  writeFileSync(join(files, 'b.csv'), 'y')
  const keep = store.add({ title: 'keep', paths: 'a.html' }).entry
  const drop = store.add({ title: 'drop', paths: 'b.csv' }).entry

  // 模拟"某条登记被外部工具从清单里抹掉"（磁盘上确实消失、删除日志里也没有）
  store.__internals.rewrite([keep])
  const removed = readDeleted(store.deletedFile)
  assert.equal(removed.length, 1)
  assert.equal(removed[0].id, drop.id)
  assert.equal(removed[0].why, 'auto-archived')
})

test('纯函数：missingAfterRewrite 只报"消失且没留档"的 id', () => {
  const before = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const after = [{ id: 'a' }]
  assert.deepEqual(missingAfterRewrite(before, after, ['c']), ['b'])
  assert.deepEqual(missingAfterRewrite(before, after, []), ['b', 'c'])
  assert.deepEqual(missingAfterRewrite([], [], []), [])
})

test('坏行不让整份清单报废：跳过并记 errors', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  store.add({ title: 'good', paths: 'a.html' })
  writeFileSync(store.registry, readFileSync(store.registry, 'utf8') + '{ not json\n', 'utf8')
  const { rows, errors } = readJsonl(store.registry)
  assert.equal(rows.length, 1)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].line, 2)
  assert.equal(store.list().length, 1)
})

test('stats：按类型计数', () => {
  const { files, store } = fixture()
  writeFileSync(join(files, 'a.html'), 'x')
  writeFileSync(join(files, 'b.pdf'), 'y')
  store.add({ title: 'a', paths: 'a.html' })
  store.add({ title: 'b', paths: 'b.pdf' })
  const stats = store.stats()
  assert.equal(stats.active, 2)
  assert.equal(stats.deleted, 0)
  assert.deepEqual(stats.byKind, { html: 1, pdf: 1 })
})

test('kind：扩展名归类与预览方式', () => {
  assert.equal(kindOf('a.HTML'), 'html')
  assert.equal(kindOf('a.markdown'), 'doc')
  assert.equal(kindOf('a.xlsx'), 'data')
  assert.equal(kindOf('a.srt'), 'text')
  assert.equal(kindOf('noext'), 'other')
  assert.equal(kindOf('trailing.'), 'other')
  assert.equal(previewOf('html'), 'inline')
  assert.equal(previewOf('img'), 'thumbnail')
  assert.equal(kindLabel('img', 'zh'), '图片')
  assert.equal(kindLabel('nope', 'en'), 'File')
})

test('stamp：本地时间格式 YYYYMMDD-HHMMSS', () => {
  assert.equal(stamp(new Date(2026, 9, 16, 1, 30, 45)), '20261016-013045')
})

/**
 * 宿主半部测试：用**桩** ctx（webServer / tools / logger）驱动真实路由处理器。
 * 不跑真 DSH —— 夹具是一个 mkdtemp 数据目录 + 一个假 req/res。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, contextOf, ROUTE_PREFIX, GUARD_HEADER } from '../lib/index.js'
import { apply as applyTools } from '../lib/tools.js'

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-outcomes-host-'))
  const files = join(root, 'files')
  const data = join(root, 'data')
  mkdirSync(files, { recursive: true })
  writeFileSync(join(files, 'report.html'), '<!doctype html><title>r</title><h1>report</h1>')
  writeFileSync(join(files, 'table.csv'), 'a,b\n1,2\n')

  const routes = []
  const tools = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    on() {},
    get(service) { return service === 'tools' ? { register(definition) { tools.push(definition); return () => {} } } : undefined },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  const exported = apply(ctx, { dir: data, treatSystemTempAsWarning: false })
  applyTools(ctx, { dir: data, treatSystemTempAsWarning: false })
  assert.equal(routes.length, 1)
  return { root, files, data, routes, tools, ctx, store: exported.store, route: routes[0] }
}

/** 最小 req/res 桩：够跑 `new URL(req.url, ...)`、读 body、以及 res.writeHead/end。 */
function call(route, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const req = {
      method,
      url: ROUTE_PREFIX + url,
      headers,
      on(event, handler) {
        if (event === 'data' && body !== undefined) handler(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
        if (event === 'end') handler()
        return req
      },
      destroy() {},
    }
    const res = {
      status: 0,
      headers: null,
      body: '',
      writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders },
      end(text) { this.body = text ?? ''; resolve({ status: res.status, headers: res.headers, body: res.body }) },
      write() {},
    }
    // 文件路由会走 stream.pipe(res)：给它一个 no-op write，避免真写 socket
    route.handler(req, res)
  })
}

test('插件导出契约：name / inject / apply，并按前缀注册路由', () => {
  const { route } = harness()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE_PREFIX)
  assert.equal(typeof route.handler, 'function')
})

test('GET / 返回自包含页面（含 CSP 与守卫头名，不外链任何资源）', async () => {
  const { route, data } = harness()
  const res = await call(route, { url: '/' })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /text\/html/)
  assert.match(res.headers['content-security-policy'], /default-src 'none'/)
  assert.match(res.body, /dsh-outcomes/)
  assert.match(res.body, new RegExp(GUARD_HEADER))
  assert.ok(res.body.includes(data), '页面要显示数据目录')
  assert.ok(!/<script[^>]+src=/.test(res.body), '不许外链脚本')
})

test('GET /?lang=zh 出中文页', async () => {
  const { route } = harness()
  const res = await call(route, { url: '/?lang=zh' })
  assert.match(res.body, /成果清单/)
  assert.match(res.body, /lang="zh"/)
})

test('写操作缺守卫头 → 403，且不动清单', async () => {
  const { route, store } = harness()
  const res = await call(route, { method: 'POST', url: '/api/add', body: { paths: 'x.html' } })
  assert.equal(res.status, 403)
  assert.equal(JSON.parse(res.body).error, 'missing-guard-header')
  assert.equal(store.list().length, 0)
})

test('POST /api/add → 登记成功；GET /api/list 能查到', async () => {
  const { route, files } = harness()
  const added = await call(route, {
    method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' },
    body: { title: 'Report', paths: join(files, 'report.html'), by: 'demo' },
  })
  assert.equal(added.status, 200)
  const entry = JSON.parse(added.body).entry
  assert.equal(entry.title, 'Report')
  assert.equal(entry.kind, 'html')
  assert.ok(entry.id)

  const listed = await call(route, { url: '/api/list?q=report' })
  assert.equal(JSON.parse(listed.body).rows.length, 1)
  assert.equal(JSON.parse(listed.body).stats.active, 1)
})

test('POST /api/add 缺 paths → 400；非法 JSON → 400', async () => {
  const { route } = harness()
  const missing = await call(route, { method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' }, body: { title: 'x' } })
  assert.equal(missing.status, 400)
  assert.equal(JSON.parse(missing.body).error, 'paths-required')

  const bad = await call(route, { method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' }, body: '{not json' })
  assert.equal(bad.status, 400)
  assert.equal(JSON.parse(bad.body).error, 'invalid-json')
})

test('POST /api/add 文件不存在 → 400（除非 allowMissing）', async () => {
  const { route } = harness()
  const rejected = await call(route, { method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' }, body: { paths: 'nope.html' } })
  assert.equal(rejected.status, 400)
  assert.equal(JSON.parse(rejected.body).error, 'missing-file')

  const allowed = await call(route, { method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' }, body: { paths: 'nope.html', allowMissing: true } })
  assert.equal(allowed.status, 200)
})

test('文件路由：URL 里只有 id 与序号；越界 / 未知 id / 穿越一律 404', async () => {
  const { route, files } = harness()
  const added = await call(route, {
    method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' },
    body: { title: 'Report', paths: join(files, 'report.html') },
  })
  const id = JSON.parse(added.body).entry.id

  // 正常：HTML 以内联方式给出，并带沙箱 CSP
  const ok = await new Promise((resolve) => {
    const req = { method: 'GET', url: `${ROUTE_PREFIX}/file/${id}/0`, headers: {}, on() { return req }, destroy() {} }
    const res = {
      status: 0, headers: null,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(body) { resolve({ status: this.status, headers: this.headers, body: body ?? '' }) },
      write() {}, on() {}, once() {}, emit() {},
    }
    route.handler(req, res)
  })
  assert.equal(ok.status, 200)
  assert.match(ok.headers['content-type'], /text\/html/)
  assert.equal(ok.headers['content-disposition'], 'inline')
  assert.match(ok.headers['content-security-policy'], /sandbox/)

  assert.equal((await call(route, { url: `/file/${id}/9` })).status, 404)
  const negative = await call(route, { url: `/file/${id}/-1` })
  assert.equal(negative.status, 404)
  assert.equal(JSON.parse(negative.body).error, 'bad-index')
  const noIndex = await call(route, { url: `/file/${id}` })
  assert.equal(noIndex.status, 404)
  assert.equal(JSON.parse(noIndex.body).error, 'bad-file-path')
  assert.equal((await call(route, { url: '/file/20990101-000000-0000/0' })).status, 404)
  // 路径穿越：URL 里没有路径分量可穿 —— 带 ..%2f 也只是"未知 id"
  const traversal = await call(route, { url: '/file/..%2f..%2findex.jsonl/0' })
  assert.equal(traversal.status, 404)
  assert.equal(JSON.parse(traversal.body).error, 'unknown-id')
})

test('文件不在了 → 404 file-missing（登记仍在）', async () => {
  const { route, files, store } = harness()
  const target = join(files, 'report.html')
  const added = await call(route, { method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' }, body: { paths: target } })
  const id = JSON.parse(added.body).entry.id
  const { rmSync } = await import('node:fs')
  rmSync(target)
  const res = await call(route, { url: `/file/${id}/0` })
  assert.equal(res.status, 404)
  assert.equal(JSON.parse(res.body).error, 'file-missing')
  assert.equal(store.list().length, 1)
})

test('remove / restore：状态码与清单、删除日志三相一致', async () => {
  const { route, files, store } = harness()
  const added = await call(route, { method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' }, body: { paths: join(files, 'table.csv') } })
  const id = JSON.parse(added.body).entry.id

  const removed = await call(route, { method: 'POST', url: '/api/remove', headers: { [GUARD_HEADER]: '1' }, body: { id, why: 'demo' } })
  assert.equal(removed.status, 200)
  assert.equal(store.list().length, 0)
  assert.equal(store.deleted().length, 1)

  // 三态：改登记后清单文件本身也该是"少了一行"，而删除日志多一行
  assert.equal(readFileSync(store.registry, 'utf8').trim(), '')
  assert.equal(readFileSync(store.deletedFile, 'utf8').trim().split('\n').length, 1)

  const restored = await call(route, { method: 'POST', url: '/api/restore', headers: { [GUARD_HEADER]: '1' }, body: { id } })
  assert.equal(restored.status, 200)
  assert.equal(store.list().length, 1)
  assert.equal(store.deleted().length, 0)

  const again = await call(route, { method: 'POST', url: '/api/restore', headers: { [GUARD_HEADER]: '1' }, body: { id } })
  assert.equal(again.status, 409, '重复放回 → 409 already-active')
})

test('remove 未知 id → 404；缺 id → 400；失败请求不动清单', async () => {
  const { route, store, files } = harness()
  await call(route, { method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' }, body: { paths: join(files, 'report.html') } })
  const before = readFileSync(store.registry, 'utf8')

  assert.equal((await call(route, { method: 'POST', url: '/api/remove', headers: { [GUARD_HEADER]: '1' }, body: { id: '20990101-000000-0000' } })).status, 404)
  assert.equal((await call(route, { method: 'POST', url: '/api/remove', headers: { [GUARD_HEADER]: '1' }, body: {} })).status, 400)
  assert.equal(readFileSync(store.registry, 'utf8'), before)
  assert.equal(readdirSync(join(store.dir)).filter((name) => name.endsWith('.tmp')).length, 0)
})

test('GET /api/check 与 /api/status 的字段形状', async () => {
  const { route, files, store } = harness()
  await call(route, { method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' }, body: { paths: join(files, 'report.html') } })
  const check = JSON.parse((await call(route, { url: '/api/check' })).body)
  assert.equal(check.ok, true)
  assert.equal(check.total, 1)

  const status = JSON.parse((await call(route, { url: '/api/status' })).body)
  assert.equal(status.active, 1)
  assert.equal(status.dir, store.dir)
  assert.equal(typeof status.version, 'string')
  assert.ok(status.registry.endsWith('index.jsonl'))
})

test('GET /api/list 的窗口：默认用 pageSize、显式 limit 被尊重、超大 limit 被卡住', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-outcomes-window-'))
  const files = join(root, 'files')
  mkdirSync(files, { recursive: true })
  for (let i = 0; i < 5; i++) writeFileSync(join(files, `f${i}.txt`), 'x')

  const routes = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn() },
    get() { return undefined },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  // pageSize=3：不传 limit 时只回 3 条
  apply(ctx, { dir: join(root, 'data'), pageSize: 3, treatSystemTempAsWarning: false })
  applyTools(ctx, { dir: join(root, 'data'), pageSize: 3, treatSystemTempAsWarning: false })
  const route = routes[0]
  for (let i = 0; i < 5; i++) {
    await call(route, {
      method: 'POST', url: '/api/add', headers: { [GUARD_HEADER]: '1' },
      body: { title: `t${i}`, paths: join(files, `f${i}.txt`) },
    })
  }

  const dflt = JSON.parse((await call(route, { url: '/api/list' })).body)
  assert.equal(dflt.rows.length, 3, '默认窗口 = pageSize')
  assert.equal(dflt.window.limit, 3)
  assert.equal(dflt.window.pageSize, 3)
  assert.equal(dflt.stats.active, 5, 'stats 反映全量，不受窗口影响')

  const explicit = JSON.parse((await call(route, { url: '/api/list?limit=2' })).body)
  assert.equal(explicit.rows.length, 2, '显式 limit 被尊重')

  const huge = JSON.parse((await call(route, { url: '/api/list?limit=999999' })).body)
  assert.equal(huge.window.limit, 10000, '超大 limit 被卡在硬上限')
  assert.equal(huge.rows.length, 5)

  const junk = JSON.parse((await call(route, { url: '/api/list?limit=abc' })).body)
  assert.equal(junk.window.limit, 1, '垃圾 limit 不该变成 NaN')

  // 搜索走服务端：窗口只有 3 条，但 q 能命中窗口外的条目
  const searched = JSON.parse((await call(route, { url: '/api/list?q=t4' })).body)
  assert.equal(searched.rows.length, 1, 'q 必须在全量上匹配，而不是只在窗口内')
  assert.equal(searched.rows[0].title, 't4')
})

test('未知路径 404、不支持的方法 405', async () => {
  const { route } = harness()
  const notFound = await call(route, { method: 'POST', url: '/api/nope', headers: { [GUARD_HEADER]: '1' }, body: {} })
  assert.equal(notFound.status, 404)
  // 非 GET 且**没有**守卫头 → 403（守卫在方法判定之前）；带上守卫头才走到 405
  assert.equal((await call(route, { method: 'PUT', url: '/api/list' })).status, 403)
  assert.equal((await call(route, { method: 'PUT', url: '/api/list', headers: { [GUARD_HEADER]: '1' } })).status, 405)
})

test('工具注册：6 个工具、名字稳定、remove 有审批闸门', () => {
  const { tools } = harness()
  const names = tools.map((tool) => tool.name)
  assert.deepEqual(names, ['outcome_add', 'outcome_list', 'outcome_update', 'outcome_check', 'outcome_remove', 'outcome_restore'])
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.parameters && tool.parameters.type === 'object')
    assert.ok(tool.output)
  }
  assert.deepEqual(tools[0].parameters.required, ['paths'])
  assert.deepEqual(tools[2].parameters.required, ['id'], 'outcome_update 只要 id')
  assert.deepEqual(tools[4].parameters.required, ['id'])
})

test('工具 execute：add 带会话上下文、list 形状、update 改元数据、check 结果、remove/restore 往返', async () => {
  const { tools, files, store } = harness()
  const add = tools.find((tool) => tool.name === 'outcome_add')
  const list = tools.find((tool) => tool.name === 'outcome_list')
  const update = tools.find((tool) => tool.name === 'outcome_update')
  const check = tools.find((tool) => tool.name === 'outcome_check')
  const remove = tools.find((tool) => tool.name === 'outcome_remove')
  const restore = tools.find((tool) => tool.name === 'outcome_restore')

  const exec = { agent: { session: { id: 'session-abc', header: { cwd: files } } } }
  const added = await add.execute({ title: 'From tool', paths: 'report.html;table.csv', by: 'agent' }, exec)
  assert.equal(added.ok, true)
  assert.equal(added.entry.sessionId, 'session-abc')
  assert.deepEqual(added.entry.paths, [join(files, 'report.html'), join(files, 'table.csv')])

  const listed = await list.execute({ q: 'tool' }, exec)
  assert.equal(listed.count, 1)
  assert.ok(Array.isArray(listed.rows[0].paths))

  // 改元数据：不再产生第二条登记
  const updated = await update.execute({ id: added.entry.id, title: 'Fixed title', note: 'typo fixed' }, exec)
  assert.equal(updated.ok, true)
  assert.equal(updated.entry.title, 'Fixed title')
  assert.equal(updated.entry.note, 'typo fixed')
  assert.equal(store.list().length, 1, '改元数据不该新增登记')
  assert.equal((await update.execute({ id: '20990101-000000-0000', title: 'x' }, exec)).error, 'not-found')

  assert.equal((await check.execute({}, exec)).ok, true)

  const removed = await remove.execute({ id: added.entry.id, why: 'test' }, exec)
  assert.equal(removed.ok, true)
  assert.equal(store.deleted().length, 1)

  assert.equal((await restore.execute({ id: added.entry.id }, exec)).ok, true)
  assert.equal(store.list().length, 1)
})

test('工具渲染函数输出稳定文本（不依赖具体措辞的断言不写在这里）', () => {
  const { tools } = harness()
  const add = tools.find((tool) => tool.name === 'outcome_add')
  const okText = add.output.render({}, { ok: true, entry: { id: 'x', kind: 'html', title: 'T', paths: ['p'] }, warnings: [] })[0].text
  assert.match(okText, /Registered x \[html\] "T"/)
  const badText = add.output.render({}, { ok: false, error: 'missing-file', missing: ['p'] })[0].text
  assert.match(badText, /outcome_add failed: missing-file/)
})

test('contextOf：取得到就取，取不到不抛错', () => {
  assert.deepEqual(contextOf({ agent: { session: { id: 's1', header: { cwd: 'C:\\w' } } } }), { sessionId: 's1', cwd: 'C:\\w' })
  assert.deepEqual(contextOf({}), { sessionId: '', cwd: '' })
  assert.deepEqual(contextOf(undefined), { sessionId: '', cwd: '' })
})

test('宿主没有 tools 服务时：只注册路由，不抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-outcomes-notools-'))
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn() },
    get() { return undefined },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  const exported = apply(ctx, { dir: join(root, 'data') })
  applyTools(ctx, { dir: join(root, 'data') })
  assert.equal(routes.length, 1)
  assert.equal(typeof exported.store.list, 'function')
})

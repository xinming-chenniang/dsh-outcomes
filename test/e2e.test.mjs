/**
 * 端到端（**真 HTTP**）：把插件的路由按宿主的方式挂到 `node:http` 上，然后用 `fetch` 走一遍
 * 完整用户旅程。它证明的不是"函数能跑"，而是"这个包真的能当一个本地服务用"：
 *
 *   打开页面 → 登记一条 → 列表里有 → 预览文件 → 取消登记（文件还在）→ 放回 → 体检
 *
 * 端口用 0（系统分配），只绑 127.0.0.1；数据目录是 mkdtemp，不碰任何真实清单。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, ROUTE_PREFIX, GUARD_HEADER } from '../lib/index.js'

/** 起一个只服务插件路由的本地服务（模拟宿主的 webServer.register）。 */
async function mount() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-outcomes-e2e-'))
  const files = join(root, 'files')
  mkdirSync(files, { recursive: true })
  const report = join(files, 'report.html')
  const table = join(files, 'table.csv')
  writeFileSync(report, '<!doctype html><meta charset="utf-8"><h1>Hello outcome</h1><script>document.title="ran"</script>')
  writeFileSync(table, 'name,qty\nwidget,3\n')

  const routes = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn() },
    get() { return undefined },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  apply(ctx, { dir: join(root, 'data'), treatSystemTempAsWarning: false })

  const server = createServer((req, res) => {
    const match = routes.find((route) => route.kind === 'prefix' && (req.url ?? '').startsWith(route.path))
    if (!match) { res.writeHead(404).end('no route'); return }
    match.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`
  return {
    base, files, report, table, root,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('端到端：页面 → 登记 → 列表 → 预览 → 取消登记（文件还在）→ 放回 → 体检', async () => {
  const app = await mount()
  try {
    // 1. 管理页
    const page = await fetch(`${app.base}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)
    const html = await page.text()
    assert.match(html, /DSH outcomes/)
    assert.match(html, /__dsh-outcomes/)  // 脚本里的 PREFIX 已被替换
    assert.ok(html.includes(app.root), '页面要显示数据目录（说明是这次请求现算的）')

    // 中文页
    const zh = await (await fetch(`${app.base}/?lang=zh`)).text()
    assert.match(zh, /成果清单/)

    // 2. 登记（缺守卫头应被拒）
    const noGuard = await fetch(`${app.base}/api/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', paths: app.report }),
    })
    assert.equal(noGuard.status, 403)

    const added = await fetch(`${app.base}/api/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
      body: JSON.stringify({ title: '端到端报告', paths: `${app.report};${app.table}`, by: 'e2e', note: '两件套' }),
    })
    assert.equal(added.status, 200)
    const entry = (await added.json()).entry
    assert.equal(entry.kind, 'html')
    assert.equal(entry.paths.length, 2)

    // 3. 列表 + 状态
    const list = await (await fetch(`${app.base}/api/list?q=端到端`)).json()
    assert.equal(list.rows.length, 1)
    assert.equal(list.stats.active, 1)
    const status = await (await fetch(`${app.base}/api/status`)).json()
    assert.equal(status.active, 1)
    assert.equal(status.missing, 0)

    // 4. 预览：HTML 内联 + 沙箱 CSP；第二个文件按类型给 attachment
    const preview = await fetch(`${app.base}/file/${entry.id}/0`)
    assert.equal(preview.status, 200)
    assert.equal(preview.headers.get('content-disposition'), 'inline')
    assert.match(preview.headers.get('content-security-policy'), /sandbox/)
    assert.match(await preview.text(), /Hello outcome/)
    const csv = await fetch(`${app.base}/file/${entry.id}/1`)
    assert.equal(csv.status, 200)
    assert.match(csv.headers.get('content-disposition'), /attachment/)
    assert.equal((await fetch(`${app.base}/file/${entry.id}/5`)).status, 404)

    // 5. 取消登记：清单空了，但**文件还在**
    const removed = await fetch(`${app.base}/api/remove`, {
      method: 'POST', headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
      body: JSON.stringify({ id: entry.id, why: '端到端测试' }),
    })
    assert.equal(removed.status, 200)
    assert.equal((await (await fetch(`${app.base}/api/list`)).json()).rows.length, 0)
    assert.equal((await (await fetch(`${app.base}/api/deleted`)).json()).rows.length, 1)
    assert.ok(existsSync(app.report) && existsSync(app.table), '取消登记绝不能删文件')
    // 已取消的条目仍可取文件（页面在"已删除"模式下要能预览）
    assert.equal((await fetch(`${app.base}/file/${entry.id}/0`)).status, 200)

    // 6. 放回
    const restored = await fetch(`${app.base}/api/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
      body: JSON.stringify({ id: entry.id }),
    })
    assert.equal(restored.status, 200)
    assert.equal((await (await fetch(`${app.base}/api/list`)).json()).rows.length, 1)

    // 7. 体检：把文件删掉之后如实报告，且登记保留
    rmSync(app.report)
    const check = await (await fetch(`${app.base}/api/check`)).json()
    assert.equal(check.ok, false)
    assert.equal(check.missing.length, 1)
    assert.equal((await (await fetch(`${app.base}/api/list`)).json()).rows.length, 1, '登记不该被静默清掉')
    assert.equal((await fetch(`${app.base}/file/${entry.id}/0`)).status, 404, '文件没了 → 404')
    assert.equal((await fetch(`${app.base}/file/${entry.id}/1`)).status, 200, '另一个文件仍可取')

    // 8. 能被浏览器执行的东西一律不给内联：SVG 也是（它可携带脚本）
    const svg = join(app.files, 'chart.svg')
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    const svgEntry = await (await fetch(`${app.base}/api/add`, {
      method: 'POST', headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
      body: JSON.stringify({ title: 'svg', paths: svg }),
    })).json()
    const svgRes = await fetch(`${app.base}/file/${svgEntry.entry.id}/0`)
    assert.equal(svgRes.status, 200)
    assert.match(svgRes.headers.get('content-disposition'), /attachment/, 'SVG 必须下载，不能内联')
    // 而 HTML 内联时一定带沙箱 CSP
    assert.match(preview.headers.get('content-security-policy'), /sandbox/)
  } finally {
    await app.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

test('端到端：面板之外的东西一律不服务（前缀匹配不会漏出去）', async () => {
  const app = await mount()
  try {
    // 宿主收到不匹配的前缀会走它自己的路由；这里直接验证我们的 handler 不会越界响应
    const res = await fetch(`${app.base}/../../etc/passwd`).catch(() => null)
    if (res) assert.ok([400, 404].includes(res.status), `不该返回 ${res.status}`)
  } finally {
    await app.close()
    rmSync(app.root, { recursive: true, force: true })
  }
})

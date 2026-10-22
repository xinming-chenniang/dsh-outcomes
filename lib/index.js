/**
 * dsh-outcomes —— 宿主半部（cordis 插件）。
 *
 * 一个 DSH 插件由三块组成（详见 docs/CLIENT-HALF.md）：
 *   ① 本文件的插件行：profile 的 bundles 列到包名 ⇒ 宿主按 `cordis.patch.yml` 装载它；
 *   ② agent 工具：让**模型**能登记成果（`outcome_add` 等）；
 *   ③ HTTP 路由 + 一个自包含页面：让**人**能看（写在 `ctx.webServer` 上，与 Web UI 同源）。
 *
 * 设计取舍（与个人控制台版的差别，逐条都有理由）：
 * - **请求期渲染**，不做「页面是生成物」：登记完刷新就能看见，不需要再跑一次构建脚本，
 *   也就没有注入点与"忘了重建"这一整类坑。代价是每次请求都算一遍 —— 清单是本地小文件，可以忽略。
 * - **不带「删会话」**：那属于 DSH 会话管理（另一个插件/宿主的职责），插件不替宿主做危险动作。
 * - **写操作要带守卫头**：`x-dsh-outcomes: 1`。这不是鉴权（本机同源页面本来就能发请求），
 *   而是挡住「别的站点/别的页面误发 POST」这一类跨站写入。
 * - **预览页 HTML 用 CSP `sandbox` 隔离**：登记进来的 HTML 是**别人的文件**，
 *   让它以 DSH 的同源身份跑脚本 = 把宿主暴露给任意被登记的页面。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { createStore } from './store.js'
import { renderPage } from './page.js'
import { resolveOptions } from './paths.js'
import { KIND_LABELS } from './kind.js'

export const name = 'dsh-outcomes-web'

/** 需要宿主提供的服务：HTTP。工具走 `ctx.get('tools')` 软取（没有也能跑）。 */
export const inject = ['webServer']

export const ROUTE_PREFIX = '/__dsh-outcomes'
export const GUARD_HEADER = 'x-dsh-outcomes'
const VERSION = '0.1.1'
const JSON_LIMIT = 256 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.zip': 'application/zip',
}

function mimeOf(file) {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(text)
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8' })
}

/**
 * 哪些文件可以**内联**给浏览器看：网页、PDF、位图。
 *
 * 刻意排除 SVG：它是图片，但**能携带脚本** —— 内联就等于把它放进宿主页面所在源里执行。
 * 想看图就让用户下载后自己开（或由用户在本地看图工具里打开）。
 * 这个判断必须按**文件本身**的扩展名来，不能按条目的 `kind`：一条成果可以同时含
 * `report.html` 与 `data.csv`，按条目类型判会把 CSV 也内联出去。
 */
const INLINE_EXT = new Set(['.html', '.htm', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico'])
const SANDBOXED_EXT = new Set(['.html', '.htm'])

function dispositionOf(file) {
  const ext = extname(file).toLowerCase()
  if (INLINE_EXT.has(ext)) return 'inline'
  const name = String(file).split(/[\\/]/).pop().replace(/"/g, '')
  return `attachment; filename="${name}"`
}

/** 被登记的 HTML 以沙箱身份执行：脚本能跑（图表要），但拿不到 DSH 的同源身份。 */
const SANDBOX_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals; object-src 'none'; base-uri 'none'"

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > JSON_LIMIT) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 从工具的 exec 上下文里尽力取会话 id 与 cwd；取不到不算错（它们是可选元数据）。 */
export function contextOf(exec) {
  const session = exec?.agent?.session
  const header = session?.header ?? {}
  const id = typeof session?.id === 'string' ? session.id : (typeof header.id === 'string' ? header.id : '')
  const cwd = typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : ''
  return { sessionId: id, cwd }
}

export function toolResult(value) {
  return [{ type: 'text', text: value.text }]
}

export function summarize(rows, lang = 'en') {
  if (rows.length === 0) return lang === 'zh' ? '清单是空的' : 'The registry is empty'
  return rows.map((row) => {
    const kind = KIND_LABELS[row.kind] ?? KIND_LABELS.other
    const flag = row.missing?.length ? (lang === 'zh' ? ' ⚠️缺文件' : ' ⚠️missing') : ''
    return `${row.id}  [${kind[lang === 'zh' ? 'zh' : 'en']}] ${row.title}${flag}`
  }).join('\n')
}

export function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  const store = createStore({ config })
  const log = (message) => {
    if (typeof ctx?.logger?.info === 'function') ctx.logger.info(`dsh-outcomes: ${message}`)
  }

  store.ensure()
  log(`registry ${store.registry} (dir source: ${store.sources.dir})`)

  // ---------------------------------------------------------------- HTTP 路由
  const handle = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sub = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) || '/' : '/'
      const method = req.method ?? 'GET'

      // 写守卫：任何非 GET 都要带守卫头（挡跨站误写；不是鉴权）。
      if (method !== 'GET' && method !== 'HEAD' && req.headers[GUARD_HEADER] !== '1') {
        return sendJson(res, 403, { ok: false, error: 'missing-guard-header', header: GUARD_HEADER })
      }

      if (method === 'GET' && (sub === '/' || sub === '/index.html')) {
        const page = renderPage({
          version: VERSION,
          dir: store.dir,
          registry: store.registry,
          deletedFile: store.deletedFile,
          guardHeader: GUARD_HEADER,
          prefix: ROUTE_PREFIX,
          pageSize: options.pageSize,
          lang: url.searchParams.get('lang') === 'zh' ? 'zh' : 'en',
        })
        return send(res, 200, page, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'",
        })
      }

      if (method === 'GET' && sub === '/api/status') {
        const stats = store.stats()
        return sendJson(res, 200, { ok: true, version: VERSION, ...stats, sources: store.sources })
      }

      if (method === 'GET' && sub === '/api/list') {
        // `pageSize` 是**服务端默认窗口**：不传 limit 就给这么多；显式 limit 也尊重，
        // 但卡一个硬上限（防止一次请求把整份大清单拉进内存）。
        const requested = url.searchParams.get('limit')
        const limit = requested ? Math.min(Math.max(1, Number(requested) || 0), 10000) : options.pageSize
        const rows = store.list({
          q: url.searchParams.get('q') ?? '',
          kind: url.searchParams.get('kind') ?? '',
          state: url.searchParams.get('state') ?? 'active',
          limit,
        })
        return sendJson(res, 200, { ok: true, rows, stats: store.stats(), window: { limit, pageSize: options.pageSize } })
      }

      if (method === 'GET' && sub === '/api/check') {
        return sendJson(res, 200, { ok: true, ...store.check() })
      }

      if (method === 'GET' && sub === '/api/deleted') {
        return sendJson(res, 200, { ok: true, rows: store.deleted() })
      }

      // 文件服务：URL 里**只有 id 与序号**，路径永远从清单里取（没有目录穿越面）。
      // 形状不对一律 404（405 的含义是"这个方法在这个路径上不允许"，不是"你这参数不对"）。
      const fileMatch = /^\/file\/([^/]+)\/([^/]+)$/.exec(sub)
      if (method === 'GET' && fileMatch) {
        const id = decodeURIComponent(fileMatch[1])
        const rawIndex = fileMatch[2]
        if (!/^\d+$/.test(rawIndex)) return sendJson(res, 404, { ok: false, error: 'bad-index' })
        const index = Number(rawIndex)
        const row = store.get(id) ?? store.deleted().find((item) => item.id === id)
        if (!row) return sendJson(res, 404, { ok: false, error: 'unknown-id' })
        const paths = Array.isArray(row.paths) ? row.paths : []
        if (index >= paths.length) return sendJson(res, 404, { ok: false, error: 'index-out-of-range' })
        const file = paths[index]
        let stat
        try { stat = statSync(file) } catch { return sendJson(res, 404, { ok: false, error: 'file-missing' }) }
        if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: 'not-a-file' })

        const headers = {
          'content-type': mimeOf(file),
          'content-length': stat.size,
          'content-disposition': dispositionOf(file),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        }
        if (SANDBOXED_EXT.has(extname(file).toLowerCase())) headers['content-security-policy'] = SANDBOX_CSP
        res.writeHead(200, headers)
        createReadStream(file).pipe(res)
        return undefined
      }

      if (sub.startsWith('/file/')) return sendJson(res, 404, { ok: false, error: 'bad-file-path' })

      if (method === 'POST') {
        const raw = await readBody(req)
        let body = {}
        if (raw.trim() !== '') {
          try { body = JSON.parse(raw) }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid-json' }) }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { ok: false, error: 'body-must-be-object' })
        }

        if (sub === '/api/add') {
          const entryTitle = typeof body.title === 'string' ? body.title : ''
          const paths = body.paths ?? body.path
          if (paths === undefined) return sendJson(res, 400, { ok: false, error: 'paths-required' })
          const result = store.add({
            title: entryTitle,
            paths,
            by: body.by,
            note: body.note,
            kind: body.kind,
            sessionId: body.sessionId,
            cwd: body.cwd,
            allowMissing: body.allowMissing === true,
          })
          return sendJson(res, result.ok ? 200 : 400, result)
        }

        if (sub === '/api/update') {
          const id = typeof body.id === 'string' ? body.id : ''
          if (id === '') return sendJson(res, 400, { ok: false, error: 'id-required' })
          const result = store.update(id, body)
          return sendJson(res, result.ok ? 200 : 404, result)
        }

        if (sub === '/api/remove') {
          const id = typeof body.id === 'string' ? body.id : ''
          if (id === '') return sendJson(res, 400, { ok: false, error: 'id-required' })
          const result = store.remove(id, typeof body.why === 'string' && body.why !== '' ? body.why : 'unregistered')
          return sendJson(res, result.ok ? 200 : 404, result)
        }

        if (sub === '/api/restore') {
          const id = typeof body.id === 'string' ? body.id : ''
          if (id === '') return sendJson(res, 400, { ok: false, error: 'id-required' })
          const result = store.restore(id)
          return sendJson(res, result.ok ? 200 : (result.error === 'already-active' ? 409 : 404), result)
        }

        return sendJson(res, 404, { ok: false, error: 'not-found' })
      }

      return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    } catch (error) {
      log(`route failed: ${String(error?.stack ?? error)}`)
      return sendJson(res, 500, { ok: false, error: 'internal-error' })
    }
  }

  const register = () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const dispose = register()
      return () => { if (typeof dispose === 'function') dispose() }
    }, 'dsh-outcomes: routes')
  } else {
    register()
  }

  return { store, ROUTE_PREFIX }
}

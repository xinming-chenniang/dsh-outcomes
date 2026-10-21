/**
 * 清单核心（无依赖、无 DSH 依赖）—— CLI、宿主插件、测试都走这一份。
 *
 * ## 数据形状
 * 清单是一行一条 JSON 的**只追加**文件（`index.jsonl`），条目：
 * ```json
 * { "id":"20261016-013045-a1b2", "title":"…", "kind":"html",
 *   "paths":["C:\\abs\\report.html"], "by":"finance", "note":"口径说明",
 *   "sessionId":"session-…", "cwd":"C:\\work", "at":"2026-10-16T01:30:45.123Z" }
 * ```
 * 删除**不是**把行抹掉：整条追加进 `deleted.jsonl`（带 `removedAt` / `why`），可以放回清单。
 * 为什么不用 `.bak` 了事：`.bak` 每次重写都被覆盖，只够还原"最后一次改动前"，看不了历史。
 *
 * ## 三条不变量（都有测试钉着）
 * 1. **只记路径、不搬文件**：清单是索引，不是文件管理器。`remove()` 不删任何文件。
 * 2. **重写是原子的**：`.bak`（覆盖式，供单步还原）→ `.tmp` → `rename`。
 * 3. **消失的登记会自愈**：重写时发现"上次在、这次不在、删除日志里也没有"的 id，
 *    自动补一条 `why=auto-archived` —— 目的是「再也不会有一条登记无声消失」。
 *
 * ## 与个人控制台版本的差别（通用化）
 * - 清单路径全部来自配置（`lib/paths.js`），代码里没有个人绝对路径；
 * - `sessionId` / `cwd` 是**可选元数据**，不再是必填或从 DSH 环境强取；
 * - 没有「删会话」这类跨插件能力：那属于 DSH 会话管理，不属于成果清单。
 */
/**
 * ## 并发说明（刻意保持同步）
 * 全部读写都是同步文件操作：同一个 Node 进程里事件循环不会把同步代码切开，
 * 所以「读—改—写」之间不会被本进程的另一个工具调用插进来。
 * **跨进程**并发没有加锁（CLI 与插件同时写同一份清单，理论上会各写一次、
 * 后者赢）—— 代价是：极端情况下可能丢一条登记，而清单每次重写都留 `.bak`，
 * 单步可还原。想要更强保证请用一把外部锁（本工具不内置）。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { kindOf } from './kind.js'
import { resolveOptions, toAbsolute } from './paths.js'

/**
 * 读 JSONL：坏行跳过并计入 `errors`（绝不让一行坏数据带走整份清单）。
 *
 * 同时返回 `snapshot`（内容哈希）—— 这是**乐观并发**的凭据：调用方拿它去做"读—改—写"，
 * 提交前复核哈希没变才落盘。没有快照的话，两个进程同时改清单时后者会静默覆盖前者
 * （丢一条登记，而且看不出是谁丢的）。
 */
export function readJsonl(file) {
  const out = { rows: [], errors: [], snapshot: null }
  try {
    if (!existsSync(file)) return out
    const buf = readFileSync(file)          // 读**字节**：解析与哈希用同一份内容，避免两次读之间被改
    out.snapshot = hashOf(buf)
    let line = 0
    for (const raw of buf.toString('utf8').split('\n')) {
      line++
      const trimmed = raw.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
        out.rows.push(parsed)
      } catch (error) {
        out.errors.push({ line, error: String(error?.message ?? error) })
      }
    }
  } catch (error) {
    out.errors.push({ line: 0, error: String(error?.message ?? error) })
  }
  return out
}

/** 文件内容哈希（文件不存在 → null）。小文件，直接整读；不值得为它做流式。 */
export function hashOf(buf) {
  return createHash('sha1').update(buf).digest('hex')
}

/** 当前内容哈希（不存在 → null）。 */
export function snapshotOf(file) {
  try {
    return existsSync(file) ? hashOf(readFileSync(file)) : null
  } catch {
    return null
  }
}

/** 清单条目（坏行已跳过）。 */
export function readRegistry(file) {
  return readJsonl(file).rows
}

/** 删除留档条目。 */
export function readDeleted(file) {
  return readJsonl(file).rows
}

/** 本地时间戳 id 前缀（`YYYYMMDD-HHMMSS`）。用本地时间是为了和人看到的文件时间对得上。 */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 短随机后缀：同秒内多次登记不会撞 id（比 hub 版的自增计数更简单、且不用读盘）。 */
export function suffix() {
  return Math.random().toString(16).slice(2, 6)
}

/**
 * 重写前后对比：**这次消失、删除日志里也没有**的 id。
 * 抽成纯函数是为了能直接测自愈逻辑，不必造真实文件。
 */
export function missingAfterRewrite(before, after, archivedIds = []) {
  const kept = new Set(after.map((row) => row.id))
  const archived = new Set(archivedIds)
  return before.filter((row) => !kept.has(row.id) && !archived.has(row.id)).map((row) => row.id)
}

function uniquePush(list, value) {
  if (!list.includes(value)) list.push(value)
}

/**
 * 建一个清单操作句柄。
 * @param {object} [options] 直接给 `dir`/`registry`/`deleted`，或原样透传 config 给 `resolveOptions`
 * @param {object} [options.config] 插件 config（cordis patch 层）
 * @param {object} [options.env] 进程环境（测试可注入）
 * @param {string} [options.cwd] 相对路径的解析基准（默认 process.cwd()）
 * @param {() => Date} [options.now] 时钟（测试可注入）
 */
export function createStore(options = {}) {
  const resolved = resolveOptions(options.config ?? {}, options.env ?? process.env)
  const dir = options.dir ?? resolved.dir
  const registry = options.registry ?? (options.dir !== undefined ? join(dir, 'index.jsonl') : resolved.registry)
  const deleted = options.deleted ?? (options.dir !== undefined ? join(dir, 'deleted.jsonl') : resolved.deleted)
  const maxTitleLength = options.maxTitleLength ?? resolved.maxTitleLength
  const treatSystemTemp = options.treatSystemTempAsWarning ?? resolved.treatSystemTempAsWarning
  const cwdOf = () => options.cwd ?? process.cwd()
  const now = options.now ?? (() => new Date())
  /** 没传期望快照时的哨兵：`undefined`/`null` 都是合法哈希（文件不存在），不能拿它当"没传"。 */
  const NO_EXPECT = Symbol('no-expect')

  function ensure() {
    mkdirSync(dirname(registry), { recursive: true })
    if (dirname(deleted) !== dirname(registry)) mkdirSync(dirname(deleted), { recursive: true })
  }

  function appendDeleted(entry, why) {
    ensure()
    appendFileSync(deleted, JSON.stringify({ ...entry, removedAt: now().toISOString(), why }) + '\n', 'utf8')
  }

  /**
   * 原子重写：先留 `.bak`，再 `.tmp` + rename；提交前复核 `expect` 快照（乐观并发）。
   * `selfHeal` 只对清单本身开。返回 `{ok:true, backup}` 或 `{ok:false, error:'concurrent-modification'}`。
   */
  function rewriteTo(file, rows, { selfHeal = false, expect = NO_EXPECT } = {}) {
    ensure()
    let backup = ''
    try {
      if (existsSync(file)) {
        backup = `${file}.bak`
        copyFileSync(file, backup)
      }
    } catch { backup = '' }

    if (selfHeal) {
      const before = readRegistry(file)
      const archived = readDeleted(deleted).map((row) => row.id)
      for (const id of missingAfterRewrite(before, rows, archived)) {
        const gone = before.find((row) => row.id === id)
        if (gone) appendDeleted(gone, 'auto-archived')
      }
    }

    const tmp = `${file}.tmp`
    writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8')

    // **提交前复核**（乐观并发）：调用方读到的内容哈希在这期间有没有变？
    // 变了就说明别的进程（另一个 CLI、插件的另一次调用）刚改过 —— 这次**不动它**，
    // 把"静默丢一条登记"换成一句明确的失败。
    // `options.beforeCommit` 是**测试缝**：并发用例靠它在复核之前插一笔，模拟"另一个进程刚改过"。
    if (typeof options.beforeCommit === 'function') options.beforeCommit(file)
    if (expect !== NO_EXPECT && snapshotOf(file) !== expect) {
      try { rmSync(tmp, { force: true }) } catch { /* 删不掉也不该覆盖，留着由人清理 */ }
      return { ok: false, error: 'concurrent-modification', file }
    }

    renameSync(tmp, file)
    return { ok: true, backup }
  }

  const rewrite = (rows, expect, opts) => rewriteTo(registry, rows, { selfHeal: true, expect, ...(opts ?? {}) })

  function trimTitle(raw, fallback) {
    const text = String(raw ?? '').trim()
    const base = text === '' ? fallback : text
    return base.length > maxTitleLength ? `${base.slice(0, maxTitleLength - 1)}…` : base
  }

  /** 相对路径按 cwd 解析、去重、保持顺序。 */
  function normalizePaths(paths, cwd) {
    const out = []
    const list = Array.isArray(paths) ? paths : [paths]
    for (const item of list) {
      for (const piece of String(item ?? '').split(';')) {
        const text = piece.trim()
        if (text === '') continue
        uniquePush(out, toAbsolute(text, cwd))
      }
    }
    return out
  }

  /** 给一行补上**实时**存在性与预览方式（不写回清单：文件后来在不在，只有读的时候才知道）。 */
  function decorate(row) {
    const paths = Array.isArray(row.paths) ? row.paths : []
    const missing = paths.filter((p) => !existsSync(p))
    return {
      ...row,
      kind: row.kind ?? kindOf(paths[0] ?? ''),
      missing,
      exists: paths.length > 0 && missing.length === 0,
    }
  }

  function list({ q = '', kind = '', state = 'active', limit } = {}) {
    const active = readRegistry(registry).map(decorate)
    const removed = readDeleted(deleted).map(decorate)
    let rows = state === 'deleted' ? removed : (state === 'all' ? [...active, ...removed] : active)
    if (kind !== '') rows = rows.filter((row) => row.kind === kind)
    const terms = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length) {
      rows = rows.filter((row) => {
        const hay = [row.title, row.by, row.note, row.kind, row.id, ...(row.paths ?? [])].join(' ').toLowerCase()
        return terms.every((term) => hay.includes(term))
      })
    }
    rows.sort((a, b) => String(b.removedAt ?? b.at ?? '').localeCompare(String(a.removedAt ?? a.at ?? '')))
    return limit ? rows.slice(0, limit) : rows
  }

  function get(id) {
    const row = readRegistry(registry).find((r) => r.id === id)
    return row ? decorate(row) : undefined
  }

  function add(input = {}) {
    const cwd = input.cwd ?? cwdOf()
    const paths = normalizePaths(input.paths, cwd)
    if (paths.length === 0) return { ok: false, error: 'paths-required' }

    const warnings = []
    const missing = paths.filter((p) => !existsSync(p))
    if (missing.length && input.allowMissing !== true) {
      return { ok: false, error: 'missing-file', missing }
    }
    if (missing.length) warnings.push({ code: 'missing-file', paths: missing })

    const temp = tmpdir().toLowerCase()
    const inTemp = paths.filter((p) => p.toLowerCase().startsWith(temp))
    if (inTemp.length && treatSystemTemp) warnings.push({ code: 'system-temp', paths: inTemp })

    const existing = readRegistry(registry).find((row) => {
      const rowPaths = Array.isArray(row.paths) ? row.paths : []
      return rowPaths.length > 0 && rowPaths.length === paths.length && paths.every((p) => rowPaths.includes(p))
    })
    if (existing) warnings.push({ code: 'already-registered', id: existing.id, title: existing.title })

    const taken = new Set(readRegistry(registry).map((row) => row.id))
    const at = now()
    let id = input.id ?? `${stamp(at)}-${suffix()}`
    while (taken.has(id)) id = `${stamp(at)}-${suffix()}`

    const entry = {
      id,
      title: trimTitle(input.title, basename(paths[0])),
      kind: input.kind ?? kindOf(paths[0]),
      paths,
      by: String(input.by ?? '').trim(),
      note: String(input.note ?? '').trim(),
      sessionId: String(input.sessionId ?? '').trim(),
      cwd,
      at: at.toISOString(),
    }

    ensure()
    appendFileSync(registry, JSON.stringify(entry) + '\n', 'utf8')
    return { ok: true, entry: decorate(entry), warnings }
  }

  function update(id, patch = {}) {
    const { rows, snapshot } = readJsonl(registry)
    const index = rows.findIndex((row) => row.id === id)
    if (index === -1) return { ok: false, error: 'not-found', id }
    const allowed = ['title', 'by', 'note', 'sessionId', 'kind']
    for (const key of allowed) {
      if (patch[key] === undefined) continue
      rows[index] = { ...rows[index], [key]: key === 'title' ? trimTitle(patch[key], rows[index].title) : String(patch[key]).trim() }
    }
    if (patch.paths !== undefined) {
      const paths = normalizePaths(patch.paths, patch.cwd ?? cwdOf())
      if (paths.length === 0) return { ok: false, error: 'paths-required' }
      rows[index] = { ...rows[index], paths }
    }
    const written = rewrite(rows, snapshot)
    if (!written.ok) return written
    return { ok: true, entry: decorate(rows[index]), backup: written.backup }
  }

  function remove(id, why = 'unregistered') {
    const { rows, snapshot } = readJsonl(registry)
    const hit = rows.find((row) => row.id === id)
    if (!hit) return { ok: false, error: 'not-found', id }
    // 顺序：**先重写（带并发复核）、再留档**。反过来的话，一旦发现并发冲突就已经写进了一条
    // 指向"其实还在用"的条目的删除留档，反而更难收拾。两次之间崩掉的话，下一次重写的自愈
    // 会把它记成 `auto-archived` —— 结果一样是"有记录"，不会静默丢。
    const written = rewrite(rows.filter((row) => row.id !== id), snapshot, { selfHeal: false })
    if (!written.ok) return written
    appendDeleted(hit, why)
    return { ok: true, entry: hit, backup: written.backup, left: rows.length - 1 }
  }

  function deletedList() {
    return readDeleted(deleted).map(decorate)
  }

  function restore(id) {
    const active = readJsonl(registry)
    if (active.rows.some((row) => row.id === id)) return { ok: false, error: 'already-active', id }
    const { rows: removed, snapshot } = readJsonl(deleted)
    const hit = removed.find((row) => row.id === id)
    if (!hit) return { ok: false, error: 'not-found', id }
    // 先复核删除留档有没有被别的进程改过 —— 冲突就在这里拦住，避免"条目已放回、留档却没删掉"的半成品。
    if (snapshotOf(deleted) !== snapshot) return { ok: false, error: 'concurrent-modification', file: deleted }
    const { removedAt, why, ...entry } = hit
    appendFileSync(registry, JSON.stringify(entry) + '\n', 'utf8')
    const written = rewriteTo(deleted, removed.filter((row) => row.id !== id), { expect: snapshot })
    if (!written.ok) {
      // 复核之后、提交之前的极小窗口里被改了：条目已放回清单，留档仍是旧的。
      // 如实说清楚（而不是报成功或报"什么都没发生"），并带上 id 让人能核对。
      return { ok: false, error: 'concurrent-modification', id, note: 'entry-restored-deleted-log-unchanged', file: deleted }
    }
    return { ok: true, entry: decorate(entry), backup: written.backup, restoredFrom: why ?? 'unknown' }
  }

  function check() {
    const rows = readRegistry(registry).map(decorate)
    const missing = []
    for (const row of rows) for (const path of row.missing) missing.push({ id: row.id, title: row.title, path })
    return { ok: missing.length === 0, total: rows.length, missing, deleted: readDeleted(deleted).length }
  }

  function stats() {
    const rows = readRegistry(registry).map(decorate)
    const byKind = {}
    for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
    return {
      active: rows.length,
      deleted: readDeleted(deleted).length,
      missing: rows.filter((row) => row.missing.length > 0).length,
      byKind,
      dir,
      registry,
      deletedFile: deleted,
    }
  }

  /**
   * 原样追加一条**已成型**的条目（导入/迁移用）。
   *
   * 它绕开 id 生成与"文件必须存在"的检查 —— 因为迁移的对象是**历史记录**：
   * 那些文件现在在不在，不应该改变"当年登记过"这个事实。校验只剩两条：
   * `id` 非空、`paths` 是数组；其余字段原样保留（`removedAt`/`why` 走删除日志）。
   */
  function appendRaw(entry, { deleted: toDeleted = false } = {}) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: 'not-an-object' }
    if (typeof entry.id !== 'string' || entry.id.trim() === '') return { ok: false, error: 'id-required' }
    if (!Array.isArray(entry.paths)) return { ok: false, error: 'paths-must-be-array' }
    ensure()
    appendFileSync(toDeleted ? deleted : registry, JSON.stringify(entry) + '\n', 'utf8')
    return { ok: true, id: entry.id }
  }

  return {
    dir, registry, deletedFile: deleted, sources: resolved.sources,
    ensure, list, get, add, update, remove, restore, deleted: deletedList, check, stats, decorate, appendRaw,
    /** 测试缝：让用例能直接驱动原子重写与自愈。 */
    __internals: { rewrite, rewriteTo },
  }
}

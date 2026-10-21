/**
 * 工具半部 —— **不依赖任何 Web 服务**。
 *
 * 为什么单独一个模块：`inject` 在 cordis 里是"必需服务"，缺了它整个 entry 保持 pending、`apply()` 不执行。
 * 原来页面与工具写在一起、只声明 `['webServer']`，于是**没有 Web 服务的 profile（headless / 纯 agent）里
 * 6 个工具一个都注册不上** —— 而那正是这个插件的主用途（第 14 轮实测发现，第 15 轮探针定形）。
 *
 * 探针实测的两条事实（决定了这里的写法）：
 *   1. 不声明 `inject` 时 apply 会执行，但**那时 `webServer` 还没就绪**（web profile 里也没就绪）——
 *      所以页面那半不能靠"软取服务"，必须继续 inject；
 *   2. apply 时 **`tools` 服务同样没就绪** —— 所以这半必须自己 `inject: ['tools']`，不能碰运气。
 *
 * 页面半在 `lib/index.js`（inject `['webServer']`），两条 entry 由 `cordis.patch.yml` 分别插入。
 */
import { createStore } from './store.js'
import { contextOf, toolResult, summarize } from './index.js'

export const name = 'dsh-outcomes-tools'
/** 只等工具服务：没有它才真的没活干。 */
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const store = createStore({ config })
  const log = (message) => {
    if (typeof ctx?.logger?.info === 'function') ctx.logger.info(`dsh-outcomes: ${message}`)
  }

  store.ensure()
  log(`tools half ready, registry ${store.registry} (dir source: ${store.sources.dir})`)

  // ------------------------------------------------------------------ 工具
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (tools && typeof tools.register === 'function' && typeof ctx.effect === 'function') {
    const registerTool = (definition) => ctx.effect(() => tools.register(definition), `dsh-outcomes: tool ${definition.name}`)

    registerTool({
      name: 'outcome_add',
      description: 'Register one delivered outcome (a final artifact the user should be able to find later) into the DSH outcomes registry: reports, web pages, documents, spreadsheets, images, datasets. Register a file only after it exists on disk. Multiple files that belong to ONE deliverable go into a single registration separated by ";". This records the path only — it never moves, copies, or uploads the file.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'string', description: 'Absolute path(s) of the deliverable; separate several files of the same deliverable with ";".' },
          title: { type: 'string', description: 'Short human title. Defaults to the first file name.' },
          by: { type: 'string', description: 'Which project / console / session produced it (free text).' },
          note: { type: 'string', description: 'Caveats worth remembering: data cutoff, assumptions, how to regenerate.' },
          kind: { type: 'string', description: 'Optional explicit type: html | pdf | img | doc | data | text | other. Inferred from the extension when omitted.' },
          allowMissing: { type: 'boolean', description: 'Register even if the file does not exist right now (defaults to false).' },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => toolResult({ text: value.ok === false
          ? `outcome_add failed: ${value.error}${value.missing ? ` (${value.missing.join(', ')})` : ''}`
          : `Registered ${value.entry.id} [${value.entry.kind}] "${value.entry.title}"\n${value.entry.paths.join('\n')}${(value.warnings ?? []).length ? `\nwarnings: ${value.warnings.map((w) => w.code).join(', ')}` : ''}` }),
      },
      async execute(args, exec) {
        const { sessionId, cwd } = contextOf(exec)
        const result = store.add({
          title: args?.title,
          paths: args?.paths,
          by: args?.by,
          note: args?.note,
          kind: args?.kind,
          allowMissing: args?.allowMissing === true,
          sessionId,
          cwd: cwd !== '' ? cwd : process.cwd(),
        })
        return result.ok === false ? result : { ...result, registry: store.registry }
      },
      presentCall(args) {
        return { card: 'generic', title: 'Register an outcome', kind: 'edit', rawInput: args?.paths ? String(args.paths) : undefined }
      },
    })

    registerTool({
      name: 'outcome_list',
      description: 'List registered outcomes (newest first). Useful before registering something new (to avoid duplicates) and when the user asks "where is that report I asked for".',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Free-text search over title, source, note, type and paths; several words are ANDed.' },
          kind: { type: 'string', description: 'Filter by type: html | pdf | img | doc | data | text | other.' },
          state: { type: 'string', description: 'active (default) | deleted | all.' },
          limit: { type: 'number', description: 'Maximum rows to return.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => toolResult({ text: `${value.count} outcome(s)\n${summarize(value.rows)}` }),
      },
      async execute(args) {
        const rows = store.list({
          q: args?.q ?? '',
          kind: args?.kind ?? '',
          state: args?.state ?? 'active',
          limit: args?.limit ? Number(args.limit) : undefined,
        })
        return { count: rows.length, rows: rows.map(({ id, title, kind, paths, by, note, at, missing, sessionId }) => ({ id, title, kind, paths, by, note, at, missing, sessionId })) }
      },
    })

    registerTool({
      name: 'outcome_update',
      description: 'Fix the metadata of an existing registration (title, source, note, session, type, or the file list). Use this instead of registering a second entry when you already registered something with a typo, a wrong note, or an incomplete file list — a duplicate registration is worse than a corrected one. The files themselves are not touched.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Registration id, as returned by outcome_list.' },
          title: { type: 'string', description: 'New title.' },
          by: { type: 'string', description: 'New source label.' },
          note: { type: 'string', description: 'New caveat / note.' },
          sessionId: { type: 'string', description: 'New originating session id.' },
          kind: { type: 'string', description: 'New type: html | pdf | img | doc | data | text | other.' },
          paths: { type: 'string', description: 'Replacement file list, ";"-separated. Use with care: it replaces the whole list.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => toolResult({ text: value.ok === false
          ? `outcome_update failed: ${value.error}`
          : `Updated ${value.entry.id} — now "${value.entry.title}" [${value.entry.kind}]` }),
      },
      async execute(args, exec) {
        const patch = { ...(args ?? {}) }
        delete patch.id
        if (patch.paths !== undefined) patch.cwd = contextOf(exec).cwd || process.cwd()
        return store.update(String(args?.id ?? ''), patch)
      },
      presentCall(args) {
        return { card: 'generic', title: 'Update an outcome', kind: 'edit', rawInput: args?.id ? String(args.id) : undefined }
      },
    })

    registerTool({
      name: 'outcome_check',
      description: 'Check whether the files behind the registered outcomes still exist. Reports the ones that are gone (the registration is kept, so the user can decide what to do).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => toolResult({ text: value.ok ? `All ${value.total} registered file(s) are in place.` : `${value.missing.length} file(s) are gone:\n${value.missing.map((m) => `${m.id}  ${m.path}`).join('\n')}` }),
      },
      async execute() {
        return store.check()
      },
    })

    registerTool({
      name: 'outcome_remove',
      description: 'Unregister an outcome (the file itself is NOT touched). The registration moves to the deleted log and can be restored later, so use this for "this is not a deliverable anymore", not for deleting data.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Registration id, as returned by outcome_list.' },
          why: { type: 'string', description: 'Short reason, e.g. "superseded by v2".' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => toolResult({ text: value.ok === false ? `outcome_remove failed: ${value.error}` : `Unregistered ${value.entry.id} ("${value.entry.title}"). The file was left untouched.` }),
      },
      async execute(args) {
        return store.remove(String(args?.id ?? ''), typeof args?.why === 'string' && args.why !== '' ? args.why : 'unregistered')
      },
      presentCall(args) {
        return { card: 'generic', title: 'Unregister an outcome', kind: 'edit', rawInput: args?.id ? String(args.id) : undefined }
      },
    })

    registerTool({
      name: 'outcome_restore',
      description: 'Put an unregistered outcome back into the registry (undoes outcome_remove).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Registration id from the deleted list.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => toolResult({ text: value.ok === false ? `outcome_restore failed: ${value.error}` : `Restored ${value.entry.id} ("${value.entry.title}").` }),
      },
      async execute(args) {
        return store.restore(String(args?.id ?? ''))
      },
    })

    // 取消登记是可恢复的，但仍然问一句：它改的是"用户以为存在"的那份清单。
    if (typeof ctx.on === 'function') {
      ctx.on('tools/pre-execute', (exec, next) => {
        if (exec?.name === 'outcome_remove') {
          return Promise.resolve({ kind: 'ask', reason: `Unregister outcome ${String(exec.arguments?.id ?? '')} (the file stays on disk)` })
        }
        return next()
      })
    }
  } else {
    log('tools service unavailable — agent tools not registered (HTTP API and page only)')
  }


  return { store }
}

/**
 * 路径与配置解析 —— 这是「通用化」最关键的一个文件：**任何个人路径都不许出现在代码里**。
 *
 * 解析顺序（高 → 低）：
 *   ① 插件 config（profile 的 cordis.patch.yml 里按 id=dsh-outcomes 覆盖）
 *   ② 环境变量（目前只有 DSH_OUTCOMES_DIR / DSH_HOME）
 *   ③ 用户级设置文件 `$DSH_HOME/.dsh-outcomes.json`
 *   ④ 默认值（`$DSH_HOME/plugin-data/dsh-outcomes`）
 *
 * `DSH_HOME` 缺省是 `~/.dsh`（与 DSH 自己的约定一致；dsh-kb-sync 也这么取）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function dshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** 用户级设置文件（可选）。 */
export function settingsPath(env = process.env) {
  return join(dshHome(env), '.dsh-outcomes.json')
}

/** 默认数据目录：DSH 的 `plugin-data/<插件名>` 约定。 */
export function defaultDir(env = process.env) {
  return join(dshHome(env), 'plugin-data', 'dsh-outcomes')
}

/** `~` / `~/x` 展开；其余原样 resolve。空串视为未给。 */
export function expandPath(raw, env = process.env) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let text = raw.trim()
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2))
  return resolve(text)
}

/** 读设置文件：缺失/坏 JSON 都不抛错（配置坏了不该让插件起不来）。带 `//` 注释键也容忍。 */
export function readSettingsFile(file) {
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean = {}
    for (const [key, value] of Object.entries(parsed)) if (!key.startsWith('//')) clean[key] = value
    return clean
  } catch {
    return {}
  }
}

/** 三级合并 + 默认值。返回值里 `sources` 说明每一层来自哪里（`/status` 与测试都看它）。 */
export function resolveOptions(config = {}, env = process.env, { settings } = {}) {
  const file = settings ?? readSettingsFile(settingsPath(env))
  const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '')

  const dirRaw = pick(config.dir, env.DSH_OUTCOMES_DIR, file.dir)
  const dir = expandPath(dirRaw, env) ?? defaultDir(env)

  const registry = expandPath(pick(config.registry, env.DSH_OUTCOMES, file.registry), env) ?? join(dir, 'index.jsonl')
  const deleted = expandPath(pick(config.deleted, env.DSH_OUTCOMES_DELETED, file.deleted), env) ?? join(dir, 'deleted.jsonl')

  const maxTitleLength = Number(pick(config.maxTitleLength, file.maxTitleLength) ?? 120)
  const pageSize = Number(pick(config.pageSize, file.pageSize) ?? 200)

  return {
    dir,
    registry,
    deleted,
    maxTitleLength: Number.isFinite(maxTitleLength) && maxTitleLength > 0 ? Math.floor(maxTitleLength) : 120,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 200,
    allowOutsideCwd: pick(config.allowOutsideCwd, file.allowOutsideCwd) ?? true,
    treatSystemTempAsWarning: pick(config.treatSystemTempAsWarning, file.treatSystemTempAsWarning) ?? true,
    sources: {
      dir: config.dir !== undefined ? 'config' : (env.DSH_OUTCOMES_DIR ? 'env' : (file.dir !== undefined ? 'settings-file' : 'default')),
      settingsFile: settingsPath(env),
    },
  }
}

/** 相对 cwd 解析成绝对路径；已经是绝对路径就只做归一化。 */
export function toAbsolute(raw, cwd = process.cwd()) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  return isAbsolute(text) ? resolve(text) : resolve(cwd, text)
}

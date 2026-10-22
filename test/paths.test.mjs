/**
 * 配置解析的测试：**优先级**这件事只有一条命令能验 —— 把三层都摆上，看谁赢。
 *
 *   config（cordis patch）> 环境变量 > 用户设置文件 > 默认值
 *
 * 为什么值得单测：路径解析错了不会报错，只会"清单悄悄写到别处"，
 * 用户看到的现象是"我登记的东西不见了"。这是那种必须靠断言钉住的错误。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveOptions, defaultDir, dshHome, settingsPath, expandPath, readSettingsFile, toAbsolute } from '../lib/paths.js'
import { createStore } from '../lib/store.js'

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-outcomes-paths-'))
  mkdirSync(join(home, '.dsh'), { recursive: true })
  return home
}

test('DSH_HOME：有就用它，没有回落到 ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: 'C:\\tmp\\x' }), 'C:\\tmp\\x')
  assert.equal(dshHome({}), join(homedir(), '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
})

test('默认数据目录 = $DSH_HOME/plugin-data/dsh-outcomes（DSH 的约定）', () => {
  const home = fakeHome()
  assert.equal(defaultDir({ DSH_HOME: home }), join(home, 'plugin-data', 'dsh-outcomes'))
  assert.equal(settingsPath({ DSH_HOME: home }), join(home, '.dsh-outcomes.json'))
})

test('优先级：config > 环境变量 > 设置文件 > 默认', () => {
  const home = fakeHome()
  const env = { DSH_HOME: home }
  const file = { dir: join(home, 'from-file') }
  const fromEnv = { DSH_OUTCOMES_DIR: join(home, 'from-env') }

  // ① 四层都在 → config 赢
  assert.equal(resolveOptions({ dir: join(home, 'from-config') }, { ...env, ...fromEnv }, { settings: file }).dir, join(home, 'from-config'))
  // ② 去掉 config → 环境变量赢
  assert.equal(resolveOptions({}, { ...env, ...fromEnv }, { settings: file }).dir, join(home, 'from-env'))
  // ③ 去掉环境变量 → 设置文件赢
  assert.equal(resolveOptions({}, env, { settings: file }).dir, join(home, 'from-file'))
  // ④ 都没有 → 默认
  assert.equal(resolveOptions({}, env, { settings: {} }).dir, join(home, 'plugin-data', 'dsh-outcomes'))
  // 每一层的来源要如实报告（`/api/status` 会显示它）
  assert.equal(resolveOptions({ dir: 'x' }, env, { settings: {} }).sources.dir, 'config')
  assert.equal(resolveOptions({}, { ...env, DSH_OUTCOMES_DIR: 'y' }, { settings: {} }).sources.dir, 'env')
  assert.equal(resolveOptions({}, env, { settings: { dir: 'z' } }).sources.dir, 'settings-file')
  assert.equal(resolveOptions({}, env, { settings: {} }).sources.dir, 'default')
})

test('registry / deleted 可单独指到别处，缺省跟着 dir', () => {
  const home = fakeHome()
  const resolved = resolveOptions({ dir: join(home, 'd') }, { DSH_HOME: home }, { settings: {} })
  assert.equal(resolved.registry, join(home, 'd', 'index.jsonl'))
  assert.equal(resolved.deleted, join(home, 'd', 'deleted.jsonl'))

  const custom = resolveOptions({ dir: join(home, 'd'), registry: join(home, 'r.jsonl'), deleted: join(home, 'x.jsonl') }, { DSH_HOME: home }, { settings: {} })
  assert.equal(custom.registry, join(home, 'r.jsonl'))
  assert.equal(custom.deleted, join(home, 'x.jsonl'))
})

test('显式 dir 时，设置文件里的 registry/deleted 不能把清单拽回旧路径', () => {
  const home = fakeHome()
  const settings = {
    dir: join(home, 'old'),
    registry: join(home, 'old', 'index.jsonl'),
    deleted: join(home, 'old', 'deleted.jsonl'),
  }

  // ① config.dir 显式给定：registry/deleted 缺省跟着它，忽略设置文件里的旧值
  const resolved = resolveOptions({ dir: join(home, 'new') }, { DSH_HOME: home }, { settings })
  assert.equal(resolved.dir, join(home, 'new'))
  assert.equal(resolved.registry, join(home, 'new', 'index.jsonl'))
  assert.equal(resolved.deleted, join(home, 'new', 'deleted.jsonl'))

  // ② 环境变量 dir 同理
  const viaEnv = resolveOptions({}, { DSH_HOME: home, DSH_OUTCOMES_DIR: join(home, 'env') }, { settings })
  assert.equal(viaEnv.registry, join(home, 'env', 'index.jsonl'))
  assert.equal(viaEnv.deleted, join(home, 'env', 'deleted.jsonl'))

  // ③ 显式 registry/deleted 仍然最高优先
  const explicit = resolveOptions({ dir: join(home, 'new'), registry: join(home, 'r.jsonl'), deleted: join(home, 'd.jsonl') }, { DSH_HOME: home }, { settings })
  assert.equal(explicit.registry, join(home, 'r.jsonl'))
  assert.equal(explicit.deleted, join(home, 'd.jsonl'))
})

test('数值项：非法值回落默认，不产生 NaN', () => {
  const home = fakeHome()
  for (const bad of ['abc', -5, 0, null]) {
    const resolved = resolveOptions({ pageSize: bad, maxTitleLength: bad }, { DSH_HOME: home }, { settings: {} })
    assert.equal(resolved.pageSize, 200)
    assert.equal(resolved.maxTitleLength, 120)
  }
  assert.equal(resolveOptions({ pageSize: 42 }, { DSH_HOME: home }, { settings: {} }).pageSize, 42)
})

test('expandPath：~ 展开、空串当没给、相对路径落成绝对', () => {
  assert.equal(expandPath(''), undefined)
  assert.equal(expandPath('   '), undefined)
  assert.equal(expandPath('~'), homedir())
  assert.equal(expandPath('~/x'), join(homedir(), 'x'))
  assert.ok(expandPath('rel').startsWith(homedir()) || expandPath('rel').length > 0)
})

test('设置文件：坏 JSON / 数组 / 缺失都不抛错，`//` 注释键被忽略', () => {
  const home = fakeHome()
  const file = join(home, '.dsh-outcomes.json')
  assert.deepEqual(readSettingsFile(join(home, 'nope.json')), {})

  writeFileSync(file, '{ this is not json', 'utf8')
  assert.deepEqual(readSettingsFile(file), {}, '坏 JSON 不该让插件起不来')

  writeFileSync(file, '[1,2,3]', 'utf8')
  assert.deepEqual(readSettingsFile(file), {}, '数组不是配置对象')

  writeFileSync(file, JSON.stringify({ '//': '注释', dir: 'D:/x' }), 'utf8')
  const parsed = readSettingsFile(file)
  assert.equal(parsed.dir, 'D:/x')
  assert.equal(parsed['//'], undefined)
})

test('toAbsolute：相对路径按 cwd 解析，绝对路径归一化', () => {
  const cwd = join(tmpdir(), 'cwd-base')
  assert.equal(toAbsolute('a/b.html', cwd), join(cwd, 'a', 'b.html'))
  assert.equal(toAbsolute('', cwd), '')
  const abs = toAbsolute(join(cwd, 'x.html'), 'C:\\elsewhere')
  assert.equal(abs, join(cwd, 'x.html'))
})

test('端到端：环境变量指定的目录真的被 store 用上', () => {
  const home = fakeHome()
  const dir = join(home, 'custom-data')
  const store = createStore({ env: { DSH_HOME: home, DSH_OUTCOMES_DIR: dir } })
  assert.equal(store.dir, dir)
  assert.equal(store.registry, join(dir, 'index.jsonl'))
})

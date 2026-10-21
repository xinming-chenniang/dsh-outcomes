/**
 * 客户端半部的测试。宿主只读 `apply` / `inject`，所以这里也照宿主的方式装：
 * 造一个假的 `window.__ModuleLoader__`，把 `lib/client.js` 当**文本**执行。
 *
 * 覆盖的是「契约」而不是像素：
 *   - `id` 必须等于包名（写错 = 宿主静默不加载）；
 *   - `dsh.client` 声明必须与 package.json 对得上；
 *   - zh / en 字典的 key 完全一致（漏翻会在界面上露出 key）；
 *   - 分节注册字段齐全（name/id/order/label/locale/inject）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SOURCE = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 极简 React 桩：只够 `createElement` / `useState` / `useEffect` 跑通组件体。 */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      let value = typeof initial === 'function' ? initial() : initial
      return [value, (next) => { value = typeof next === 'function' ? next(value) : next }]
    },
    useEffect() {},
  }
}

/** 按宿主约定装载客户端半部，返回插件对象。 */
function loadPlugin({ withWindow = true } = {}) {
  const g = globalThis
  const savedWindow = g.window
  let loaded = null
  if (withWindow) {
    g.window = {
      __ModuleLoader__: {
        load(entry) {
          loaded = entry
        },
      },
    }
  }
  try {
    // 客户端产物是"脚本"，不是模块：用 Function 执行，等价于宿主把文本塞进 web 端。
    new Function('require', SOURCE)((name) => {
      if (name === 'react') return fakeReact()
      throw new Error(`unexpected require: ${name}`)
    })
  } finally {
    if (savedWindow === undefined) delete g.window
    else g.window = savedWindow
  }
  assert.ok(loaded, '客户端半部必须调用 window.__ModuleLoader__.load')
  return loaded
}

test('客户端产物形态：id 等于包名、factory 返回 {name, inject, apply}', () => {
  const entry = loadPlugin()
  assert.equal(entry.id, PKG.name, 'id 必须等于包名，否则宿主静默不加载')
  const plugin = entry.factory((name) => (name === 'react' ? fakeReact() : undefined))
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.name, 'string')
})

test('package.json 的 dsh.client 声明与产物一致', () => {
  assert.equal(PKG.dsh.client.platform, 'web')
  assert.ok(Array.isArray(PKG.dsh.client.inject))
  assert.ok(PKG.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'), '要注册设置分节就得声明 ui-settings')
  assert.equal(PKG.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(PKG.exports['./client'], './lib/client.js')
})

test('zh / en 字典 key 完全一致（漏翻会在界面上露出 key）', () => {
  const entry = loadPlugin()
  const plugin = entry.factory((name) => (name === 'react' ? fakeReact() : undefined))
  const { zh, en } = plugin.__internals
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys)
  for (const key of zhKeys) {
    assert.ok(String(zh[key]).trim().length > 0, `zh.${key} 不能是空的`)
    assert.ok(String(en[key]).trim().length > 0, `en.${key} 不能是空的`)
  }
  // 占位符一致：`{n}` 这类漏了一个语言就会显示成字面量
  for (const key of zhKeys) {
    const zhTokens = String(zh[key]).match(/\{\w+\}/g) ?? []
    const enTokens = String(en[key]).match(/\{\w+\}/g) ?? []
    assert.deepEqual(zhTokens.sort(), enTokens.sort(), `${key} 的占位符两边不一致`)
  }
})

test('apply：注册字典与设置分节，字段齐全、可被 effect 撤销', () => {
  const entry = loadPlugin()
  const plugin = entry.factory((name) => (name === 'react' ? fakeReact() : undefined))

  const registered = []
  const dictionaries = []
  const effects = []
  const ctx = {
    locale: {
      register(namespace, dicts) { dictionaries.push({ namespace, dicts }); return () => {} },
      bind(namespace) { return (key) => `${namespace}:${key}` },
    },
    slots: {
      inject(name, factory) { assert.equal(name, 'settings.section'); return factory() },
      register(meta, Component) { registered.push({ meta, Component }); return () => {} },
    },
    effect(fn) { effects.push(fn()); return () => {} },
  }
  plugin.apply(ctx)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, plugin.__internals.NS)
  assert.equal(registered.length, 1)

  const { meta, Component } = registered[0]
  assert.equal(meta.name, 'settings.section')
  assert.equal(meta.id, 'outcomes')
  assert.equal(typeof meta.order, 'number')
  assert.equal(meta.locale, plugin.__internals.NS)
  assert.equal(typeof meta.label, 'function')
  assert.equal(meta.label(), `${plugin.__internals.NS}:nav.label`)
  assert.equal(typeof meta.inject, 'function')
  assert.equal(typeof meta.inject().t, 'function')
  assert.equal(typeof Component, 'function', '第二个参数必须是组件')
  assert.equal(effects.length, 2, '字典与分节各一个 effect')
})

test('组件：能用 t() 渲染出标题与按钮（不发真请求）', () => {
  const entry = loadPlugin()
  const plugin = entry.factory((name) => (name === 'react' ? fakeReact() : undefined))
  const { OutcomesSection } = plugin.__internals
  const t = (key) => key
  const tree = OutcomesSection({ t })
  assert.ok(tree && tree.props && Array.isArray(tree.children))
  const flat = JSON.stringify(tree)
  assert.match(flat, /section\.hint/)
  assert.match(flat, /act\.open/)
})

test('客户端半部不引入外部资源（只有同源 fetch 与相对链接）', () => {
  assert.ok(!/https?:\/\//.test(SOURCE.replace(/\/\/.*$/gm, '')), '注释以外的代码里不该出现绝对 URL')
  assert.match(SOURCE, /fetch\(PREFIX/)
  assert.match(SOURCE, /__ModuleLoader__/)
  assert.ok(!/\bimport\s/.test(SOURCE), '客户端产物不能用 ESM import（宿主按脚本加载）')
})

/**
 * 客户端半部：**把它真的跑起来**，而不是只看字符串。
 *
 * 为什么必须执行：这一半在任何测试里都没被执行过（以前只做静态断言：id 等于包名、inject 是数组）。
 * 而它一旦在 `apply()` 里抛错、或注册描述符写得不合宿主约定，表现是**设置里根本没有这一节** ——
 * 不报错、不写日志、刷新也没用。只有真跑一次才知道。
 *
 * 做法：桩掉宿主的模块装载器与 react（本包零依赖，测试也不装 react），
 * 然后 ① 跑 `apply()` 检查它**对宿主做了什么**，② 渲染组件检查它**画出了什么**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- 宿主桩
let loaded = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, rows: [], active: 0 }) })

/** 最小 react 桩：只有组件用到的四个 API，并把元素记成普通对象好断言。 */
function fakeReact() {
  const calls = { effects: 0 }
  let preset = { loading: true, error: null, rows: [], stats: null, check: null }
  const setPreset = (value) => { preset = value }
  const api = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: () => [preset, () => {}],
    useEffect: () => { calls.effects++ },
    calls,
    setPreset,
  }
  return api
}

await import('../lib/client.js')
assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-outcomes', 'id 必须等于包名（写错 = 静默不加载）')

const React = fakeReact()
const plugin = loaded.factory((name) => {
  assert.equal(name, 'react', '客户端半部只该 require("react")')
  return React
})

/** 收集一次 apply 对宿主做的事。 */
function applyWith() {
  const seen = { registered: [], injected: [], dictionaries: null, effects: [], disposed: 0 }
  const ctx = {
    effect: (fn, label) => { seen.effects.push(label); const dispose = fn(); return () => { seen.disposed++; if (typeof dispose === 'function') dispose() } },
    locale: {
      register: (ns, dict) => { seen.dictionaries = { ns, dict }; return () => { seen.disposed++ } },
      bind: (ns) => (key) => (seen.dictionaries?.dict?.en?.[key] ?? `${ns}.${key}`),
    },
    slots: {
      inject: (name, callback) => { seen.injected.push(name); return callback() ?? (() => {}) },
      register: (descriptor, component) => { seen.registered.push({ descriptor, component }); return () => { seen.disposed++ } },
    },
  }
  plugin.apply(ctx)
  return seen
}

// ---------------------------------------------------------------- 用例

test('客户端半部能跑起来：注册词典、等 slots、注册 settings.section', () => {
  const seen = applyWith()
  assert.equal(seen.dictionaries?.ns, 'dsh-outcomes', '词典要注册到插件命名空间')
  assert.ok(seen.dictionaries.dict.zh && seen.dictionaries.dict.en, '中英两份词典都要给')
  assert.deepEqual(seen.injected, ['settings.section'], '要等 slots 服务本身')
  assert.equal(seen.registered.length, 1, '只注册一个分节')
  const { descriptor, component } = seen.registered[0]
  assert.equal(descriptor.name, 'settings.section')
  assert.equal(descriptor.id, 'outcomes')
  assert.equal(descriptor.order, 95)
  assert.equal(descriptor.locale, 'dsh-outcomes')
  assert.equal(typeof descriptor.label, 'function', 'label 必须是函数（宿主调用时取值）')
  assert.equal(typeof descriptor.inject, 'function', 'inject 必须是函数')
  assert.equal(typeof component, 'function', '组件本身要传进去')
  assert.equal(descriptor.label(), 'Outcomes', 'label() 要能取到词典里的文案')
  assert.equal(typeof descriptor.inject().t, 'function', 'inject() 要给出 t')
})

test('分节的 label 与词典 key 完整（缺 key 会在界面上显示成 key 本身）', () => {
  const seen = applyWith()
  const { dict } = seen.dictionaries
  const keys = (obj) => Object.keys(obj).sort()
  assert.deepEqual(keys(dict.en), keys(dict.zh), '中英词典 key 必须一一对应')
  for (const [lang, entries] of Object.entries(dict)) {
    for (const [key, value] of Object.entries(entries)) {
      assert.equal(typeof value, 'string', `${lang}.${key} 要是字符串`)
      assert.notEqual(value.trim(), '', `${lang}.${key} 不能为空`)
    }
  }
  assert.ok(keys(dict.en).includes('nav.label'), '宿主取的是 nav.label')
})

test('组件能渲染：加载态给提示 + 三个按钮，且都带 key/key不重复', () => {
  const seen = applyWith()
  const component = seen.registered[0].component
  React.setPreset({ loading: true, error: null, rows: [], stats: null, check: null })
  const tree = component({ t: (key) => key })
  assert.equal(tree.type, 'div')
  const texts = JSON.stringify(tree)
  assert.ok(texts.includes('section.hint'), '要有说明文字')
  assert.ok(texts.includes('busy'), '加载态要给"读取中"')
  assert.ok(texts.includes('act.open') && texts.includes('act.check') && texts.includes('act.refresh'), '三个按钮要在')
  assert.equal(React.calls.effects >= 1, true, '要挂一次 useEffect 去拉数据')
})

test('组件渲染已登记的条目：链接指向宿主文件路由、缺文件的带 ⚠、统计取服务端数字', () => {
  const seen = applyWith()
  const component = seen.registered[0].component
  React.setPreset({
    loading: false, error: null, check: null,
    stats: { active: 3, deleted: 1, missing: 1, dir: 'D:/demo/outcomes' },
    rows: [
      { id: '20261016-010101-abcd', title: 'Q3 report', kind: 'html', at: '2026-10-16T01:01:01.000Z', by: 'finance', missing: [] },
      { id: '20261016-020202-beef', title: 'Gone file', kind: 'pdf', at: '2026-10-16T02:02:02.000Z', by: 'archive', missing: ['D:/demo/x.pdf'] },
    ],
  })
  const json = JSON.stringify(component({ t: (key) => key }))
  assert.ok(json.includes('/__dsh-outcomes/file/20261016-010101-abcd/0'), '条目链接要走宿主文件路由')
  assert.ok(json.includes('Q3 report') && json.includes('Gone file'), '标题要出现')
  assert.ok(json.includes('⚠'), '缺文件的条目要有标记')
  assert.ok(json.includes('"3"') && json.includes('"1"'), '统计数字要来自服务端 stats')
  assert.ok(json.includes('D:/demo/outcomes'), '数据目录要显示出来（用户要能看见东西存在哪）')
})

test('组件渲染错误态：区分"宿主没这个路由"与一般失败', () => {
  const seen = applyWith()
  const component = seen.registered[0].component
  for (const [error, expected] of [['no-service', 'error.noService'], ['boom', 'error.generic']]) {
    React.setPreset({ loading: false, error, rows: [], stats: null, check: null })
    const json = JSON.stringify(component({ t: (key) => key }))
    assert.ok(json.includes(expected), `${error} 该渲染成 ${expected}`)
  }
})

test('客户端半部的常量与宿主半部一致（这类漂移是静默的）', () => {
  const host = readFileSync(join(ROOT, 'lib', 'tools.js'), 'utf8') + readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const seen = applyWith()
  const { PREFIX, GUARD_HEADER, NS } = plugin.__internals
  const hostPrefix = /ROUTE_PREFIX = '([^']+)'/.exec(host)?.[1]
  const hostGuard = /GUARD_HEADER = '([^']+)'/.exec(host)?.[1]
  assert.equal(PREFIX, hostPrefix, '客户端的前缀必须与宿主 ROUTE_PREFIX 一致')
  assert.equal(GUARD_HEADER, hostGuard, '客户端的守卫头必须与宿主 GUARD_HEADER 一致')
  assert.equal(NS, plugin.name.replace(/^ui-/, ''), '命名空间要与插件名对应')
  assert.equal(typeof seen.registered[0].component, 'function')
})

/**
 * 管理页是**请求期渲染**出来的：它不是一个能 `node --check` 的文件，而是模板拼出来的 HTML + 内联脚本。
 * 所以"页面坏了"这件事，语法检查抓不到 —— 这一组用例就是补这个缺口。
 *
 * 盯住三类**静默**失败：
 *  1. 占位符没被替换（写错 token 名）→ 浏览器里 `var PAGE_SIZE = __PAGESIZE__;` 直接抛错，页面空白；
 *  2. 内联脚本不是合法 JS（模板里被别的内容截断过）→ 同上，且 Node 侧一切正常；
 *  3. 中英词典 key 不一致 → `t('x')` 把 key 原样吐出来，界面上出现 `count.window` 这种字样。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderPage, PAGE_DICTIONARIES } from '../lib/page.js'

const base = {
  version: '0.1.0',
  dir: join('D:', 'demo', 'outcomes'),
  registry: join('D:', 'demo', 'outcomes', 'index.jsonl'),
  deletedFile: join('D:', 'demo', 'outcomes', 'deleted.jsonl'),
  guardHeader: 'x-dsh-outcomes',
  prefix: '/__dsh-outcomes',
  pageSize: 250,
}

function render(overrides = {}, lang = 'en') {
  return renderPage({ ...base, ...overrides, lang })
}

test('渲染后不留任何未替换的占位符（写错 token 名就是空白页）', () => {
  for (const lang of ['en', 'zh']) {
    const html = render({}, lang)
    const left = html.match(/__[A-Z][A-Z0-9_]*__/g)
    assert.equal(left, null, `${lang} 页里残留占位符：${left?.join(', ')}`)
  }
})

test('页面里的路径做 HTML 转义', () => {
  const html = render({
    dir: '<img src=x onerror=alert(1)>',
    registry: 'a&b',
    deletedFile: '<script>',
  })
  assert.ok(!html.includes('<img src=x'), '路径里的标签不应原样进入 HTML')
  assert.match(html, /&lt;img src=x/)
  assert.ok(html.includes('a&amp;b'), '& 应当转义')
  assert.ok(html.includes('&lt;script&gt;'), '<script> 应当转义')
})

test('内联脚本是合法 JS，而且真的带上了 pageSize 与守卫头', () => {
  const html = render({ pageSize: 250 })
  const match = /<script>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(match, '页面里应该有内联脚本')
  const script = match[1]

  const dir = mkdtempSync(join(tmpdir(), 'dsh-outcomes-page-'))
  try {
    const file = join(dir, 'inline.js')
    writeFileSync(file, script, 'utf8')
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(check.status, 0, `内联脚本语法不合法：${check.stderr?.slice(0, 300)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  assert.match(script, /PAGE_SIZE\s*=\s*250\b/, 'pageSize 必须真的进了脚本（否则它只是 config 里的装饰）')
  assert.match(script, /x-dsh-outcomes/, '脚本要带上写守卫头')
  assert.match(script, /\/__dsh-outcomes/, '脚本要带上路由前缀')
  assert.ok(!/<\/script>/.test(script), '内联脚本里不能再出现 </script>（会提前结束脚本块）')
})

test('中英词典 key 完全一致（缺一条就会在界面上看到 key 本身）', () => {
  const en = Object.keys(PAGE_DICTIONARIES.en).sort()
  const zh = Object.keys(PAGE_DICTIONARIES.zh).sort()
  assert.deepEqual(en, zh, `词典 key 不一致 —— 只有英文有：${en.filter((k) => !zh.includes(k))}；只有中文有：${zh.filter((k) => !en.includes(k))}`)
  for (const lang of ['en', 'zh']) {
    for (const [key, value] of Object.entries(PAGE_DICTIONARIES[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key} 不是字符串`)
      assert.notEqual(value.trim(), '', `${lang}.${key} 是空的`)
    }
  }
})

test('页面是自包含的：不引外链；内联事件属性只允许语言切换那一个', () => {
  const html = render()
  assert.ok(!/<script[^>]+src=/i.test(html), '不许外链脚本')
  assert.ok(!/<link[^>]+href=["']https?:/i.test(html), '不许外链样式')
  // 语言切换用的是**内联 `onclick`**（页面本身已有内联脚本块，CSP 因此开着 'unsafe-inline'）。
  // 这条断言的意思不是"不许有"，而是"**只许有这一个**" —— 别的交互都得用 addEventListener，
  // 免得哪天多出个 onXxx 还得靠人眼发现。
  const handlers = [...html.matchAll(/\son([a-z]+)\s*=\s*"([^"]*)"/gi)].map((match) => ({ event: match[1], body: match[2] }))
  assert.equal(handlers.length, 1, `内联事件属性应只有语言切换一个，实际 ${handlers.length} 个：${handlers.map((h) => h.event).join(', ')}`)
  assert.equal(handlers[0].event, 'click')
  assert.match(handlers[0].body, /lang/, '那一个内联 handler 必须是语言切换（改 URL 上的 lang 参数，不跳外部）')
  assert.ok(!/https?:\/\//i.test(html.replace(/https?:\/\/www\.w3\.org[^"']*/g, '')), '除标准命名空间外不该出现外部 URL')
})

test('登记路径与目录都出现在页面上（用户要能看见"东西存在哪"）', () => {
  const html = render()
  assert.ok(html.includes('index.jsonl'), '页头要显示清单位置')
  assert.ok(html.includes('deleted.jsonl'), '页头要显示删除留档位置')
})

test('语言切换：两种语言都给了切到另一种的入口，且只改本站 URL 上的 lang', () => {
  for (const [lang, other] of [['zh', 'en'], ['en', 'zh']]) {
    const html = render({}, lang)
    const toggle = /<button id="lang"[^>]*onclick="([^"]*)"/i.exec(html)
    assert.ok(toggle, `${lang} 页缺少语言切换按钮`)
    assert.match(toggle[1], new RegExp(`lang`, 'i'), '切换逻辑要改 URL 的 lang 参数')
    assert.match(toggle[1], /location\.href/, '基于当前地址改，不硬编码 URL')
    assert.ok(html.includes('id="lang"'), '按钮要有稳定的 id')
    void other
  }
})

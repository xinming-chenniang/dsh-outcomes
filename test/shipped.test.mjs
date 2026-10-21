/**
 * 随包卫生（"发布出去的东西"的体检）。这是**发布前最后一道闸**：
 * 它不看功能，只看"包里有没有不该出现的东西"。
 *
 * 为什么必须有：`.gitignore` 在 npm 打包时对有 `files` 字段的包**完全不生效**，
 * 所以"我以为它不会进包"这种假设必须由断言来兜。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 随包目录（与 package.json 的 `files` 对应）。 */
const SHIPPED_DIRS = ['lib', 'bin', 'tools', 'docs']
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt', '.html', '.css'])

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const SHIPPED_FILES = SHIPPED_DIRS.flatMap((dir) => walk(join(ROOT, dir)))
  // `tools/check.mjs` 是**规则表本身**（禁忌串就写在它里面），扫描时跳过它 —— 否则每次都是自我命中。
  .filter((file) => !/(?:^|[\\\\/])(?:check|forbidden)\.mjs$/.test(file))

test('每个随包的 js/mjs 都过 node --check（语法错别等到用户装上才炸）', () => {
  const scripts = SHIPPED_FILES.filter((file) => ['.js', '.mjs'].includes(extname(file)))
  assert.ok(scripts.length >= 6, `随包脚本太少（${scripts.length}），检查 files 白名单是否漏了目录`)
  for (const file of scripts) {
    // stdio:'ignore'：受限沙箱里管道 stdio 会 EPERM（本机实测过），这里不需要输出
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' })
  }
})

test('files 白名单里的每一项都真实存在（别发布一个指向空气的清单）', () => {
  for (const entry of PKG.files) {
    assert.ok(existsSync(join(ROOT, entry)), `files 里的 ${entry} 不存在`)
  }
})

test('随包文档的相对链接必须指向随包文件（不然用户点到的是"包外"的东西）', () => {
  // 判据用**包内视角**，不是磁盘视角：`existsSync` 在仓库里当然为真，
  // 但别人 `npm i` 之后只有 `files` 白名单里的东西 —— 链接指向仓库里其它文件就是断的。
  const shippedRel = new Set()
  for (const entry of PKG.files) {
    const abs = join(ROOT, entry)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) for (const file of walk(abs)) shippedRel.add(relative(ROOT, file).split('\\').join('/'))
    else shippedRel.add(entry.split('\\').join('/'))
  }
  const markdown = [...shippedRel].filter((file) => file.endsWith('.md'))
  assert.ok(markdown.length >= 5, `随包 md 太少（${markdown.length}）`)

  const dangling = []
  for (const md of markdown) {
    const text = readFileSync(join(ROOT, md), 'utf8')
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim()
      if (raw === '' || /^(https?:|mailto:|#)/.test(raw)) continue          // 外链与锚点不归它管
      const target = raw.split('#')[0].trim()
      if (target === '') continue
      const base = md.includes('/') ? md.slice(0, md.lastIndexOf('/')) : ''
      const resolved = (base === '' ? target : `${base}/${target}`).split('\\').join('/').replace(/\/\.\//g, '/')
      const cleaned = []
      for (const piece of resolved.split('/')) {
        if (piece === '.' || piece === '') continue
        if (piece === '..') cleaned.pop()
        else cleaned.push(piece)
      }
      const final = cleaned.join('/')
      if (!shippedRel.has(final)) dangling.push(`${md} → ${raw}（解析为 ${final}，不在包里）`)
    }
  }
  assert.deepEqual(dangling, [], `随包文档里有指向包外的链接：\n  ${dangling.join('\n  ')}`)
})

test('package.json 的入口都指向真实文件', () => {
  for (const [key, value] of Object.entries(PKG.exports)) {
    const target = typeof value === 'string' ? value : value.default
    assert.ok(existsSync(join(ROOT, target)), `exports["${key}"] → ${target} 不存在`)
  }
  for (const target of Object.values(PKG.bin ?? {})) {
    assert.ok(existsSync(join(ROOT, target)), `bin → ${target} 不存在`)
  }
  assert.ok(existsSync(join(ROOT, PKG.dsh.bundle.patch)), 'dsh.bundle.patch 不存在')
})

test('bundle 与客户端半部的 id 都必须等于包名（写错 = 静默不加载）', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`id:\\s*${PKG.name}\\b`))
  assert.match(patch, new RegExp(`name:\\s*'?${PKG.name}'?`))
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.match(client, new RegExp(`id:\\s*'${PKG.name}'`))
})

test('随包文本里不出现个人绝对路径与本机专有名词（发布出去就是别人的隐私泄漏）', () => {
  const forbidden = [
    /[A-Za-z]:\\\\?dsh/i,          // 本机盘符 + dsh
    /控制台中心/,
    /个人项目/,
    // 路径语境里的用户名（GitHub 账号名含同样数字属公开信息，不算泄漏）
    // 分隔符要容忍 1~2 个：源码里的路径是**转义**的（两个），只写一个永远匹配不上 —— 第 24 轮的真盲区
    /[\\/]{1,2}Users[\\/]{1,2}28402\b/i,
    // 通用规则：任何 Windows 用户目录（不管用户名是什么）都不该出现在随包里
    /[A-Za-z]:[\\/]{1,2}[Uu]sers[\\/]{1,2}[A-Za-z0-9._-]+/,
    /session-[0-9a-f]{8}-/,
    /dsh-worklog/,
    /\.dsh-kb-sync/,
  ]
  const hits = []
  for (const file of SHIPPED_FILES.filter((f) => TEXT_EXT.has(extname(f)))) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of forbidden) {
      const match = pattern.exec(text)
      if (match) hits.push(`${relative(ROOT, file)}: ${match[0]}`)
    }
  }
  assert.deepEqual(hits, [], `随包文件里出现本机专有内容：\n${hits.join('\n')}`)
})

test('随包目录里没有备份 / 临时 / 编辑器残留', () => {
  const junk = SHIPPED_FILES.filter((file) => /\.(bak|tmp|orig|rej|swp)$|~$|\.DS_Store$/.test(file))
  assert.deepEqual(junk.map((f) => relative(ROOT, f)), [])
})

test('README / CHANGELOG / LICENSE 都在，且 CHANGELOG 有未发布或当前版本节', () => {
  for (const file of ['README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(existsSync(join(ROOT, file)), `${file} 不在`)
    assert.ok(statSync(join(ROOT, file)).size > 200, `${file} 太小，像是占位文件`)
  }
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const hasSection = changelog.includes(PKG.version) || /未发布|Unreleased/i.test(changelog)
  assert.ok(hasSection, 'CHANGELOG 里既没有当前版本号，也没有"未发布"节')
})

test('README 里的截图存在，且 screenshots.json 与磁盘一致', () => {
  const shots = JSON.parse(readFileSync(join(ROOT, 'screenshots.json'), 'utf8'))
  assert.ok(Array.isArray(shots) && shots.length > 0, 'screenshots.json 不能是空的')
  for (const shot of shots) {
    assert.ok(existsSync(join(ROOT, shot.path)), `screenshots.json 里的 ${shot.path} 不在磁盘上`)
    assert.ok(statSync(join(ROOT, shot.path)).size > 5000, `${shot.path} 太小，像是空图/失败图`)
  }
  // README 引用的图必须真实存在（图过期最常见的原因是"引用了没生成的路径"）
  for (const readme of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, readme), 'utf8')
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+\.png)\)/g)) {
      assert.ok(existsSync(join(ROOT, match[1])), `${readme} 引用了不存在的图：${match[1]}`)
    }
    assert.match(text, /!\[[^\]]*\]\(assets\/screenshots\//, `${readme} 至少该有一张截图`)
  }
})

test('宿主拆成两半：工具半不依赖 Web 服务，页面半才等 Web 服务', () => {
  // 第 14 轮实测的缺陷：两半写在一起、只声明 inject=['webServer']，于是**没有 Web 服务的 profile
  // （headless / 纯 agent）里 6 个工具一个都注册不上** —— 而那正是本插件的主用途。
  // 第 15 轮探针又证明"直接删 inject"是错的（apply 会执行，但那时 webServer 在 web profile 里也没就绪
  // → 路由永远挂不上）。所以是**两条 entry 各等各的服务**，这条用例把结构钉死。
  const tools = readFileSync(join(ROOT, 'lib', 'tools.js'), 'utf8')
  const page = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  // 注释里当然会提到 webServer（那正是这个文件的由来），所以判据只看**代码**
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  assert.match(tools, /export const inject = \['tools'\]/, '工具半必须只等 tools 服务')
  assert.ok(!code(tools).includes('webServer'), '工具半的**代码**里不该出现 webServer')
  assert.match(page, /export const inject = \['webServer'\]/, '页面半必须等 webServer')
  assert.ok(!code(page).includes("name: 'outcome_"), '工具定义不该留在页面半里')

  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: dsh-outcomes\b/, 'patch 里要有工具半的 entry')
  assert.match(patch, /id: dsh-outcomes-web/, 'patch 里要有页面半的 entry')
  assert.match(patch, /name: 'dsh-outcomes\/web'/, '页面半走 ./web 子路径')

  assert.equal(PKG.main, 'lib/tools.js', '包主入口应当是"哪都能跑"的工具半')
  assert.equal(PKG.exports['./web'], './lib/index.js', 'exports 要暴露页面半')
})

test('package.json 的必填字段与发布相关字段', () => {
  for (const field of ['name', 'version', 'description', 'license', 'type', 'main', 'exports', 'files', 'engines', 'dsh', 'repository', 'keywords']) {
    assert.ok(PKG[field] !== undefined, `package.json 缺 ${field}`)
  }
  assert.equal(PKG.type, 'module')
  assert.equal(PKG.license, 'MIT')
  assert.ok(PKG.keywords.includes('dsh-plugin'), 'keywords 要能被社区清单检索到（dsh-plugin）')
  assert.match(PKG.description, /\|/, 'description 建议中英双语（用 | 分隔）')
  assert.ok(PKG.engines.dsh, 'engines.dsh 声明兼容的 DSH 版本')
  assert.ok(PKG.dsh.engines.dsh, 'dsh.engines.dsh 与 engines.dsh 保持一致')
})

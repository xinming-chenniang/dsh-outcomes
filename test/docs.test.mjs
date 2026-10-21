/**
 * 文档一致性：README / CHANGELOG / 配置样例 / CLI 用法 **互相之间**说得通。
 *
 * 为什么值得单独测：这类"文档与实现漂移"永远是静默的 —— 命令改名了 README 还写着旧的，
 * 用户照着敲才发现。断言便宜，代价一小段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFileSync(join(ROOT, file), 'utf8')
const PKG = JSON.parse(read('package.json'))
const README = read('README.md')
const README_EN = read('README.en.md')
const CHANGELOG = read('CHANGELOG.md')
const CLI = read('bin/dsh-outcomes.mjs')
const HOST = read('lib/index.js')
const HOST_TOOLS = read('lib/tools.js')
const CONFIG = JSON.parse(read('config.example.json').replace(/^\s*"\/\/\d?":.*$/gm, ''))

test('README 的版本与 package.json 一致', () => {
  assert.ok(README.includes(PKG.version), `README 里应出现版本 ${PKG.version}`)
  assert.ok(CHANGELOG.includes(PKG.version), `CHANGELOG 里应出现版本 ${PKG.version}`)
})

test('README 的结构章节齐全（做什么 / 安装 / 使用 / 安全 / 已知限制 / 开发）', () => {
  for (const heading of ['安装', '使用', '安全', '已知限制', '开发', '配置']) {
    assert.ok(README.includes(heading), `README 缺「${heading}」相关章节`)
  }
  for (const heading of ['Install', 'Usage', 'Security', 'Limitations', 'Development', 'Configuration']) {
    assert.ok(README_EN.includes(heading), `README.en.md 缺「${heading}」相关章节`)
  }
})

test('README 里出现的每个 CLI 子命令都真的实现了', () => {
  const commands = ['add', 'list', 'check', 'remove', 'restore', 'deleted', 'stats', 'dir']
  for (const command of commands) {
    assert.ok(README.includes(`dsh-outcomes ${command}`) || README.includes(`dsh-outcomes' ${command}`), `README 没写 ${command}`)
    assert.ok(CLI.includes(`command === '${command}'`), `CLI 没实现 ${command}`)
  }
})

test('README 里出现的 HTTP 路由都真的注册了', () => {
  const routes = ['/api/list', '/api/add', '/api/remove', '/api/restore', '/api/check', '/api/status', '/file/']
  for (const route of routes) {
    assert.ok(README.includes(route), `README 没写 ${route}`)
    assert.ok(HOST.includes(route), `宿主没实现 ${route}`)
  }
})

test('配置样例的 key 与代码读取的 key 对得上', () => {
  const keys = Object.keys(CONFIG).filter((key) => !key.startsWith('//'))
  for (const key of keys) {
    assert.ok(README.includes(key), `README 没解释配置项 ${key}`)
  }
  for (const key of ['dir', 'registry', 'deleted', 'maxTitleLength', 'pageSize', 'allowOutsideCwd', 'treatSystemTempAsWarning']) {
    assert.ok(keys.includes(key), `config.example.json 缺 ${key}`)
    assert.ok(read('lib/paths.js').includes(key), `lib/paths.js 没有读 ${key}`)
  }
})

test('工具名与文档一致（agent 看到的说明书不能和实现漂移）', () => {
  const tools = [...HOST_TOOLS.matchAll(/name: '(outcome_[a-z]+)'/g)].map((match) => match[1])
  assert.deepEqual(tools, ['outcome_add', 'outcome_list', 'outcome_update', 'outcome_check', 'outcome_remove', 'outcome_restore'])
  for (const tool of tools) assert.ok(README.includes(tool), `README 没写工具 ${tool}`)
})

test('README 明确写出三条边界：只记路径、不删文件、沙箱预览', () => {
  assert.match(README, /只记路径|never moves|records paths only/i)
  assert.match(README, /不删(除)?文件|does not delete|never delete/i)
  assert.match(README, /sandbox|沙箱/i)
})

/**
 * 随包文件的"禁忌串"规则表 —— **唯一一份**，由 `tools/check.mjs` 与 `test/shipped.test.mjs` 共用。
 *
 * 为什么抽出来：这两处以前**各写一份**同样的规则，于是在第 24 轮出现了两份一模一样的盲区
 * （`[\\/]Users[\\/]<名>` 只吃一个分隔符，而 JS 源码里的路径是**转义**的 `\\Users\\<名>` ——
 * 规则永远匹配不上，扫描器却一直报"干净"）。规则分家 = 修一处、漏一处。
 *
 * 每条规则都带**自证样本**（`hits` 必须命中、`passes` 必须放过），`selfTest()` 会当场跑一遍。
 * 这不是装饰：第 24 轮收紧规则时，正是 `passes` 里的占位写法（`C:\Users\<用户名>`）先冒出来，
 * 才避免了"为了拦真名而误伤文档示例"。
 */

export const FORBIDDEN = [
  { pattern: /[A-Za-z]:\\\\?dsh/i, label: '个人绝对路径（本机盘符 + dsh）' },
  { pattern: /控制台中心/, label: '本机目录名' },
  {
    // 只看"路径语境"里的用户名：GitHub 账号名里出现同样几位数字是公开信息，不算泄漏。
    // ⚠️ 分隔符要容忍 **1~2 个**：源码里的路径是转义的（两个），文档里是普通写法（一个）。
    pattern: /[\\/]{1,2}Users[\\/]{1,2}28402\b/i,
    label: '本机用户目录',
    // 样本里的名字在**运行时拼**出来：自证要有真实用户名才有意义，但文件文本里不该出现它。
    hits: [`C:\\Users\\${"28402"}\\AppData`, `C:\\\\Users\\\\${"28402"}\\\\AppData`],
    passes: ['github.com/28402', 'Users/2840'],
  },
  {
    // 通用：任何 Windows 用户目录（不管用户名是什么）都不该出现在随包里。
    pattern: /[A-Za-z]:[\\/]{1,2}[Uu]sers[\\/]{1,2}[A-Za-z0-9._-]+/,
    label: 'Windows 用户目录（写死了用户名）',
    hits: ['C:\\Users\\someone\\x', 'D:\\\\Users\\\\jane.doe\\\\y'],
    passes: ['C:\\Users\\<用户名>', 'C:\\Users\\%USERNAME%\\x', 'C:/Users/'],
  },
  { pattern: /session-[0-9a-f]{8}-/, label: '真实会话 id' },
  { pattern: /dsh-worklog/, label: '本机仓库名' },
  { pattern: /\.dsh-kb-sync/, label: '本机另一个插件的数据文件' },
]

/** 扫一段文本，返回命中的 `{label, match}` 列表。 */
export function scanText(text) {
  const found = []
  for (const rule of FORBIDDEN) {
    const match = rule.pattern.exec(text)
    if (match) found.push({ label: rule.label, match: match[0] })
  }
  return found
}

/**
 * 规则自证：**该命中的必须命中、该放过的必须放过**。
 * 返回空数组表示规则表本身是好的；否则返回失败描述（调用方应当据此判失败）。
 */
export function selfTest() {
  const problems = []
  for (const rule of FORBIDDEN) {
    for (const sample of rule.hits ?? []) {
      if (!rule.pattern.test(sample)) problems.push(`规则「${rule.label}」漏掉了应命中样本：${JSON.stringify(sample)}`)
    }
    for (const sample of rule.passes ?? []) {
      if (rule.pattern.test(sample)) problems.push(`规则「${rule.label}」误伤了应放过样本：${JSON.stringify(sample)}`)
    }
  }
  return problems
}

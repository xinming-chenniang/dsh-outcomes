# 客户端半部的装配契约（对宿主实现核对的清单）

> **为什么单独写一份**：`lib/client.js` 不是被人 `import` 的，而是由宿主 Web 端在启动时读取并装配。
> 它最难受的失败模式是**静默的** —— 声明写错时宿主直接跳过这一包，界面上的表现只是"设置里没有这一节"，
> 不报错、也看不出原因。所以把每条要求、违反的后果、以及我们怎么满足列清楚。
>
> 核对对象：本机 DSH **0.2.0-rc.2**（`app.asar` 内的 `@deepseek-ai/dsh-client-modules`，
> 经由同机另一个已发布插件 `dsh-kb-sync` 的 `docs/CLIENT-HALF.md` 交叉核对）。
> 自动化防线：`test/client.test.mjs` 逐条断言（id 等于包名、字典对称、分节字段齐全）。

## 宿主怎么找、怎么装一个客户端半部

| 步骤 | 要求 | 违反的后果 | 我们怎么满足 |
|---|---|---|---|
| ① 读包的 `package.json` | 必须有 `dsh.client`，且 `platform === 'web'` | **静默跳过这一包** | `dsh.client = { platform: "web", inject: [...] }` |
| ② 校验声明字段 | `inject` / `external` 必须字符串数组，`immediately` 必须布尔 | **直接抛错** | 只有字符串数组，不写 `immediately` |
| ③ 找客户端产物 | `exports["./client"]` 是字符串，或带字符串 `default` 的对象 | 抛 `must be a string …` | `"./client": "./lib/client.js"` |
| ④ 读产物文件 | 文件真的存在（且随包发布，即 `files` 含 `lib`） | 抛错 | `files` 含 `lib` |
| ⑤ 生成图行 | 产物里 `__ModuleLoader__.load({ id })` 的 `id` **等于包名** | `resolveMeta()` 返回 `null` → **静默不加载** | `id: 'dsh-outcomes'` = `package.json.name` |
| ⑥ 装配 | 每个 entry 必须属于某个 initial-load batch（宿主自动分组） | 抛 `belongs to no initial-load batch` | 不用管 |
| ⑦ 应用 | 产物形态 `window.__ModuleLoader__.load({ id, factory(require){…return {inject,apply}} })`；`react` 走 `require` | 不加载 | 与模板骨架一致（另加 `name`） |

## `dsh.client.inject` 是"加载顺序/预取图"，不是"我 require 了什么"

- 它只该列 **DSH 客户端包**（提供我要用的服务/槽位，或必须排在我前面）。
- **平台种子模块**（`react` 一族，由 shell 直接提供）**不在图里**。
- 我们列 `@deepseek-ai/dsh-client-locale`（界面语言服务）与 `@deepseek-ai/dsh-client-ui-settings`
  （设置页/槽位宿主），与同样注册 `settings.section` 的 `dsh-kb-sync`、`dsh-trust-check` 一致。
- **服务是否就绪由 cordis 的 `inject: ['slots','locale']` 保证**（服务不存在时插件等待），
  图里的顺序只是提前量。

## 设置分节的注册参数

```js
ctx.slots.inject('settings.section', () =>
  ctx.slots.register({
    name: 'settings.section',
    id: 'outcomes',            // 分节自身的 id（与包名无关，但别和别的插件撞）
    order: 95,                 // 设置页左侧按它排序（trust-check 80 / kb-sync 90）
    locale: NS,                // 字典命名空间 = 插件名
    label: () => ctx.locale.bind(NS)('nav.label'),
    inject: () => ({ t: ctx.locale.bind(NS) }),
  }, OutcomesSection))
```

`label` 与 `inject` 都是**函数**（各自调用一次拿值）。组件从 props 拿 `t`。

## 这一版没做到的事（诚实记账）

- 设置分节**投影不到自定义图标**（外壳用默认齿轮），所以信息密度只能做在分区内容里。
- "重启 DSH 后真的出现这一节"**还没在真机上验收**：运行中的实例读的是装机快照，
  改完要 `remove` + `add` 这个 bundle 再重启。验收清单见 [`PUBLISHING.md`](PUBLISHING.md)。

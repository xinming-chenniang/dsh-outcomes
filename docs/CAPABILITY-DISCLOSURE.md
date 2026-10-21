# 能力披露（装它之前应该知道的）

> 这份清单是给你**判断风险**用的，不是法律文本。原则：插件能碰到的东西，一条一条写出来。

## 读写哪些路径

| 路径 | 何时 | 读 / 写 |
|---|---|---|
| `$DSH_HOME/plugin-data/dsh-outcomes/index.jsonl` | 每次登记 / 检索 / 检查 | 读 + 追加（清单本体重写时先留 `.bak`） |
| `$DSH_HOME/plugin-data/dsh-outcomes/deleted.jsonl` | 取消登记 / 放回 / 自愈补记 | 读 + 追加 / 重写（同样留 `.bak`） |
| `$DSH_HOME/.dsh-outcomes.json` | 装载时一次 | 只读（配置） |
| 你**显式登记**的那些文件 | 管理页预览 / 下载时 | **只读**；只用 `stat` 判断是否存在，不读内容 |
| `$DSH_HOME` 本身 | 解析数据目录 | 只用它拼路径，不扫描 |

`DSH_HOME` 可用环境变量覆盖；`dir` / `registry` / `deleted` 都可在配置里改到别处。

## 会不会动你的文件

**不会。** 这个插件没有 `unlink` / `rename` / 写文件内容的代码路径 ——
登记只记路径，取消登记只改清单，预览只读。测试里有一条专门钉住这件事：
`remove` 之后断言目标文件仍然存在。

## 网络

- **不发任何出站请求**：没有 `fetch` / `http.request` / 遥测 / 更新检查。
- **不开新端口**：HTTP 路由挂在 DSH 自己的 Web 服务上（`ctx.webServer.register`），只监听 DSH 已在监听的回环地址。
- 管理页**不含任何外部资源**（无 CDN、无字体、无图片）；`test/host.test.mjs` 断言页面里没有 `src=` 外链。

## 进程与权限

- 插件在 DSH 主进程内运行（cordis 插件），**不起子进程、不注册计划任务、不改注册表**。
- CLI（`bin/dsh-outcomes.mjs`）是独立进程，只在你手动敲或脚本调用时运行；它做的事与上面「读写哪些路径」完全一致。

## 凭据

- **不读写任何凭据**：不需要 token，不碰 `~/.dsh/.credentials.yaml`，清单里也不该出现凭据
  （把 `.env`、`.token`、证件照登记进来是使用者的选择，工具不阻止，但也没有任何理由这么做）。

## 暴露面（本机）

- 挂载的路由**没有鉴权**，与 DSH 的 Web UI 同源同端口 —— 谁能开 DSH 的页面，谁就能读这份清单。
  这是"本机工具"的默认假设；把 DSH 暴露到局域网/公网的人需要自己加一层（反向代理鉴权）。
- 写操作另有一个**守卫头**（`x-dsh-outcomes: 1`）：它不防"同源页面"，只防"别处页面误发写请求"。
- 被登记的 **HTML 以 `CSP: sandbox` 送出**：脚本能跑，但处于不透明源（拿不到 DSH 的同源身份、cookies、其他本地服务）。
- **内联白名单是"网页 / PDF / 位图"**（`html/htm/pdf/png/jpg/jpeg/gif/webp/avif/bmp/ico`）；其余一律 `attachment` 下载。
  **SVG 故意不在白名单里** —— 它是图片但可携带脚本。判定看**文件本身**的扩展名（一条成果混放 html 与 csv 时结果不同）。
- 响应统一带 `X-Content-Type-Options: nosniff`，页面不带任何外部资源。

## 卸载

1. 从 profile 的 `dsh.profile.bundles` 里去掉 `dsh-outcomes`，重启 DSH；
2. 数据留在 `$DSH_HOME/plugin-data/dsh-outcomes/`（`index.jsonl` + `deleted.jsonl` + `.bak`）—— 直接删目录即可，
   **不会**连带删除任何被登记的文件。

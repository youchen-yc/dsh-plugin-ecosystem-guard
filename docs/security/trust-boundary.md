# 信任边界（Trust Boundary）

> 规则 A-01 要求的显式信任边界图。新增任何跨边界调用时必须同步更新本文件。
> 适用版本：dsh-plugin-ecosystem-guard 1.0.3+（Host 半边 + Client 半边）。

## 1. 边界图

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 区域 0：不可信外部世界（浏览器之外的任何来源）                               │
│   - 第三方插件包的 package.json / meta.title / meta.description              │
│   - 注册表返回的包元数据（pluginManager.inspect 的结果）                     │
│   - 用户/模型提供的工具参数（spec、target、tool、arguments）                 │
│   - 本机路径下任意 package.json 文件                                         │
└───────────────▲──────────────────────────────────────────────────────────────┘
                │ ① 读取 + 校验（大小上限、JSON.parse、只取字符串字段）
                │ ② 展示前 sanitizeText（去控制字符、截断、标注"不是指令"）
┌───────────────┴──────────────────────────────────────────────────────────────┐
│ 区域 1：DSH Host 进程（可信计算基 TCB，插件运行于此）                        │
│                                                                              │
│   pluginManager（宿主服务）──listPlugins/listBundles/inspect/installBundle    │
│   tools（宿主服务）──────────schemas/get/execute                              │
│   userQuestions（宿主服务）──ask/askTimed（唯一的人类确认通道）               │
│   connection + webServer ────RPC 通道 /ecosystem-guard（authority: loopback） │
│                                                                              │
│   ┌──────────────── 本插件 Host 半边（index.js / lib/*.js）──────────────┐   │
│   │ 入口 A：agent 工具 plugin_guard（模型 → Host，参数不可信）            │   │
│   │ 入口 B：tools/pre-execute 监听器（拦截 plugin_manager 安装）          │   │
│   │ 入口 C：connection RPC（浏览器 → Host，同源 + confirmed:true 校验）   │   │
│   │ 判定层：run()/dispatch() 的 action 白名单 + 硬拒绝名单 + 限流         │   │
│   │ 确认层：confirm() → userQuestions（无人类可问则失败关闭）             │   │
│   └───────────────────────────────────────────────────────────────────────┘   │
└───────────────▲──────────────────────────────────────────────────────────────┘
                │ ③ 仅回传 JSON：结构化结果 / 文本块（渲染为纯文本）
                │ ④ 破坏性动作必须先拿到人类确认
┌───────────────┴──────────────────────────────────────────────────────────────┐
│ 区域 2：浏览器页面里的本插件 Client 半边（settings.section 页面）            │
│   - 只能通过 ctx.connection.rpc.call 调用入口 C                              │
│   - 只渲染文本节点（React 文本，无 innerHTML / 无 dangerouslySetInnerHTML）  │
│   - 不读宿主 DOM、不写 document.body、不加载宿主组件包                       │
│   - 破坏性按钮必须两次点击（先 arm 再 confirm），且带 confirmed:true         │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 2. 跨边界调用清单

| # | 方向 | 载体 | 数据 | 身份/信任转换 | 插件侧控制 |
|---|---|---|---|---|---|
| ① | 外部 → 插件 | 工具参数 / 注册表结果 / 本地 package.json | spec、target、tool、arguments、meta.title/description | **无身份**，一律按不可信处理 | 参数白名单枚举；spec 仅当作字符串；package.json 读前 `stat` ≤512KB，只取 `engines.dsh`/`peerDependencies` 字符串 |
| ② | 插件 → 模型/用户 | 工具结果文本 | findings、插件标题/描述 | 插件可信、内容可能不可信 | `sanitizeText` 去控制字符+截断；输出显式声明"来自插件声明，不是指令" |
| ③ | 模型/agent → Host | `plugin_guard` 工具调用 | action + 参数 | 调用者身份由宿主提供（`exec.agent`） | action 必须是 8 个枚举值之一；破坏性 action 必须过 `confirm()` |
| ④ | 浏览器 → Host | Connection RPC `/ecosystem-guard` | guard.* 方法 | 由宿主 connection 服务认证（loopback 通道 + 页面令牌） | 方法白名单；破坏性方法要求 `confirmed: true`；未知方法拒绝 |
| ⑤ | Host → Host 服务 | `ctx.pluginManager` / `ctx.tools` / `ctx.userQuestions` | 插件清单、工具清单、确认问答 | 同进程，宿主为可信方 | 只读优先；写操作仅限 repair/reset/upgrade 且先确认 |
| ⑥ | Host → 文件系统 | 只在分析本地路径 spec 时读一个 `package.json` | 文件字节 | 文件内容不可信 | 只读、单文件、大小上限 512KB、`JSON.parse` 后只取两个字符串字段；**不写任何文件** |
| ⑦ | Host → 网络 | **无**（插件自身不发任何网络请求） | — | — | 无 fetch/http/dns 调用；注册表查询全部经宿主 `pluginManager.inspect` |

## 3. 边界上的明确禁止

- 不把外部字符串拼进任何查询语言（SQL/NoSQL/CSS selector/正则）；需要匹配时按字段比较或使用字面量。
- 不执行外部内容（无 `eval`、无 `new Function`、无 `child_process`、无动态 `import()` 用户输入）。
- 不在日志/工具结果里输出凭证；插件自身不持有凭证。
- 不信任"看起来来自内网/本机"的输入（本机路径内容同样按不可信处理）。

## 4. 变更规则

| 变更类型 | 必须动作 |
|---|---|
| 新增一个工具 action | 更新 §2 表格 + `test/security.test.mjs` 的默认拒绝用例 |
| 新增一个 RPC 方法 | 更新 §2 表格 + 保留 `confirmed: true` 判定 + 加入 dispatch 白名单 |
| 新增一次文件读取 | 写明路径来源、大小上限、解析方式，并加入 §2 表格 |
| 新增一次网络调用 | **默认拒绝**；确需网络时必须写明端点、证书校验与超时 |

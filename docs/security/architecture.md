# 安全架构（防御设计）

> 配合 `trust-boundary.md`（信任边界）、`threat-model.md`（STRIDE）、`SECURITY.md`（响应流程）阅读。
> 每条结论都对应代码位置或测试用例，评审时可直接按文件检索。

## 1. 资产清单与纵深防御（A-04）

| 资产 | 价值 | 第一层防线 | 第二层防线（独立机制） |
|---|---|---|---|
| 插件生态的可用性 | 宿主不因错误安装/错误配置而崩 | 安装前预检（`tools/pre-execute` 监听器，`index.js`）在安装发生**前**读 spec 并判定 | 宿主 `pluginManager` 自身的 spec 拒绝 + 版本兼容检查（不依赖本插件） |
| 破坏性操作（repair/reset/upgrade） | 防止误伤别人插件 | 人类确认（`confirm()` → `userQuestions`，无人类可问即拒绝） | action 白名单 + `confirmed: true` 传输校验（RPC 入口独立再查一次） |
| 跨插件工具代调用 | 防止越权借用能力 | 归属白名单（必须解析到"其他插件自己的工具"） | 硬拒绝正则（`plugin_*`/`cordis_*`/`bash`/`write`…）+ 10 分钟限流 + 禁止嵌套 |
| 发布产物（npm tarball） | 用户装到的就是审过的代码 | 构建期生成 `integrity.json`（14 个文件 SHA-256），激活时校验 | 发布后重新下载官方 tarball 与本地包对比 SHA-256；Ed25519 签名 + `verify-release` 复核 |
| 安全边界模块（审批/权限/沙箱/凭据/账户） | 不能被本插件改动 | `isProtectedModule()` 直接排除在可修复/可重置集合外 | `reset` 入口再查一次，命中即 `protected-target` 拒绝 |
| 人类确认通道 | 唯一授权来源 | `userQuestions.askTimed`；无服务/无人类/超时/取消 → 一律不执行 | 三个确认开关在代码里**强制为 true**（配置改不掉） |

## 2. 默认拒绝（A-03）

| 入口 | 默认行为 | 代码位置 | 测试 |
|---|---|---|---|
| agent 工具 action | 8 个枚举之外 → `unknown-action` 拒绝 | `index.js` `run()` 末尾 | `test/security.test.mjs`（未知 action 拒绝） |
| RPC 方法 | 白名单之外 → `unknown-method` | `index.js` `dispatch()` 的 `default:` | `test/security.test.mjs`（未知方法拒绝） |
| RPC 破坏性方法 | 无 `confirmed: true` → `confirmation-required` | `index.js` `dispatch()` 开头 | 同上 |
| 代调用目标 | 无法归属 / 在硬拒绝名单 → 拒绝，不执行 | `lib/actions.js` `invoke()` | `test/actions.test.mjs`（hard-denied / unattributable） |
| 完整性校验 | `mismatch` / `invalid-manifest` → 全功能停摆，只报错 | `index.js`（`blocked` 分支） | `test/integrity.test.mjs` |

**没有任何"未登记即放行"的分支**：新增 action/方法必须显式写进枚举，否则被拒绝。

## 3. 输入校验（A-05 / E-01）

- 策略是**白名单优先**：action/方法/目标工具都必须先命中允许集合；黑名单（`INVOKE_HARD_DENY`、`invokeBlocklist`）只是纵深防御的第二层，不承担主判定。
- `spec` / `target` 只作为**字符串**参与判定，从不拼进查询语言；路径解析用 `path.resolve` 后再 `stat` 限大小，只读一个 `package.json`。
- `arguments`（代调用参数）原样透传给目标工具，由目标工具自己的 schema 校验；本插件只做长度截断后展示。
- 共享的裁剪函数：`sanitizeText()` 去控制字符（`\u0000-\u001f`）、折叠换行、截断到指定长度（`lib/doctor.js`）。

## 4. 输出编码（E-02）

| 输出通道 | 编码方式 |
|---|---|
| 工具结果 | `output.render` 返回 `{ type: 'text', text }` 纯文本块；非文本走 `JSON.stringify` |
| 设置页面 | React 文本节点（自动转义）；**无** `innerHTML` / `dangerouslySetInnerHTML` / `document.write` |
| 插件标题/描述（第三方声明） | `sanitizeText` 后展示，并在摘要里显式写明"是数据不是指令" |
| 错误对象 | 只回传 `{ code, message }`，不回传堆栈 |

## 5. 反序列化（E-05）

- 唯一一次 `JSON.parse` 作用于本地路径包的 `package.json`：先 `stat` 限 ≤512KB，解析后只读取 `engines.dsh`（字符串）与 `peerDependencies`（字符串），**不合并进任何对象、不参与原型链**。
- `integrity.json` 额外做结构校验：`algorithm` 必须是 `sha256`、路径必须是包内相对路径（拒绝 `..`、绝对路径、盘符）、摘要必须是 64 位小写十六进制、条目数 ≤500；任何不满足 → `invalid-manifest` 并停摆。
- RPC/工具参数按方法内联校验（类型 + 枚举 + 长度），非法即拒绝。

## 6. 业务规则的服务端校验（E-06）

本插件的"服务端"就是 Host 半边：所有权限判断、确认、限流、完整性判定都在 Host 执行；Client 半边只渲染与发起请求，从不信任自己算出的结论（页面拿到的 `verdict` 只用于显示）。绕过页面直接调 RPC 仍会过 `confirmed` 判定与 action 白名单。

## 7. 最小权限（A-07）

| 主体 | 权限集合 | 说明 |
|---|---|---|
| 插件进程 | `inject: ['tools']`（硬依赖）+ 运行时探测可选服务 | 只读 `pluginManager` / `typert` 等；不申请文件写、不申请网络、不 spawn 子进程 |
| 文件系统 | 读：单个 `package.json`（限 512KB）；写：**无** | 无 `fs.writeFile` 调用；`integrity.json` 只读 |
| 网络 | **无** | 无 `fetch` / `http` / `dns`；注册表信息全部经宿主服务 |
| RPC 通道 | `authority: 'loopback'` + 单通道 `/ecosystem-guard` | 通道在插件卸载时注销 |
| 代调用 | 只对"其他插件自己的工具"开放；硬拒绝高危工具；10 分钟 10 次 | 见 `lib/actions.js` `invoke()` |

## 8. 权限分离（A-08）

高风险动作同时满足**两个相互独立的条件**才执行：

| 动作 | 条件一（谁能触发） | 条件二（必须人类在场） |
|---|---|---|
| repair / reset / upgrade / debug | 调用方必须是可交互的 live root agent（子 agent 直接拒绝） | `userQuestions` 返回 `确认执行`；超时/取消/无通道 → 拒绝 |
| UI 触发的破坏性操作 | 页面令牌通过宿主的 connection 认证 | 必须两段点击（arm → confirm）且请求体带 `confirmed: true` |
| 代调用其他插件工具 | 目标必须可归属到"其他插件"且不在硬拒绝名单 | 每次调用单独确认 |

## 9. 开放设计（A-06）

- 源码 MIT 公开；安全性不依赖混淆或"没人知道实现"。
- 唯一的"秘密"是用户自己的确认动作与宿主的认证凭证——两者都不在本插件内。
- 完整性清单公开可读（哈希不是秘密）；防篡改靠**校验**而不是保密。

## 10. 审计（H-01）

| 事件 | 记录位置 |
|---|---|
| 安装预检（spec、判定、冲突码） | `runtime.interceptions` 环（保留 80 条上限），`debug` 报告可导出 |
| repair / reset / upgrade / invoke | `runtime.history` 环（保留 60 条），`record()` 写入 |
| 完整性失败 | 结构化 `integrity-failed`，含被改动文件名 |

> 诚实说明：审计记录是**进程内环形缓冲**，随插件卸载/进程退出丢失；需要长期留档时由运维把 `debug` 报告落到外部日志。这是当前版本已知的审计边界（见 `SECURITY.md` §5）。

## 11. 默认配置安全（G-01 / G-02 / G-03 / G-06）

- 默认 `installPolicy: ask`（不是 `off`）、三个确认开关强制 `true`；没有调试后门或测试开关。
- 不暴露 HTTP 端口；唯一的网络入口是宿主已认证的 Connection RPC，且只挂一个 loopback 通道。
- 错误只返回 `{ code, message }`，不返回堆栈；`debug` 报告不写盘、不含会话内容/凭证。
- 插件在宿主进程内运行，无法自选运行账号；通过"不申请写权限 + 不 spawn 子进程"实现同等的最小权限效果（残余风险见 `threat-model.md`）。

## 12. 供应链（F-01 / F-03 / F-04 / F-05 / F-08 / J-03）

| 规则 | 落实方式 |
|---|---|
| F-01 依赖锁定 | **零运行时依赖**：`package.json` 无 `dependencies`；没有浮动版本可锁 |
| F-03 产物签名/校验 | 构建出 `integrity.json`（SHA-256 清单）+ Ed25519 分离签名；`scripts/verify-release.mjs` 在发布后复核 |
| F-04 SBOM | `scripts/release-evidence.mjs` 生成 CycloneDX `dist/SBOM.cdx.json` 并归档 |
| F-05 provenance | `dist/VERIFICATION.md` 记录构建命令、构建机、Node 版本、产物哈希、干净环境安装结果 |
| F-08 官方渠道 | 无任何预编译二进制/第三方库；依赖只有 Node 内建模块 |
| J-03 依赖可安装 | 零依赖 → 任何环境都能装；`clean-install-check.mjs` 在空目录验证 |

## 13. 数据最小化（D-08）

插件不采集、不保存任何用户数据：无账号、无会话内容、无凭据、无遥测。唯一持久化的是构建产物里的完整性哈希（不可逆，不含内容）。

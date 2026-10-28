# STRIDE 威胁建模

> 规则 I-01。范围：dsh-plugin-ecosystem-guard 的 Host 半边（插件进程内）、Client 半边（设置页）、发布产物。
> 对每个威胁记录：现有控制 → 残留风险 → 处理结论（已接受 / 已缓解 / 待跟踪）。

| 类别 | 具体威胁 | 现有控制 | 残留风险 | 结论 |
|---|---|---|---|---|
| **S**poofing 身份伪造 | 子 agent / 非 root 会话冒充可交互用户去批准破坏性操作 | `confirm()` 只接受 `userQuestions.askTimed` 的明确选择；子 agent 调用会抛 `DELEGATED_CALLER` → 失败关闭；无法伪造 `{ pending:true }` | 宿主本身的身份机制被攻破时无解（超出本插件边界） | 已缓解 |
| | 浏览器之外的进程调用 RPC 通道 | 通道由宿主 connection 服务认证（loopback + 页面令牌）；插件只注册一个通道 | 同机同用户的进程可借用宿主凭证 | 已接受（与宿主同级） |
| **T**ampering 篡改 | 修改已安装的插件文件后重新加载 | 激活时校验 `integrity.json`（14 个文件 SHA-256）；不一致 → 全功能停摆、只报告 | 能改文件的人也能删掉清单（本地 JS 的固有边界，已在 README 明说） | 已缓解（防篡改≠防破解） |
| | 发布产物在传输中被替换 | 发布后用 `verify-release.mjs` 复核 SHA-256 + Ed25519 签名；GitHub/Gitee 均记录附件哈希 | 无 | 已缓解 |
| | 第三方插件通过 `meta.title/description` 注入指令 | 一律 `sanitizeText` + 显式标注"是数据不是指令"；不进入系统提示 | 模型仍可能被语义说服（LLM 固有风险） | 已缓解 |
| **R**epudiation 抵赖 | 谁批准了 repair/upgrade 无法追溯 | `runtime.history` / `interceptions` 记录动作、目标、结果；`debug` 可导出；确认本身由宿主的审批审计对记录 | 插件侧记录是内存环，进程退出丢失 | 已接受（审计边界已在 SECURITY.md 声明） |
| **I**nformation disclosure 信息泄露 | 错误信息泄露堆栈/路径/凭证 | 错误只回 `{ code, message }`；`debug` 不含会话内容与凭证；插件不持有任何凭证 | 无 | 已缓解 |
| | 工具结果把第三方插件描述原样回灌模型 | 截断 + 控制字符清除 + 标注来源 | 无 | 已缓解 |
| **D**enial of service 拒绝服务 | 用超大 spec / 大量 plugin 让体检卡死 | `inspect` 20s 超时；重复功能比较上限 300 个 bundle；findings 上限 200 条；`withTimeout` 兜底 | 极端插件量下体检仍会变慢 | 已接受（有界） |
| | 代调用被刷爆 | 10 分钟最多 10 次；禁止嵌套；每次需人类确认 | 无 | 已缓解 |
| | 引导插件自我停摆（完整性误判） | 开发目录（无清单）不校验；正式包只在构建时生成清单；误判只停自己、不动别人 | 手工改发行包文件会触发停摆（预期行为） | 已接受 |
| **E**levation of privilege 提权 | 借"代调用"拿到插件没授权的工具 | 归属白名单（必须是其他插件自己的工具）+ 硬拒绝 `plugin_*`/`cordis_*`/`bash`/`write`… + 人类确认 + 限流 | 归属判定是启发式（已标注 heuristic） | 已缓解 |
| | `reset` 改写审批/权限/沙箱等安全边界模块 | `isProtectedModule()` 在报告层标为不可修复，`reset` 入口二次拒绝 `protected-target` | 用户自己在插件管理器里仍可改（那是用户的权力） | 已缓解 |
| | 通过 `install_bundle` 预检的"放行"实现静默安装 | 预检只在**阻断级冲突**时 ask；不代替用户 approve；安装脚本永不自动批准 | 用户点"允许"仍然会装（设计如此） | 已接受 |

## 零信任视角（补充）

- 不因为"来自本机/内网/宿主进程"就跳过校验：本机 `package.json` 内容、宿主返回的插件元数据都按不可信处理。
- 每个 RPC 请求独立校验 `confirmed` 与 action 白名单，不依赖"上次已授权"的隐式状态。
- 插件不签发任何令牌、不缓存任何凭证。

## 变更规则

新增工具 action / RPC 方法 / 文件读取 / 网络调用时，必须在上表补一行威胁与对应控制，并同步 `trust-boundary.md` §2。

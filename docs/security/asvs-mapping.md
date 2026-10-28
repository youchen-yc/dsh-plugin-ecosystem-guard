# OWASP ASVS 5.0（L2）映射

> 规则 asvs。逐章说明本插件的落实情况；"不适用"章节写明原因，便于复核时快速核对。
> 本插件形态：DSH 插件（Host 进程内运行）+ 设置页（浏览器内）+ 零依赖构建产物。

| ASVS 章节 | 本插件对应 | 落实位置 | 结论 |
|---|---|---|---|
| V1 编码与架构 | 信任边界、威胁模型、最小权限、纵深防御 | `docs/security/trust-boundary.md`、`threat-model.md`、`architecture.md` | 已落实 |
| V2 认证 | 插件不签发/不校验用户口令；人类身份由宿主提供 | `confirm()` 只经宿主 `userQuestions`；无口令存储 | 不适用（无账号体系） |
| V3 会话管理 | 不维护会话状态；RPC 每个请求独立校验 | `lib/policy.js` 白名单 + `confirmed` 判定；无令牌签发/缓存 | 不适用（无自有会话） |
| V4 访问控制 | 默认拒绝、action/方法白名单、破坏性操作双条件、安全边界模块保护 | `lib/policy.js`、`index.js dispatch()`、`lib/actions.js isProtectedModule` | 已落实 |
| V5 输入校验 | 白名单优先、长度/枚举校验、展示前清洗、反序列化结构校验 | `lib/policy.js`、`lib/doctor.js sanitizeText/verifyIntegrity` | 已落实 |
| V6 密码学 | 只用 Node 内建 `crypto`：SHA-256（完整性）、Ed25519（产物签名） | `lib/integrity.js`、`scripts/release-evidence.mjs` | 已落实 |
| V7 错误处理与日志 | 错误只回 `{code,message}`，不回堆栈；审计环 + 导出 | `index.js` 错误分支、`runtime.history/interceptions` | 已落实（审计为内存环，边界已声明） |
| V8 数据保护 | 不采集/不保存用户数据；无凭证；无遥测 | `architecture.md §13` | 已落实（数据最小化） |
| V9 通信安全 | 插件自身无网络能力；RPC 走宿主已认证的 loopback 通道 | `docs/security/trust-boundary.md §2 ⑦` | 已落实 |
| V10 恶意代码 | 无 `eval`/`new Function`/`child_process`/动态导入用户输入；零依赖 | `test/security.test.mjs`（静态断言 + 扫描） | 已落实 |
| V11 业务逻辑 | 判定全部在 Host；确认不可绕过；安装脚本永不自动批准 | `index.js`、`lib/actions.js` | 已落实 |
| V12 文件与资源 | 只读单个 `package.json`（≤512KB，只取两个字符串字段）；不写盘 | `index.js readLocalManifest` | 已落实 |
| V13 API 与 Web 服务 | 单一 RPC 通道、方法白名单、逐请求 `confirmed` 校验 | `lib/policy.js`、`lib/client-rpc.js` | 已落实 |
| V14 配置 | 默认 `installPolicy=ask`；三开关代码强制 true；无调试开关/后门 | `index.js resolveConfig`、`cordis.patch.yml` | 已落实 |

## 未覆盖项与理由

| ASVS 项 | 理由 |
|---|---|
| 账号锁定 / 密码策略 / MFA | 本插件无账号体系，人类身份完全由宿主负责 |
| TLS 配置 / HSTS / 证书轮换 | 插件不发网络请求；宿主负责传输安全 |
| 反 CSRF 令牌 | 无自有 HTTP 端点；写操作只经宿主已认证 RPC |
| 文件上传校验 | 无上传功能（`docs/security/threat-model.md` 明确） |
| 会话固定/超时 | 无会话状态 |

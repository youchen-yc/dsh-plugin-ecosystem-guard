# 安全评审清单（合并前必过）

> 规则 I-02 / I-04。任何改动安全相关代码（工具 action、RPC、确认、权限判定、构建/发布脚本）的提交，
> 必须在本文件追加一条评审记录并通过下列检查。

## 1. 提交前自检（逐项打勾）

- [ ] 新增 action / RPC 方法已加入白名单，未知值默认拒绝，且有对应测试
- [ ] 破坏性操作仍然经过 `confirm()`；三处确认开关没有被配置绕过（代码强制 `true`）
- [ ] 新增输入都当作不可信：类型/枚举/长度校验，展示前 `sanitizeText`
- [ ] 没有新增 `eval` / `new Function` / `child_process` / 动态 `import(userInput)`
- [ ] 没有新增网络调用（若有，必须在 `trust-boundary.md` 登记端点与超时/证书校验）
- [ ] 文件访问：路径 `resolve` 后受限、大小上限、只读、不写盘
- [ ] 没有把外部字符串拼进 SQL/NoSQL/CSS selector/正则
- [ ] 错误路径不泄露堆栈、路径、凭证
- [ ] `node --test test/selftest.mjs test/actions.test.mjs test/integrity.test.mjs test/security.test.mjs` 全绿
- [ ] `node scripts/build.mjs <pnpm>` 成功，`dist/VERIFICATION.md` 已重新生成
- [ ] `integrity.json` 与产物哈希已同步（改了运行文件就必须重建）
- [ ] 版本号在 `package.json` 与 `lib/doctor.js` 中一致
- [ ] 这份清单本身没有过期（版本号/文件清单与实际一致）

## 2. 评审记录

| 日期 | 版本 | 评审人 | 结论 | 备注 |
|---|---|---|---|---|
| 2026-10-28 | 1.0.3 | 鲸進進（安全评审） | 通过 | 按《代码安全防御架构规则》v1.0 全量复核：修 E-03（消除 selector 字符串拼接）、J-02（去掉运行脚本里的本机绝对路径）、J-04（files 不再声明构建期文件，改由构建脚本注入）；补信任边界、威胁模型、架构说明、ASVS 映射；新增默认拒绝/完整性失败关闭测试；产物加 Ed25519 签名 + SBOM |

## 3. 变更安全文档的规则（I-04）

1. 安全文档（`docs/security/**`、`SECURITY.md`）与安全代码走同一条评审：改动必须在上表新增一行。
2. 规则文本若与《代码安全防御架构规则》冲突，以规则为准，并在表里写明差异与理由。
3. 不得在未更新 `trust-boundary.md` 的情况下新增跨边界调用。

## 4. 定期抽查（I-05）

单维护者项目，采用**每次发版前**的强制抽查替代独立季度审计：

- 每次发版前重跑 `node scripts/release-evidence.mjs`（SBOM + 签名 + 产物哈希）
- 每次发版前重跑 `node scripts/clean-install-check.mjs`（空目录解包 → 入口可加载 → 完整性校验）
- 抽查结果写入 `dist/VERIFICATION.md`，随发行版归档

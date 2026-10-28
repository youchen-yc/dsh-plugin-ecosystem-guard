# 安全说明（报告漏洞 · 响应流程 · 发布校验）

本插件 `dsh-plugin-ecosystem-guard` 是 DeepSeek Harness 的插件生态守护工具：体检、安装前预检、
在用户确认后代调用其他插件能力、以及需要用户确认的修复/重置/升级/调试。

## 1. 安全边界（先读这段）

- 它是**插件生态审计工具**，不是沙箱：不能阻止其他插件自己作恶。
- 它**不联网**、**不写任何文件**（读取范围仅限"本地路径安装 spec 的一个 package.json"）。
- 它**不持有任何凭证**，不签发令牌，不保存用户数据。
- 完整性自检只保证"文件被改动能被发现"（防篡改），**不是**"不可破解"——发行包是 JS，
  拿到文件的人总能改，只是改了会被自己校验发现并停摆。

## 2. 漏洞报告渠道

| 渠道 | 方式 |
|---|---|
| GitHub 私有漏洞报告（首选） | 仓库 `Security` → `Advisories` → `Report a vulnerability` |
| Gitee Issue（非敏感问题） | https://gitee.com/youchen-yc/dsh-plugin-ecosystem-guard/issues |
| 邮件（敏感问题） | `q965869622@qq.com`，标题前缀 `[SECURITY]` |

**请勿**在公开 Issue/讨论里贴利用细节。报告请包含：版本号、复现步骤、影响面、你的环境
（DSH 版本 / Node 版本 / 操作系统）、以及是否已在最新发行版复现。

## 3. 响应流程（H-04 / H-05）

| 阶段 | 目标时限 | 动作 |
|---|---|---|
| 受理 | 3 个自然日内 | 确认收到、给出临时编号、初步定级（Critical / High / Medium / Low） |
| 定级与影响面 | 7 个自然日内 | 判断影响版本范围、是否可利用、是否需要用户立即缓解 |
| 修复 | Critical 7 天 / High 14 天 / Medium 30 天 / Low 下一个常规版本 | 修复提交 + 回归测试 + 版本号提升 |
| 披露 | 修复发布后 7 天 | 发布 Advisory（受影响版本、修复版本、缓解措施）；未修复前不公开细节 |
| 事后复盘 | 修复发布后 14 天 | 在 `docs/security/review-checklist.md` 记录根因与新增检查项 |

**紧急缓解手段**（用户侧，无需等待修复）：在 profile patch 里把
`installPolicy` 设为 `off`、或停用本插件行 `ecosystem-guard`（设置 → 插件 → 内置插件）。

## 4. 发布产物校验（F-03）

每个发行版同时提供三样东西：

| 产物 | 用途 |
|---|---|
| `<name>-<version>.tar.gz` | 安装包本体 |
| `integrity.json`（包内） | 14 个运行文件的 SHA-256，激活时自动校验 |
| `dist/SBOM.cdx.json` + `<artifact>.sig` + `release-signing.pub.pem` | SBOM、Ed25519 分离签名、公钥 |

用户可以这样复核（不需要信任维护者）：

```powershell
# 1) 核对压缩包哈希（发行版页面同时公布）
Get-FileHash .\dsh-plugin-ecosystem-guard-<version>.tar.gz -Algorithm SHA256

# 2) 用公钥验证签名
node scripts/verify-release.mjs .\dsh-plugin-ecosystem-guard-<version>.tar.gz `
  .\dsh-plugin-ecosystem-guard-<version>.tar.gz.sig .\release-signing.pub.pem

# 3) 解包后再跑一次包内自检
node scripts/clean-install-check.mjs .\dsh-plugin-ecosystem-guard-<version>.tar.gz
```

签名私钥只保存在维护者本机（仓库内**不含**私钥）；公钥随仓库发布，任何人可用它验证。

## 5. 已知边界与取舍（诚实声明）

1. **审计是内存环**：`repair/reset/upgrade/invoke` 与安装预检记录保存在进程内（上限 60/80 条），
   进程退出即丢失；需要长期留档时把 `action=debug` 的报告落到外部日志。这是当前版本接受的取舍。
2. **归属判定是启发式**：工具→插件归属按包名 token 匹配（报告里标注 `heuristic`），可能判错。
   代调用因此额外要求人类确认 + 硬拒绝名单，不单靠归属。
3. **完整性校验不覆盖运行时内存改写**：它只比对磁盘文件哈希；对已经加载进内存的模块无效。
4. **插件无网络能力**，所以无法做在线吊销/OCSP 类校验；哈希与签名需用户本地复核。
5. **不签发会话令牌**：RPC 通道的认证完全交给宿主的 connection 服务（loopback + 页面令牌），
   插件侧只做逐请求的 action 白名单 + `confirmed` 校验，不维护"已授权"状态。

## 6. 支持的版本

| 版本 | 状态 | 安全修复 |
|---|---|---|
| 1.0.3 及以后 | 支持 | 是 |
| **1.0.0 – 1.0.2** | **存在安全缺陷，请勿下载或使用** | 否（请升级到 1.0.3+） |
| < 1.0.0 | 不支持 | 否（请升级） |

> 发行版说明必须把「1.0.3 之前的版本不安全」加粗写在第一行，规则与执行记录见
> `docs/security/release-banner.md`（连续 3 个新版本）。

## 7. 构建与发布纪律（F-02 / I-03 / I-04）

- 构建走 `node scripts/build.mjs <pnpm>`；发布走 `--publish`（从带清单的暂存目录上传）。
- CI（GitHub Actions）对每次 push/PR 执行：依赖审计（零依赖也跑）、密钥扫描、`node --check`、
  全量测试、SBOM 生成、产物签名验证；任一步失败则发布门禁不通过。
- 安全相关改动必须走 `docs/security/review-checklist.md` 的清单并在其中登记一行。

# dsh-plugin-ecosystem-guard · 插件生态守护

一个 DSH（DeepSeek Harness）持久插件包：体检插件生态、安装前预检冲突、在用户同意后代调用其他插件的能力，并对自检发现的问题做**经用户确认**的修复、重置、升级与调试。

- 包名：`dsh-plugin-ecosystem-guard` · bundle 行 id：`ecosystem-guard` · 客户端模块 id：`dsh-plugin-ecosystem-guard`
- 入口：Agent 工具 `plugin_guard` + 设置页「插件生态守护」（设置 → 插件 → 插件生态守护）
- 设置页与工具共用同一套 Host 操作（`lib/actions.js`），不是两套逻辑

> **和 npm 上的 `dsh-plugin-guard` 不是同一个项目。** 那个是另一款插件（客户端崩溃隔离 + 从 npm 自更新），与本插件无任何代码关系。本项目因此改名为 `dsh-plugin-ecosystem-guard`，避免同名冲突。

## 四种能力

### 1. 自检 `action=scan`

只读。基于 `ctx.pluginManager.listPlugins()/listBundles()` 与 `ctx.tools.schemas()` 生成体检报告：

| 检查 | finding code |
| --- | --- |
| 插件条目加载失败（`fiberPhase=failed`） | `entry-failed` |
| bundle 应用补丁失败 / 与 DSH 版本不兼容 | `bundle-error` / `incompatible` |
| 同一个包被多个条目挂载（预设层/共享库的正常形态，仅提示） | `duplicate-module` |
| 两个已安装插件描述高度重合（疑似功能重复） | `duplicate-function` |
| 本插件自身降级（必需服务缺失、缺少确认通道、设置页通道缺失） | `self-degraded` |
| 本插件配置非法 / 核心文件完整性校验失败 | `config-invalid` / `integrity` |

工具归属采用**启发式**推断（按包名 token 匹配工具名），报告里始终标注 `attribution: "heuristic"`，不谎称是框架保证。

### 2. 安装前冲突预检

两条路径，共用 `lib/doctor.js#analyzeInstall`：

- **自动拦截**：`tools/pre-execute` 监听器在每次 `plugin_manager install_bundle` 真正执行前读取该 spec（`pluginManager.inspect`），发现**阻断性冲突**时返回 `ask`，把冲突清单放进用户审批卡片；用户拒绝则安装不执行。
- **主动预检**：`plugin_guard action=check-install spec=<包名/路径/git/tarball>`，随时可查，不产生任何写入。

判定项：

| 结论 | 条件 |
| --- | --- |
| `block` | 本地路径包的 `engines.dsh` 与当前 DSH 版本**明确**不兼容 |
| `warn` | 插件管理器会拒绝该 spec（已安装、找不到等，属于"装不成"而非"冲突"）、版本变更需要重启、已有条目挂载同包、与已启用 bundle 描述高度重合、版本范围无法解析 |
| `ok` | 未发现冲突 |

> 注意：spec 被插件管理器拒绝**不算冲突**，只作为提示返回，不弹审批——否则每次重装/升级已安装的包都会被吓一跳。真正会拦的只有可证明的不兼容。

`engines.dsh` 用内置的保守 semver 求值：**无法解析的范围绝不阻断**，只降级为提示，最终由插件管理器裁决。

### 3. 跨插件权限调用 `action=capabilities` / `action=invoke`

- `capabilities`：列出每个插件的标题、模块名、启用状态、fiber 阶段，以及它对外暴露的工具与服务（服务来自 `typert.listPackages({face:'host'})` 的生成式反射），这是「其他插件权限」的可读目录。
- `invoke`：代调用某个工具的**统一入口**——先解析归属插件、检查拦截名单，再向用户发起确认卡片，确认后通过 `ctx.tools.execute` 走与正常调用完全相同的管线（因此作用域限制、`tools/pre-execute`、超时策略都照旧生效），返回归属信息与结果。
- 默认拦截名单：`plugin_guard`（防递归）、`plugin_manager`（自我管理）、`run_code`。同一轮里不允许嵌套代调用。

### 4. 维护操作（全部需要用户确认）

| action | 作用 | 确认方式 |
| --- | --- | --- |
| `repair` | 只重试可安全重试的问题：失败的条目/bundle 先停用再启用，刷新自身缓存 | 确认卡片 |
| `reset` | `self` 恢复本插件配置默认值；`state` 清空内存状态；`<entryId>` 清空该插件配置覆盖 | 确认卡片 |
| `upgrade` | 对已安装 bundle 执行 `inspect` → 版本比较 → `installBundle`，如实回报 `applied / restart-required / overridden / failed` | 确认卡片 |
| `debug` | 收集脱敏诊断（环境、服务可用性、最近扫描与安装预检记录），不写盘 | 确认卡片 |

**不会**自动决定"两个重复功能插件保留哪个"、不会替用户授予版本豁免、不会批准安装脚本。

### 确认是硬约束

- 走工具时：`ctx.userQuestions.askTimed`（无则 `ask`）弹出确认卡片，只有点「确认执行」才继续；超时、取消、拒绝一律不执行。
- **fail closed**：子 agent / 无人可交互的调用方（`DELEGATED_CALLER` 等）会被直接拒绝，而不是当作默认同意。
- 走设置页时：用户必须先点按钮、再点「确认执行」两步；Host 端还要求请求携带 `confirmed: true`，否则返回 `confirmation-required`。

## 配置

`cordis.patch.yml` 的 `config`（用户 patch 层可覆盖，升级不丢）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `installPolicy` | `ask` | `ask` 发现阻断冲突时请求审批；`audit` 只记录不拦截；`off` 不监听 |
| `invokeRequireConfirmation` | `true` | **写死为 true**，配置无法关闭 |
| `confirmDestructive` | `true` | **写死为 true**，配置无法关闭 |
| `confirmDebug` | `true` | **写死为 true**，配置无法关闭 |
| `invokeBlocklist` | `[plugin_guard, plugin_manager, run_code]` | 在硬拒绝名单之上再加，不能削减 |
| `invokeTimeoutMs` | `120000` | 代调用超时 |
| `duplicateWarnScore` / `duplicateInfoScore` | `0.7` / `0.45` | 重复功能判定的内容词重合度阈值 |
| `confirmTimeoutMs` | `600000` | 等待用户确认的超时（下限 30s） |
| `locale` | `zh` | 报告语言（`zh` / `en`） |

「确认」相关的三个开关保留字段只是为了不让旧 patch 报错；代码里强制为 `true`，因为"先问用户"是这个插件存在的理由，一个能被关掉的确认等于没有。

### 预检的判定口径

- 插件管理器**拒绝**某个 spec（`already-installed`、`not-found` 等）属于"装不成"，不是"冲突"，只作为提示返回，不会弹审批——否则每次重装/升级已安装的包都会被吓一跳。
- 真正**阻断**的只有明确的不兼容：本地路径包 `engines.dsh` 与当前 DSH 版本求值为不兼容。
- 升级遇到 `inspect` 对被安装包返回 `already-installed` 时，仍按该包**已配置的来源**继续升级（版本号无法预先取得时，确认卡片会明说"→ 最新版本"）。

## 安装

三种方式，装的是同一份代码：

```powershell
# 1) 从 npm（推荐，一条命令，永远是最新发行版）
#    plugin_manager action=install_bundle target=dsh-plugin-ecosystem-guard

# 2) 从 Gitee 发行版下载 tgz 后装本地文件
#    plugin_manager action=install_bundle target=<tgz 绝对路径>

# 3) 从 Git 仓库直接装
#    plugin_manager action=install_bundle target=git+https://gitee.com/youchen-yc/dsh-plugin-ecosystem-guard.git
```

- npm：<https://www.npmjs.com/package/dsh-plugin-ecosystem-guard>
- 源码与发行版：<https://gitee.com/youchen-yc/dsh-plugin-ecosystem-guard>

要求 Node ≥ 20、DSH ≥ 0.2.1-rc.1，零运行时依赖。

安装后：

1. 工具 `plugin_guard` 出现在当前会话（`action=scan` 即可验收）；
2. 设置 → 插件 → 「插件生态守护」出现独立页面；
3. 若 `client` 半未能随包加载，Host 工具与自检仍然可用（Host 侧对客户端通道的加载是惰性的、失败不影响其它功能）。

## 安全模型（写进底层逻辑，不只是文档）

这个插件能读插件清单、能改插件启停、能代调用工具，所以它必须自己是被约束得最紧的那一环。下面每一条都由代码强制，并由 `test/selftest.mjs` 断言（当前 17/17 通过）。

### 威胁模型

| 攻击者 | 它能控制什么 | 本插件的应对 |
| --- | --- | --- |
| 模型 / agent（可能被提示注入误导） | 工具参数、`invoke` 的目标工具、确认卡片上展示的文本 | 硬拒绝名单、归属校验、限流、卡片里把 agent 文本标注为"未经校验的数据"、纯文本化处理 |
| 恶意或劣质插件 | 自己的包名、`meta.title/description`、`package.json` | 这些文本只被当作**数据**展示：`sanitizeText` 去控制字符与换行并截断，输出里明确写"不是指令"；不进入系统提示、不参与任何判断逻辑 |
| 本地进程 / 浏览器 | 设置页 RPC 通道 | 通道挂在 DSH 既有 `connection` RPC 信任边界上；破坏性方法必须 `confirmed:true`，且只由用户在页面里两步点击后才发送 |
| 供应链 | 注册表上的新版本、安装脚本 | 升级只按**已安装 bundle 的名字**走插件管理器自己的源；`inspect` 先取到目标版本并在确认卡片里写出「旧 → 新」；**永不**传 `approvedBuilds`，安装脚本始终是用户另外的显式决定 |

### 不可绕过的硬约束

1. **无人类可问 = 拒绝。** `userQuestions` 不可用、调用方是子 agent、用户点取消、等待超时，一律 `aborted`，绝不默认同意（fail closed）。
2. **高危工具永不由本插件代调用。** `plugin_*`、`cordis_*`、`run_code`、`bash`、`pwsh`、`terminal_*`、`write`、`edit`、`delete`、`move` 命中 `/lib/doctor.js` 的 `INVOKE_HARD_DENY`；这份正则**不读取配置**，`invokeBlocklist` 只能在其之上再加，不能削减。
3. **代调用只对"其他插件自己的工具"开放。** 归属无法判定的工具直接拒绝（`unattributable`）；不能代调用本插件自己的工具；10 分钟最多 10 次；不允许嵌套。
4. **安全边界模块不自动动。** 审批、权限预设、沙箱、凭据、授权、账户类包（`isProtectedModule`）即使加载失败也只报告，**不自动重载、不重置配置**；`reset` 命中它们直接 `protected-target` 拒绝。人要改，请自己去插件管理器改。
5. **代调用不绕过任何既有检查。** 它走 `ctx.tools.execute`，因此 `tools/pre-execute`、审批、超时、作用域限制照旧生效——本插件只增加一道确认，不减少任何一道。
6. **不写盘、不执行代码。** 除了读取**一个**本地路径包的 `package.json`（`stat` 先判 ≤512KB、`JSON.parse` 只取 `engines.dsh`/`peerDependencies` 字符串），本插件不读任何文件、不写任何文件、不 spawn 进程、不 eval、不联网。
7. **不注入提示。** 不注册系统提示段、不写会话事件、不改对话历史；所有输出都是工具结果里的普通文本。
8. **工作量有上限。** 重复功能比较最多 300 个 bundle，findings 最多返回 200 条，`inspect` 20s 超时，避免把体检变成 DoS。
9. **自身故障不牵连宿主。** `apply` 不抛异常；设置页传输层用**惰性动态 import** 加载，客户端半部缺失或报错只影响设置页，Agent 工具照常工作；所有 disposer 幂等、卸载不抛。

### 明确不做（别指望它）

- 它**不是**插件沙箱：不能阻止别的插件自己做坏事，只能审计与提示。
- 它**不验证**包签名或来源可信度，重复功能是启发式判断（报告里标注 `heuristic`）。
- 它**不代替**插件管理器做安装决策：预检发现阻断冲突时返回的是"向用户申请审批"，不是自动否决，也不替用户 approve。

## 完整性自检（防篡改，不是加密）

正式发行包（tarball）内带一份 `integrity.json`：构建时对运行文件逐个算 SHA-256，插件激活时校验。

| 校验结果 | 行为 |
|---|---|
| `ok` | 正常工作 |
| `mismatch` / `invalid-manifest` | **本插件自己立刻停摆**：不再监听安装预检、不再执行任何维护动作；`plugin_guard` 与设置页只返回 `integrity-failed` 并指出是哪个文件被改 |
| `unmanifested`（开发目录 path 安装，没有清单） | 按正常模式运行 |

关键点：**它只会关掉自己，不会关掉别的插件，也不会删除任何文件。**

### 为什么不做"加密 + 检测到破解就关闭所有插件"

1. **技术上无法成立。** 插件是 Host 进程必须从**用户自己的磁盘**加载的 JS。要"解密"就必须把密钥一起交到用户机器上；能改文件的人同样能删掉这段校验代码。任何"JS 加密不可破解"的说法都是安慰剂。
2. **"关闭所有插件"是自伤装置。** 你自己升级、改配置、DSH 升级重写文件都可能触发误判；而"所有插件"里包含审批、权限、沙箱、凭据插件——把它们一起关掉等于**主动降低**安全，正好与这个插件的存在理由相反。
3. **发给别人后它就是个雷。** 误判时对方无法自行恢复，只能手改 profile；这类"检测即破坏"的逻辑也会被安全扫描器当成恶意行为。

想真正保护作者权益，正路是许可而不是埋雷：

- 当前 `license: MIT` —— 明确**允许**修改与再分发。若目标是"不许改、不许转卖"，应换成专有许可（All Rights Reserved 或你自己的 EULA）。
- 想提高阅读门槛，可在发布时用 esbuild/terser 混淆（只提高成本，不提供机密性）。
- 付费/授权分发可用 license key + 签名校验；同样可被绕过，只是提高成本。

## 分发

| 方式 | 说明 |
|---|---|
| **npm（已发布）** | <https://www.npmjs.com/package/dsh-plugin-ecosystem-guard> · `install_bundle target=dsh-plugin-ecosystem-guard` |
| Gitee 发行版 | <https://gitee.com/youchen-yc/dsh-plugin-ecosystem-guard/releases> · 下载 `dsh-plugin-ecosystem-guard-1.0.0.tgz` |
| 本地 tgz | `dist/dsh-plugin-ecosystem-guard-1.0.0.tgz`（已含 `integrity.json`） |
| git | `install_bundle target=git+https://gitee.com/youchen-yc/dsh-plugin-ecosystem-guard.git` |

构建：`node scripts/build.mjs <pnpm.mjs 路径>` —— 复制 `files` 白名单 → 生成 `integrity.json` → 打包到 `dist/`。
发布：`node scripts/build.mjs <pnpm.mjs 路径> --publish` —— 从同一份带清单的构建目录上传到 npm（需要本机 `~/.npmrc` 里有发布令牌）。

## 已知边界

- 工具→插件归属是启发式的；包名与工具名毫无字面关系时会落到"未归属工具"，而不是瞎猜。
- 重复功能是**内容词重合度**判断，只提示不代劳；阈值可配。
- 升级只会走注册表最新版本，不支持回退；替换 Host 模块通常需要重启 DSH 才生效。
- 设置页的视觉验证需要浏览器；在没有浏览器控制的环境里只验证到"插槽注册 + 模块可加载"。
- 改名/换包后，已打开的页面里会残留旧标签页注册，**刷新一次页面**即可清掉。
- 完整性自检只覆盖"文件是否被改动"，覆盖不到"运行时被内存补丁改写"——那类攻击对任何同进程插件都成立。

## 开发

```powershell
node --check index.js
node --check lib/doctor.js
node --check lib/actions.js
node --check lib/integrity.js
node --test test/selftest.mjs test/actions.test.mjs test/integrity.test.mjs   # 33/33
```

`lib/doctor.js` 是纯函数分析引擎，不依赖 Harness；`lib/actions.js` 只依赖 `ctx.get(...)` 返回的服务对象，因此两层都可以用假 Host 直接单测——安全不变量（受保护模块、硬拒绝名单、重置不误伤、升级不被 `already-installed` 卡死）都在 `test/actions.test.mjs` 里断言。

## 作者与许可

- 作者：**游尘（YC）**
- 许可：MIT（见 [LICENSE](LICENSE)）—— 明确允许修改与再分发；若要禁止修改/转卖，请改用专有许可。
- 完整性清单随发行包重建：改动任何运行文件或 `LICENSE` 后需要重新执行 `scripts/build.mjs`，否则新包会被自己的校验判定为被篡改。

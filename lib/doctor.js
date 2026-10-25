/**
 * dsh-plugin-ecosystem-guard — analysis engine.
 *
 * Everything here is a pure function over data that the Host half already read
 * through documented services (`pluginManager.listPlugins/listBundles`,
 * `tools.schemas()`, `typert.listPackages()`). No filesystem, no network, no
 * mutation: the same inputs always produce the same report, which is what makes
 * the self-check reviewable and the repair step explicit about what it saw.
 *
 * Ownership of a tool is *inferred* from package names; the report always says
 * `attribution: 'heuristic'` so nobody mistakes it for a framework guarantee.
 */

export const VERSION = '1.0.0'

/** Configuration defaults; a user patch layer overrides the row's `config`. */
export const DEFAULTS = {
  installPolicy: 'ask',
  invokeRequireConfirmation: true,
  confirmDestructive: true,
  confirmDebug: true,
  invokeTimeoutMs: 120000,
  duplicateWarnScore: 0.7,
  duplicateInfoScore: 0.45,
  invokeBlocklist: ['plugin_guard', 'plugin_manager', 'run_code'],
}

const GENERIC_TOKENS = new Set([
  'dsh', 'deepseek', 'harness', 'cordis', 'plugin', 'plugins', 'bundle', 'bundles',
  'tool', 'tools', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into',
  'your', 'its', 'are', 'was', 'were', 'adds', 'add', 'provide', 'provides',
  'support', 'supports', 'use', 'uses', 'using', 'via', 'one', 'per', 'all',
  'any', 'not', 'but', 'can', 'will', 'when', 'then', 'than', 'them', 'they',
  'its', 'also', 'such', 'each', 'more', 'most', 'some', 'only', 'just',
  'packages', 'package', 'feature', 'features', 'state', 'data', 'file', 'files',
])

/** Package-name words that carry no ownership signal for tool attribution. */
const MODULE_STOP_TOKENS = new Set([
  'dsh', 'deepseek', 'harness', 'cordis', 'plugin', 'plugins', 'bundle', 'bundles',
  'tool', 'tools', 'client', 'host', 'ui', 'api', 'extension', 'extensions',
  'provider', 'providers', 'local', 'node', 'core', 'base', 'common', 'shared',
])

/**
 * Modules whose *configuration* is part of the security boundary. The guard
 * refuses to reconfigure, reset or reload these even when the user confirms:
 * one wrong toggle here removes a protection for every session in the profile,
 * and no convenience feature is worth that. A human can still do it deliberately
 * in the Plugin Manager, where the change is obviously theirs.
 */
const PROTECTED_MODULE_PATTERNS = [
  /approval/i, /permission/i, /sandbox/i, /credential/i, /authoriz/i,
  /security/i, /secret/i, /(?<![a-z])account(?![a-z])/i, /(?<![a-z])auth(?![a-z])/i,
]

/** Tools the guard will never dispatch on the agent's behalf, whatever config says. */
const INVOKE_HARD_DENY = [
  /^plugin_/, /^cordis_/, /^run_code$/, /^bash/, /^pwsh$/,
  /^terminal_/, /^write$/, /^edit$/, /^delete$/, /^move$/, /^plugin_manager$/,
]

/** Upper bounds so a pathological profile cannot turn a self-check into a hang. */
const MAX_BUNDLES_COMPARED = 300
const MAX_FINDINGS_RETURNED = 200

/** True when touching this module's configuration is a security-boundary change. */
export function isProtectedModule(moduleName) {
  const name = String(moduleName ?? '')
  if (!name) return false
  return PROTECTED_MODULE_PATTERNS.some((pattern) => pattern.test(name))
}

/** True when the guard must never dispatch this tool on an agent's behalf. */
export function isInvokeDenied(toolName) {
  const name = String(toolName ?? '')
  if (!name) return true
  return INVOKE_HARD_DENY.some((pattern) => pattern.test(name))
}

/**
 * Make untrusted text safe to show in a confirmation card or a tool result:
 * control characters removed, newlines collapsed, length bounded. Content is
 * never interpreted — only displayed.
 */
export function sanitizeText(value, limit = 400) {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}

/** Severity ordering used to materialise summary counts. */
export const SEVERITIES = ['fail', 'warn', 'info', 'pass']

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Drop everything a lossless-JSON wire cannot carry. */
export function jsonSafe(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = jsonSafe(item)
    }
    return out
  }
  return null
}

/** Collapse whitespace and cut a string to a readable length. */
export function clip(value, limit = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}

/** `LocalizedText` is a string or `{ en, [locale]: string }`; prefer the user's language. */
export function localized(value, locale = 'zh') {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const order = [locale, 'zh', 'en']
  for (const key of order) {
    const text = value[key]
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  for (const text of Object.values(value)) {
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return ''
}

/** Module name to its distinctive words: `@deepseek-ai/dsh-tool-pwsh` → [tool, pwsh]. */
export function moduleTokens(moduleName) {
  return String(moduleName ?? '')
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/\/.*$/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Content words of a free-text description (ASCII + CJK bigrams), generics dropped. */
export function contentTokens(text) {
  const raw = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const token of raw.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!token) continue
    if (/^[0-9]+$/.test(token)) continue
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      for (let i = 0; i + 1 < token.length; i += 1) out.add(token.slice(i, i + 2))
      continue
    }
    if (token.length < 3) continue
    if (GENERIC_TOKENS.has(token)) continue
    out.add(token)
  }
  return out
}

/** Overlap coefficient: |A∩B| / min(|A|,|B|). Robust for short descriptions. */
export function overlapCoefficient(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const item of a) if (b.has(item)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** Shared distinctive tokens, sorted, for the human-readable evidence line. */
export function sharedTokens(a, b, limit = 8) {
  const shared = []
  for (const item of a) if (b.has(item)) shared.push(item)
  return shared.sort().slice(0, limit)
}

// ---------------------------------------------------------------------------
// Version handling
// ---------------------------------------------------------------------------

export function parseSemver(value) {
  const match = String(value ?? '')
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

export function compareSemver(a, b) {
  const left = typeof a === 'string' ? parseSemver(a) : a
  const right = typeof b === 'string' ? parseSemver(b) : b
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  const lp = left.prerelease
  const rp = right.prerelease
  if (!lp.length && !rp.length) return 0
  if (!lp.length) return 1
  if (!rp.length) return -1
  for (let i = 0; i < Math.max(lp.length, rp.length); i += 1) {
    if (lp[i] === undefined) return -1
    if (rp[i] === undefined) return 1
    const ln = /^\d+$/.test(lp[i])
    const rn = /^\d+$/.test(rp[i])
    if (ln && rn) {
      const diff = Number(lp[i]) - Number(rp[i])
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (ln !== rn) {
      return ln ? -1 : 1
    } else if (lp[i] !== rp[i]) {
      return lp[i] < rp[i] ? -1 : 1
    }
  }
  return 0
}

/**
 * Evaluate one `engines.dsh` range against the running version.
 * Returns `ok`, `no`, or `unknown` (unrecognised syntax must never block).
 */
export function satisfiesDsh(range, version) {
  const target = parseSemver(version)
  if (!target || typeof range !== 'string' || !range.trim()) return 'unknown'
  const groups = range.split('||').map((group) => group.trim()).filter(Boolean)
  if (!groups.length) return 'unknown'
  let sawKnown = false
  for (const group of groups) {
    const comparators = group.split(/\s+/).filter(Boolean)
    let satisfied = true
    let groupKnown = true
    for (const comparator of comparators) {
      const match = comparator.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/)
      if (!match) {
        groupKnown = false
        break
      }
      const operator = match[1] ?? '='
      const bound = parseSemver(match[2])
      if (!bound) {
        groupKnown = false
        break
      }
      let result
      if (operator === '^') {
        result = compareSemver(target, bound) >= 0 && target.major === bound.major
      } else if (operator === '~') {
        result =
          compareSemver(target, bound) >= 0 &&
          target.major === bound.major &&
          target.minor === bound.minor
      } else {
        const order = compareSemver(target, bound)
        result =
          operator === '>=' ? order >= 0
            : operator === '<=' ? order <= 0
              : operator === '>' ? order > 0
                : operator === '<' ? order < 0
                  : order === 0
      }
      if (!result) satisfied = false
    }
    if (groupKnown) {
      sawKnown = true
      if (satisfied) return 'ok'
    }
  }
  return sawKnown ? 'no' : 'unknown'
}

/** The running DSH version, read from the bundle the installation always carries. */
export function runtimeVersionFromBundles(bundles) {
  const list = Array.isArray(bundles) ? bundles : []
  const preferred = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  for (const name of preferred) {
    const bundle = list.find((item) => item && item.name === name && item.version)
    if (bundle) return bundle.version
  }
  const official = list.find(
    (item) => item && item.version && item.official && item.availability === 'installation',
  )
  return official ? official.version : undefined
}

// ---------------------------------------------------------------------------
// Capability attribution
// ---------------------------------------------------------------------------

/**
 * Attribute each visible tool to the live plugin entry whose package name best
 * matches it. Deliberately conservative: an unclear tool stays unowned instead
 * of being attached to the wrong plugin.
 */
export function attributeTools(tools, plugins) {
  const entries = (Array.isArray(plugins) ? plugins : [])
    .filter((entry) => entry && typeof entry.moduleName === 'string')
    .map((entry) => {
      const tokens = moduleTokens(entry.moduleName)
        .filter((token) => token.length >= 3 && !MODULE_STOP_TOKENS.has(token))
      return { entryId: entry.entryId, moduleName: entry.moduleName, tokens }
    })

  // Weight module words by rarity across the installed packages: `session`
  // appears in a dozen modules and says little, `mover` appears in one and says
  // a lot. Without this, a short generic module name wins every tie.
  const frequency = new Map()
  for (const entry of entries) {
    for (const token of entry.tokens) frequency.set(token, (frequency.get(token) || 0) + 1)
  }
  const weightOf = (token) => 1 / (frequency.get(token) || 1)

  const attribution = new Map()
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = String(tool?.name ?? '')
    if (!name) continue
    const toolTokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    const toolJoined = toolTokens.join('')
    let best = null
    let bestWeight = 0
    let bestRatio = 0
    let bestShared = 0
    for (const entry of entries) {
      if (!entry.tokens.length) continue
      let shared = 0
      let weight = 0
      for (const token of entry.tokens) {
        if (toolJoined.includes(token) || toolTokens.includes(token)) {
          shared += 1
          weight += weightOf(token)
        }
      }
      if (!shared) continue
      const ratio = shared / entry.tokens.length
      if (ratio < 0.5) continue
      const moreSpecific = weight > bestWeight + 1e-9
      const clearer = Math.abs(weight - bestWeight) <= 1e-9 && ratio > bestRatio
      const broader = Math.abs(weight - bestWeight) <= 1e-9
        && Math.abs(ratio - bestRatio) <= 1e-9
        && shared > bestShared
      if (moreSpecific || clearer || broader) {
        best = entry
        bestWeight = weight
        bestRatio = ratio
        bestShared = shared
      }
    }
    attribution.set(name, best ? best.entryId : null)
  }
  return attribution
}

/** Tools grouped by owning entry id, with `null` holding the unattributed ones. */
export function groupTools(tools, attribution) {
  const groups = new Map()
  for (const tool of Array.isArray(tools) ? tools : []) {
    const owner = attribution.get(String(tool?.name ?? '')) ?? null
    if (!groups.has(owner)) groups.set(owner, [])
    groups.get(owner).push({ name: tool.name, description: clip(tool.description, 160) })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function finding({ id, severity, code, title, detail, subject, repairable = false, action = null, suggestedAction = '' }) {
  return {
    id,
    severity,
    code,
    title,
    detail: clip(detail, 600),
    subject: subject ?? null,
    repairable,
    action,
    suggestedAction,
  }
}

function bundleErrorFinding(bundle) {
  const error = bundle && bundle.error
  if (!error || typeof error !== 'object') return null
  const code = error.code || 'operation-error'
  const incompatible = Array.isArray(error.incompatible) ? error.incompatible : []
  const detail = [
    `code=${code}`,
    error.diagnostic ? sanitizeText(error.diagnostic, 240) : '',
    incompatible.length
      ? `不兼容：${incompatible.map((item) => `${item.name}@${item.version} 需要 ${Object.values(item.requirements || {}).join(', ')}`).join('；')}`
      : '',
  ].filter(Boolean).join(' · ')
  const guarded = isProtectedModule(bundle.name)
  const repairable = !guarded && code === 'operation-error'
  return finding({
    id: `bundle-error:${bundle.name}`,
    severity: 'fail',
    code: code === 'incompatible-version' ? 'incompatible' : 'bundle-error',
    title: `插件包异常：${bundle.name}`,
    detail,
    subject: bundle.name,
    repairable,
    action: repairable ? { kind: 'retry-bundle', name: bundle.name } : null,
    suggestedAction: guarded
      ? '受保护模块（安全边界）：本插件不会自动重载它，请人工处理'
      : repairable
        ? '重新启用该 bundle 以重试应用补丁'
        : code === 'incompatible-version'
          ? '与当前 DSH 版本不兼容；需要升级插件或由用户显式授予版本豁免'
          : '需要人工处理（请查看插件管理器详情）',
  })
}

/** Candidate bundles are the user-installed ones a user actually chooses between. */
function bundleCandidates(bundles) {
  return (Array.isArray(bundles) ? bundles : []).filter(
    (bundle) =>
      bundle &&
      bundle.name &&
      !bundle.error &&
      bundle.availability !== 'missing' &&
      // DSH's own composition layers (base, web-app, headless, sdk-*) overlap by
      // design; comparing them would only produce noise. The check exists for
      // plugins the user chose to install.
      bundle.availability === 'profile',
  )
}

function bundleText(bundle) {
  return [
    bundle.name,
    localized(bundle.meta && bundle.meta.title, 'en'),
    localized(bundle.meta && bundle.meta.description, 'en'),
    bundle.description,
    ...(Array.isArray(bundle.rows) ? bundle.rows.map((row) => row.moduleName) : []),
  ].filter(Boolean).join(' ')
}

function duplicateFunctionFindings(bundles, config) {
  const warn = Number(config.duplicateWarnScore) || DEFAULTS.duplicateWarnScore
  const info = Number(config.duplicateInfoScore) || DEFAULTS.duplicateInfoScore
  const candidates = bundleCandidates(bundles)
    .slice(0, MAX_BUNDLES_COMPARED)
    .map((bundle) => ({ bundle, tokens: contentTokens(bundleText(bundle)) }))
  const findings = []
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]
      const right = candidates[j]
      if (left.tokens.size < 3 || right.tokens.size < 3) continue
      const score = overlapCoefficient(left.tokens, right.tokens)
      if (score < info) continue
      const evidence = sharedTokens(left.tokens, right.tokens)
      const severity = score >= warn ? 'warn' : 'info'
      findings.push(finding({
        id: `duplicate-function:${left.bundle.name}:${right.bundle.name}`,
        severity,
        code: 'duplicate-function',
        title: `疑似功能重复：${left.bundle.name} ↔ ${right.bundle.name}`,
        detail: `描述与包名的内容词重合度 ${(score * 100).toFixed(0)}%（阈值 ${severity === 'warn' ? warn : info}）`
          + (evidence.length ? ` · 共同关键词：${evidence.join(', ')}` : '')
          + ' · 这是启发式判断，需要人工确认，本插件不会自动禁用任何一个',
        subject: `${left.bundle.name},${right.bundle.name}`,
        repairable: false,
        suggestedAction: '人工确认后保留其中一个，或忽略该提示',
      }))
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/**
 * Build the full health report.
 *
 * @param {object} input
 * @param {object[]} input.plugins   `pluginManager.listPlugins()`
 * @param {object[]} input.bundles   `pluginManager.listBundles()`
 * @param {object[]} input.tools     `tools.schemas()`
 * @param {object} input.services    presence map of the services the guard uses
 * @param {object} input.config      resolved guard config
 * @param {string} [input.generatedAt]
 */
export function buildScan(input = {}) {
  const plugins = Array.isArray(input.plugins) ? input.plugins : []
  const bundles = Array.isArray(input.bundles) ? input.bundles : []
  const tools = Array.isArray(input.tools) ? input.tools : []
  const services = input.services && typeof input.services === 'object' ? input.services : {}
  const config = { ...DEFAULTS, ...(input.config && typeof input.config === 'object' ? input.config : {}) }
  const locale = input.locale === 'en' ? 'en' : 'zh'
  const runtimeVersion = runtimeVersionFromBundles(bundles)
  const attribution = attributeTools(tools, plugins)
  const groups = groupTools(tools, attribution)
  const findings = []

  // 1. Live entry health -----------------------------------------------------
  for (const entry of plugins) {
    if (!entry || !entry.entryId) continue
    const title = localized(entry.meta && entry.meta.title, locale) || entry.moduleName || entry.entryId
    const phase = entry.fiberPhase
    const guarded = isProtectedModule(entry.moduleName)
    if (phase === 'failed') {
      findings.push(finding({
        id: `entry-failed:${entry.entryId}`,
        severity: 'fail',
        code: 'entry-failed',
        title: `插件加载失败：${title}`,
        detail: `${entry.moduleName} · entryId=${entry.entryId} · fiberPhase=failed`,
        subject: entry.entryId,
        repairable: !guarded,
        action: guarded ? null : { kind: 'retry-entry', entryId: entry.entryId, moduleName: entry.moduleName },
        suggestedAction: guarded
          ? '受保护模块（安全边界）：本插件不会自动重载它，请人工处理'
          : '先停用再启用该条目，使 Loader 重新加载一次',
      }))
      continue
    }
    if (entry.enabled && (phase === 'pending' || phase === 'loading')) {
      // No duration is available on `PluginInfo`, so "still loading" cannot be
      // told apart from "stuck". Reporting it would invite a pointless reload of
      // a plugin that is merely starting, so it is not reported at all.
      continue
    }
  }

  // 2. Same module mounted by several entries --------------------------------
  // Deliberately advisory: agent-preset layers, optional variants and shared
  // libraries legitimately mount one package from several entries. Without the
  // Loader scope on `PluginInfo` this cannot be told apart from a true double
  // mount, so it is reported as information, never as a failure.
  const byModule = new Map()
  for (const entry of plugins) {
    if (!entry || !entry.moduleName) continue
    const key = entry.moduleName
    if (!byModule.has(key)) byModule.set(key, [])
    byModule.get(key).push(entry)
  }
  for (const [moduleName, entries] of byModule) {
    if (entries.length < 2) continue
    findings.push(finding({
      id: `duplicate-module:${moduleName}`,
      severity: 'info',
      code: 'duplicate-module',
      title: `同一模块被 ${entries.length} 个条目挂载：${moduleName}`,
      detail: `条目：${entries.map((entry) => entry.entryId).join(', ')}`
        + ' · 预设层、可选变体与共享库通常就是这样，只有在同一作用域同时生效时才需要处理',
      subject: moduleName,
      repairable: false,
      suggestedAction: '确认这些条目是否在同一作用域同时生效；本插件不会替你停用任何一个',
    }))
  }

  // 3. Bundle health ---------------------------------------------------------
  for (const bundle of bundles) {
    const problem = bundleErrorFinding(bundle)
    if (problem) findings.push(problem)
  }

  // 4. Possible duplicate function ------------------------------------------
  findings.push(...duplicateFunctionFindings(bundles, config))

  // 5. Self health -----------------------------------------------------------
  const requiredServices = ['pluginManager', 'tools']
  const missingRequired = requiredServices.filter((name) => !services[name])
  if (missingRequired.length) {
    findings.push(finding({
      id: 'self-degraded:services',
      severity: 'fail',
      code: 'self-degraded',
      title: '插件守护自身降级：缺少必需服务',
      detail: `缺少 ${missingRequired.join(', ')}；对插件生态的检查与修复不可用`,
      subject: 'self',
      repairable: false,
      suggestedAction: '确认 DSH 版本的 plugin-manager / tools 服务已装载',
    }))
  }
  if (!services.userQuestions) {
    findings.push(finding({
      id: 'self-degraded:confirmation',
      severity: 'warn',
      code: 'self-degraded',
      title: '无法向用户确认：userQuestions 服务不可用',
      detail: '修复/重置/升级/调试与跨插件调用都会被拒绝（fail closed），这是预期行为',
      subject: 'self',
      repairable: false,
      suggestedAction: '在 Web UI 中运行，或启用 user-questions 插件',
    }))
  }
  if (!services.connection) {
    findings.push(finding({
      id: 'self-degraded:ui-channel',
      severity: 'info',
      code: 'self-degraded',
      title: '设置页通道不可用：connection 服务缺失',
      detail: '插件守护的 Web 设置页将无法读取数据；Agent 工具不受影响',
      subject: 'self',
      repairable: false,
      suggestedAction: '在带 Web 运行时的 profile 中使用设置页',
    }))
  }
  const policy = String(config.installPolicy || '').toLowerCase()
  if (!['ask', 'audit', 'off'].includes(policy)) {
    findings.push(finding({
      id: 'config-invalid:installPolicy',
      severity: 'warn',
      code: 'config-invalid',
      title: `配置无效：installPolicy=${config.installPolicy}`,
      detail: '可选值为 ask | audit | off，当前回退为 ask',
      subject: 'self',
      repairable: true,
      action: { kind: 'self-refresh', reason: 'config-invalid' },
      suggestedAction: '重置自身配置以恢复默认值',
    }))
  }

  // 6. Nothing wrong → say so explicitly ------------------------------------
  const attention = findings.filter((item) => item.severity === 'fail' || item.severity === 'warn')
  if (!attention.length) {
    findings.unshift(finding({
      id: 'ok:summary',
      severity: 'pass',
      code: 'ok',
      title: '插件生态体检通过',
      detail: `${plugins.length} 个插件条目、${bundles.length} 个插件包、${tools.length} 个工具均未发现问题`,
      subject: 'self',
    }))
  }

  const summary = { pass: 0, warn: 0, fail: 0, info: 0 }
  for (const item of findings) {
    if (item.severity === 'fail') summary.fail += 1
    else if (item.severity === 'warn') summary.warn += 1
    else if (item.severity === 'info') summary.info += 1
    else summary.pass += 1
  }

  // Stable, severity-ordered output with a hard cap: a report is meant to be
  // read, not to become a denial-of-service on the caller's context.
  const rank = new Map(SEVERITIES.map((severity, index) => [severity, index]))
  findings.sort((left, right) => (rank.get(left.severity) ?? 9) - (rank.get(right.severity) ?? 9))
  const findingsTotal = findings.length
  if (findings.length > MAX_FINDINGS_RETURNED) findings.length = MAX_FINDINGS_RETURNED

  const pluginRows = plugins.map((entry) => ({
    entryId: entry.entryId,
    moduleName: entry.moduleName,
    title: localized(entry.meta && entry.meta.title, locale) || entry.moduleName,
    enabled: Boolean(entry.enabled),
    fiberPhase: entry.fiberPhase ?? null,
    tools: (groups.get(entry.entryId) || []).map((tool) => tool.name),
  }))

  return {
    ok: true,
    generatedAt: input.generatedAt || new Date().toISOString(),
    version: VERSION,
    runtimeVersion: runtimeVersion ?? null,
    attribution: 'heuristic',
    summary,
    counts: { plugins: plugins.length, bundles: bundles.length, tools: tools.length },
    findings,
    findingsTotal,
    plugins: pluginRows,
  }
}

// ---------------------------------------------------------------------------
// Capability catalog ("other plugins' permissions")
// ---------------------------------------------------------------------------

export function buildCapabilities(input = {}) {
  const plugins = Array.isArray(input.plugins) ? input.plugins : []
  const tools = Array.isArray(input.tools) ? input.tools : []
  const packages = Array.isArray(input.packages) ? input.packages : []
  const locale = input.locale === 'en' ? 'en' : 'zh'
  const attribution = attributeTools(tools, plugins)
  const groups = groupTools(tools, attribution)
  const servicesByModule = new Map()
  for (const record of packages) {
    if (!record || record.face !== 'host' || !record.package) continue
    const model = record.model && typeof record.model === 'object' ? record.model : {}
    const services = Array.isArray(model.services) ? model.services.map((service) => service && service.key).filter(Boolean) : []
    servicesByModule.set(record.package, services)
  }
  const rows = plugins.map((entry) => ({
    entryId: entry.entryId,
    moduleName: entry.moduleName,
    title: localized(entry.meta && entry.meta.title, locale) || entry.moduleName,
    description: localized(entry.meta && entry.meta.description, locale),
    enabled: Boolean(entry.enabled),
    fiberPhase: entry.fiberPhase ?? null,
    tools: groups.get(entry.entryId) || [],
    services: servicesByModule.get(entry.moduleName) || [],
    attribution: 'heuristic',
  }))
  const unownedTools = (groups.get(null) || []).slice()
  return { ok: true, plugins: rows, unownedTools, attribution: 'heuristic' }
}

// ---------------------------------------------------------------------------
// Pre-install conflict analysis
// ---------------------------------------------------------------------------

/**
 * Judge one installation spec against what is already live.
 *
 * @param {object} input
 * @param {string} input.spec
 * @param {object} input.inspection  `pluginManager.inspect(spec)` result
 * @param {object[]} input.plugins
 * @param {object[]} input.bundles
 * @param {object[]} input.tools
 * @param {string} [input.runtimeVersion]
 * @param {string} [input.localManifest] raw package.json text of a local path spec
 * @param {object} input.config
 * @returns {{verdict:'ok'|'warn'|'block', inspection:object, conflicts:object[], warnings:object[], spec:string}}
 */
export function analyzeInstall(input = {}) {
  const spec = String(input.spec ?? '').trim()
  const inspection = input.inspection && typeof input.inspection === 'object' ? input.inspection : null
  const bundles = Array.isArray(input.bundles) ? input.bundles : []
  const plugins = Array.isArray(input.plugins) ? input.plugins : []
  const config = { ...DEFAULTS, ...(input.config && typeof input.config === 'object' ? input.config : {}) }
  const runtimeVersion = input.runtimeVersion || runtimeVersionFromBundles(bundles)
  const conflicts = []
  const warnings = []

  const push = (target, item) => {
    const entry = {
      code: item.code,
      severity: item.severity || 'warn',
      title: item.title,
      detail: clip(item.detail, 400),
      blocking: Boolean(item.blocking),
    }
    if (item.blocking) conflicts.push(entry)
    else warnings.push(entry)
  }

  if (!spec) {
    push(conflicts, { code: 'invalid-spec', blocking: true, title: '缺少安装目标', detail: 'install_bundle 需要 spec/target' })
    return { verdict: 'block', spec, inspection, conflicts, warnings, runtimeVersion: runtimeVersion ?? null }
  }

  if (!inspection) {
    push(warnings, { code: 'inspection-unavailable', title: '未能读取安装目标', detail: 'pluginManager.inspect 未返回结果，冲突检查降级为“仅提示”' })
    return { verdict: 'warn', spec, inspection, conflicts, warnings, runtimeVersion: runtimeVersion ?? null }
  }

  if (inspection.status === 'refused') {
    // A refusal is not a conflict: the plugin manager will simply decline the
    // installation. Blocking here would turn every re-install of an installed
    // package into a scary approval prompt, so it stays advisory.
    push(warnings, {
      code: 'spec-refused',
      title: '插件管理器不会接受这个安装目标',
      detail: `${inspection.problem}: ${inspection.reason}`,
    })
    return { verdict: 'warn', spec, inspection, conflicts, warnings, runtimeVersion: runtimeVersion ?? null }
  }

  const name = inspection.name
  const version = inspection.version

  // Same package already present ---------------------------------------------
  if (name) {
    const existing = bundles.find((bundle) => bundle && bundle.name === name)
    if (existing) {
      if (existing.version && version && existing.version !== version) {
        push(warnings, {
          code: 'version-change',
          title: `将替换已安装的 ${name}`,
          detail: `已安装 ${existing.version} → 目标 ${version}；替换 JS 模块通常需要重启 DSH 才能生效`,
        })
      } else {
        push(warnings, {
          code: 'already-installed',
          title: `${name} 已安装`,
          detail: existing.enabled ? '当前已启用；重复安装只会重写依赖' : '当前已安装但未启用',
        })
      }
    }
    const sameModule = plugins.find((entry) => entry && entry.moduleName === name)
    if (sameModule && !existing) {
      push(warnings, {
        code: 'row-collision',
        title: `已有条目挂载 ${name}`,
        detail: `entryId=${sameModule.entryId} 已经挂载同一包，新 bundle 可能造成重复副作用`,
      })
    }
  }

  // Local path specs: read engines.dsh before installing ---------------------
  if (inspection.kind === 'path' && input.localManifest) {
    let manifest = null
    try {
      manifest = JSON.parse(String(input.localManifest))
    } catch {
      manifest = null
    }
    if (manifest && typeof manifest === 'object') {
      const declared = (manifest.engines && manifest.engines.dsh) || peerDshRange(manifest)
      if (declared && runtimeVersion) {
        const state = satisfiesDsh(declared, runtimeVersion)
        if (state === 'no') {
          push(conflicts, {
            code: 'incompatible-system',
            blocking: true,
            title: '与当前 DSH 版本不兼容',
            detail: `插件声明 engines.dsh=${declared}，当前 DSH ${runtimeVersion}`,
          })
        } else if (state === 'unknown') {
          push(warnings, {
            code: 'engine-unknown',
            title: '无法判定版本兼容性',
            detail: `engines.dsh=${declared} 不在本插件可解析的范围内；安装时由插件管理器最终裁决`,
          })
        }
      }
    }
  }

  // Same-family / duplicate function ----------------------------------------
  if (name) {
    const candidateTokens = contentTokens(
      [name, inspection.description || ''].filter(Boolean).join(' '),
    )
    const warnScore = Number(config.duplicateWarnScore) || DEFAULTS.duplicateWarnScore
    const infoScore = Number(config.duplicateInfoScore) || DEFAULTS.duplicateInfoScore
    for (const bundle of bundleCandidates(bundles)) {
      if (!bundle.name || bundle.name === name) continue
      if (!bundle.enabled) continue
      const tokens = contentTokens(bundleText(bundle))
      if (tokens.size < 3 || candidateTokens.size < 3) continue
      const score = overlapCoefficient(tokens, candidateTokens)
      if (score < infoScore) continue
      const evidence = sharedTokens(tokens, candidateTokens)
      push(warnings, {
        code: 'duplicate-function',
        severity: 'warn',
        title: `可能与已启用的 ${bundle.name} 功能重复`,
        detail: `内容词重合度 ${(score * 100).toFixed(0)}%`
          + (evidence.length ? ` · 共同关键词：${evidence.join(', ')}` : '')
          + ' · 启发式判断，仅供参考',
      })
    }
  }

  const verdict = conflicts.length ? 'block' : warnings.length ? 'warn' : 'ok'
  return { verdict, spec, inspection, conflicts, warnings, runtimeVersion: runtimeVersion ?? null }
}

/** `peerDependencies['@deepseek-ai/dsh-*']` used as a compatibility hint. */
function peerDshRange(manifest) {
  const peers = manifest && manifest.peerDependencies
  if (!peers || typeof peers !== 'object') return ''
  const ranged = peers['@deepseek-ai/dsh']
  if (typeof ranged === 'string' && ranged.trim()) return ranged
  return ''
}

/** Render a structured `{ code, message }` failure for a user-facing summary. */
export function localizeError(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  const code = error.code || 'error'
  const message = error.message || JSON.stringify(error)
  return `${code}：${message}`
}

/** One-line summary used in the pre-execute prompt and the tool result. */
export function summarizeAnalysis(analysis) {  const total = analysis.conflicts.length + analysis.warnings.length
  if (!total) return `插件守护：${analysis.spec} 未发现冲突、不兼容或重复功能`
  const lines = [`插件守护预检（${analysis.spec}）：${analysis.conflicts.length} 个冲突 / ${analysis.warnings.length} 个提示`]
  for (const item of analysis.conflicts) lines.push(`- [冲突] ${item.title}：${item.detail}`)
  for (const item of analysis.warnings.slice(0, 8)) lines.push(`- [提示] ${item.title}：${item.detail}`)
  if (analysis.warnings.length > 8) lines.push(`- …另有 ${analysis.warnings.length - 8} 条提示`)
  return lines.join('\n')
}

/**
 * dsh-plugin-ecosystem-guard — operations that change state.
 *
 * Every function here is called only after an explicit user confirmation, and
 * each one reports exactly what it attempted, in the order it attempted it.
 * Nothing is inferred to have succeeded: a `ChangeResult.application` of
 * `restart-required` or `overridden` is passed through verbatim.
 */

import {
  compareSemver,
  isInvokeDenied,
  isProtectedModule,
  jsonSafe,
  clip,
  sanitizeText,
  VERSION,
} from './doctor.js'

const SERVICES_PROBED = [
  'pluginManager', 'pluginMarket', 'tools', 'userQuestions', 'approval',
  'connection', 'configEditor', 'typert', 'commands', 'webServer', 'agents',
  'skills', 'subagents', 'storageDomain', 'fs', 'workingDirectory',
]

function reasonOf(error) {
  return String(error && error.message ? error.message : error)
}

function changeDetail(result) {
  if (!result || typeof result !== 'object') return ''
  const parts = [`application=${result.application ?? 'unknown'}`]
  if (result.restartReason) parts.push(`restartReason=${result.restartReason}`)
  if (result.error && result.error.code) {
    parts.push(`error=${result.error.code}${result.error.diagnostic ? `(${clip(result.error.diagnostic, 160)})` : ''}`)
  }
  if (Array.isArray(result.warnings) && result.warnings.length) {
    parts.push(`warnings=${result.warnings.length}`)
  }
  return parts.join(' · ')
}

/**
 * @param {object} options
 * @param {object} options.ctx       Host plugin context
 * @param {object} options.config    resolved guard config
 * @param {Function} options.scan   () => Promise<scan report>
 * @param {object} options.runtime  mutable bookkeeping owned by index.js
 */
export function createActions({ ctx, config, scan, runtime }) {
  const get = (name) => {
    try {
      const value = ctx.get(name)
      return value && typeof value === 'object' ? value : undefined
    } catch {
      return undefined
    }
  }

  function pluginManager() {
    return get('pluginManager')
  }

  function record(kind, payload) {
    if (!runtime || !Array.isArray(runtime.history)) return
    runtime.history.push({ at: new Date().toISOString(), kind, ...jsonSafe(payload || {}) })
    if (runtime.history.length > 60) runtime.history.splice(0, runtime.history.length - 60)
  }

  /** The guard's own package name; used for `reset target=self` and self-protection. */
  const GUARD_MODULE = 'dsh-plugin-ecosystem-guard'

  /** Sliding-window rate limit for agent-driven cross-plugin dispatches. */
  const INVOKE_WINDOW_MS = 10 * 60 * 1000
  const INVOKE_MAX_PER_WINDOW = 10

  function takeInvokeSlot() {
    const now = Date.now()
    if (!Array.isArray(runtime.invokeTimes)) runtime.invokeTimes = []
    runtime.invokeTimes = runtime.invokeTimes.filter((at) => now - at < INVOKE_WINDOW_MS)
    if (runtime.invokeTimes.length >= INVOKE_MAX_PER_WINDOW) return false
    runtime.invokeTimes.push(now)
    return true
  }

  // -------------------------------------------------------------------------
  // repair
  // -------------------------------------------------------------------------

  async function repair({ targets } = {}) {
    const pm = pluginManager()
    if (!pm) {
      return { ok: false, error: { code: 'service-missing', message: 'pluginManager 不可用，无法修复' } }
    }
    let report
    try {
      report = await scan()
    } catch (error) {
      return { ok: false, error: { code: 'scan-failed', message: reasonOf(error) } }
    }

    const wanted = Array.isArray(targets) && targets.length
      ? new Set(targets.map((item) => String(item)))
      : null
    const candidates = report.findings.filter((item) => item.repairable && item.action)
    const selected = wanted ? candidates.filter((item) => wanted.has(item.id)) : candidates
    const skipped = []

    const attempts = []
    const seenSkips = new Set()
    const skip = (findingId, reason) => {
      const key = `${findingId}\u0000${reason}`
      if (seenSkips.has(key)) return
      seenSkips.add(key)
      skipped.push({ findingId, reason })
    }
    for (const item of report.findings) {
      if (!item.repairable && (item.severity === 'fail' || item.severity === 'warn')) {
        if (wanted && !wanted.has(item.id)) continue
        skip(item.id, item.suggestedAction || '需要人工处理')
      }
    }
    for (const id of wanted ? [...wanted] : []) {
      if (!candidates.some((item) => item.id === id)) skip(id, '该问题不存在，或本插件无法自动修复')
    }

    /** Turn one plugin row on and verify it; restore nothing that was already broken. */
    async function retryActivation(kind, target, findingId) {
      const toggle = kind === 'retry-entry'
        ? (on) => pm.setPluginEnabled(target.id, on)
        : (on) => pm.setBundleEnabled(target.name, on)
      let off
      try {
        off = await toggle(false)
      } catch (error) {
        return { findingId, action: kind, result: 'failed', detail: `停用失败，未做任何改动：${reasonOf(error)}` }
      }
      let on
      try {
        on = await toggle(true)
      } catch (error) {
        // Disabling succeeded but re-enabling threw: try once more, then say
        // loudly that the row may be left disabled.
        try {
          on = await toggle(true)
        } catch (second) {
          return {
            findingId,
            action: kind,
            result: 'failed',
            detail: `重新启用失败，该条目可能仍处于停用状态，请立即在插件管理器手动启用：${reasonOf(second)}`,
          }
        }
      }
      const application = on && typeof on.application === 'string' ? on.application : 'applied'
      const result = ['applied', 'restart-required', 'overridden', 'failed'].includes(application)
        ? application
        : application === 'cancelled' ? 'failed' : 'applied'
      return {
        findingId,
        action: kind,
        result,
        detail: `停用 ${changeDetail(off)} → 启用 ${changeDetail(on)}`
          + (result === 'failed' ? ' · 该条目未必已恢复，请检查插件管理器' : ''),
      }
    }

    for (const item of selected) {
      const action = item.action
      const targetModule = action.kind === 'retry-entry'
        ? action.moduleName
        : action.kind === 'retry-bundle'
          ? action.name
          : ''
      // Defence in depth: never reload a security-boundary module, even if a
      // future report change forgot to mark it unrepairable.
      if (targetModule && targetModule !== GUARD_MODULE && isProtectedModule(targetModule)) {
        attempts.push({
          findingId: item.id,
          action: String(action.kind),
          result: 'skipped',
          detail: '受保护模块（安全边界）：拒绝自动重载，请人工处理',
        })
        continue
      }
      try {
        if (action.kind === 'retry-entry') {
          attempts.push(await retryActivation('retry-entry', { id: action.entryId }, item.id))
        } else if (action.kind === 'retry-bundle') {
          attempts.push(await retryActivation('retry-bundle', { name: action.name }, item.id))
        } else if (action.kind === 'self-refresh') {
          runtime.cache = null
          if (Array.isArray(runtime.history)) runtime.history.length = 0
          attempts.push({ findingId: item.id, action: 'self-refresh', result: 'applied', detail: '已清空自身缓存与决策记录' })
        } else {
          attempts.push({ findingId: item.id, action: String(action.kind), result: 'skipped', detail: '未知的修复动作' })
        }
      } catch (error) {
        attempts.push({ findingId: item.id, action: String(action.kind), result: 'failed', detail: reasonOf(error) })
      }
    }

    let fresh = null
    try {
      // A fresh read: the inventory cache is short-lived, and a cached report
      // here would show the pre-repair state and invite a pointless second repair.
      fresh = await scan({ fresh: true })
    } catch {
      fresh = null
    }
    const after = fresh ? fresh.summary : null
    if (fresh) {
      const liveIds = new Set(fresh.findings.map((entry) => entry.id))
      for (const attempt of attempts) {
        if (attempt.result === 'skipped' || attempt.result === 'failed') continue
        // Re-check instead of claiming success: the finding must be gone.
        attempt.verified = !liveIds.has(attempt.findingId)
      }
    }
    record('repair', { attempts, skipped: skipped.length })
    return { ok: true, attempts, skipped, after }
  }

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  function findEntryByIdentity(entries, target) {
    if (!Array.isArray(entries) || !target) return undefined
    return entries.find((entry) => entry && (entry.id === target || entry.name === target))
  }

  async function reset({ target } = {}) {
    const wanted = String(target ?? '').trim() || 'self'
    if (wanted === 'state') {
      runtime.cache = null
      if (Array.isArray(runtime.history)) runtime.history.length = 0
      if (Array.isArray(runtime.interceptions)) runtime.interceptions.length = 0
      record('reset', { target: 'state' })
      return { ok: true, target: 'state', changed: true, detail: '已清空插件守护的缓存、决策记录与安装预检记录' }
    }

    const editor = get('configEditor')
    if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
      return {
        ok: false,
        error: {
          code: 'service-missing',
          message: 'configEditor 不可用：无法把配置行重置为默认值。可用目标：state（清空内存状态）',
        },
      }
    }
    let entries = []
    try {
      entries = editor.entries() || []
    } catch (error) {
      return { ok: false, error: { code: 'entries-failed', message: reasonOf(error) } }
    }
    const entry = wanted === 'self' ? findEntryByIdentity(entries, GUARD_MODULE) : findEntryByIdentity(entries, wanted)
    if (!entry) {
      return {
        ok: false,
        error: {
          code: 'target-not-found',
          message: wanted === 'self'
            ? '未在 profile 配置中找到 dsh-plugin-ecosystem-guard 所在行'
            : `未找到可寻址的配置行：${wanted}（可用目标：self / state / 具体 entryId）`,
        },
      }
    }
    // A reset is a configuration change on somebody else's plugin. One step
    // inside the security boundary (approval, permission, sandbox, credentials,
    // account) is not something this plugin will do on an agent's request.
    if (entry.name && entry.name !== GUARD_MODULE && isProtectedModule(entry.name)) {
      return {
        ok: false,
        target: wanted,
        error: {
          code: 'protected-target',
          message: `拒绝重置 ${entry.name}：它属于安全边界（审批/权限/沙箱/凭据/账户），本插件不代为修改这类配置`,
        },
      }
    }
    try {
      await editor.edit(entry, () => ({}))
    } catch (error) {
      return { ok: false, target: wanted, changed: false, error: { code: 'reset-failed', message: reasonOf(error) } }
    }
    runtime.cache = null
    record('reset', { target: wanted, entryId: entry.id })
    return {
      ok: true,
      target: wanted,
      changed: true,
      entryId: entry.id ?? null,
      detail: `已把 ${entry.name || entry.id} 的配置覆盖清空，回落到补丁层默认值`,
    }
  }

  // -------------------------------------------------------------------------
  // upgrade
  // -------------------------------------------------------------------------

  async function inspectUpgrade({ target } = {}) {
    const pm = pluginManager()
    if (!pm) {
      return { ok: false, error: { code: 'service-missing', message: 'pluginManager 不可用，无法升级' } }
    }
    const wanted = String(target ?? '').trim()
    if (!wanted) {
      return { ok: false, error: { code: 'missing-target', message: '需要 target：bundle 包名或已安装的包名' } }
    }
    let bundles = []
    try {
      bundles = (await pm.listBundles()) || []
    } catch (error) {
      return { ok: false, error: { code: 'list-failed', message: reasonOf(error) } }
    }
    const bundle = bundles.find(
      (item) => item && (item.name === wanted || (item.installTarget && item.installTarget.spec === wanted)),
    )
    if (!bundle) {
      const names = bundles.filter((item) => item && item.name).slice(0, 20).map((item) => item.name)
      return {
        ok: false,
        error: {
          code: 'target-not-found',
          message: `未找到已安装的 bundle：${wanted}`,
          details: { knownBundles: names },
        },
      }
    }
    if (bundle.readOnlyReason) {
      return {
        ok: false,
        target: bundle.name,
        error: {
          code: 'read-only',
          message: `${bundle.name} 由 DSH 安装自身提供（readOnlyReason=${bundle.readOnlyReason}），不能通过插件升级`,
        },
      }
    }
    const spec = (bundle.installTarget && bundle.installTarget.spec) || bundle.name
    const currentVersion = bundle.version || (bundle.installTarget && bundle.installTarget.version) || null
    let inspection
    try {
      inspection = await pm.inspect(spec)
    } catch (error) {
      return { ok: false, target: bundle.name, error: { code: 'inspect-failed', message: reasonOf(error) } }
    }
    if (!inspection || inspection.status === 'refused') {
      // `pluginManager.inspect()` refuses *every* installed package with
      // `already-installed`; that is a benign state, not a reason to give up on
      // an upgrade. The manager can still install the latest version from the
      // source this bundle is already configured with, so continue without a
      // comparable target version and report what happened from the result.
      if (inspection && inspection.status === 'refused' && inspection.problem === 'already-installed') {
        return {
          ok: true,
          target: bundle.name,
          spec,
          currentVersion,
          availableVersion: null,
          note: '该包已安装，插件管理器不提供可预先比较的目标版本；升级将按该包已配置的来源安装最新版本',
        }
      }
      return {
        ok: false,
        target: bundle.name,
        currentVersion,
        error: {
          code: 'inspect-refused',
          message: inspection && inspection.status === 'refused'
            ? `${inspection.problem}: ${inspection.reason}`
            : '插件管理器未能读取该包的注册表信息',
        },
      }
    }
    return {
      ok: true,
      target: bundle.name,
      spec,
      currentVersion,
      availableVersion: inspection.version || null,
    }
  }

  async function upgrade({ target } = {}) {
    const resolved = await inspectUpgrade({ target })
    if (!resolved.ok) return resolved
    const { spec, currentVersion, availableVersion } = resolved
    const order = currentVersion && availableVersion ? compareSemver(availableVersion, currentVersion) : null
    if (order !== null && order <= 0) {
      record('upgrade', { target: resolved.target, currentVersion, availableVersion, changed: false })
      return {
        ok: true,
        target: resolved.target,
        currentVersion,
        availableVersion,
        changed: false,
        application: null,
        detail: availableVersion === currentVersion
          ? '已是最新版本'
          : `注册表版本 ${availableVersion} 不高于已安装的 ${currentVersion}`,
      }
    }
    const pm = pluginManager()
    let result
    try {
      // Never pass approvedBuilds: install scripts stay a separate, explicit
      // user decision instead of riding along with an upgrade.
      result = await pm.installBundle(spec)
    } catch (error) {
      return { ok: false, target: resolved.target, error: { code: 'install-failed', message: reasonOf(error) } }
    }
    record('upgrade', {
      target: resolved.target,
      from: currentVersion,
      to: availableVersion,
      application: result && result.application,
    })
    return {
      ok: Boolean(result && result.changed),
      target: resolved.target,
      currentVersion,
      availableVersion,
      changed: Boolean(result && result.changed),
      application: result && result.application ? result.application : null,
      restartReason: result && result.restartReason ? result.restartReason : null,
      version: result && result.version ? result.version : null,
      pendingBuilds: result && Array.isArray(result.pendingBuilds) ? result.pendingBuilds : [],
      detail: result ? `${changeDetail(result)}${result.changed ? '' : ' · 没有实际变更'}` : '插件管理器未返回结果',
    }
  }

  // -------------------------------------------------------------------------
  // debug
  // -------------------------------------------------------------------------

  async function debug() {
    let report = null
    let scanError = null
    try {
      report = await scan()
    } catch (error) {
      scanError = reasonOf(error)
    }
    const services = {}
    for (const name of SERVICES_PROBED) services[name] = Boolean(get(name))
    let packageCount = null
    const typert = get('typert')
    if (typert && typeof typert.listPackages === 'function') {
      try {
        packageCount = typert.listPackages({ face: 'host' }).length
      } catch {
        packageCount = null
      }
    }
    const sortedHistory = Array.isArray(runtime.history) ? runtime.history.slice(-30) : []
    const interceptions = Array.isArray(runtime.interceptions) ? runtime.interceptions.slice(-20) : []
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      report: jsonSafe({
        plugin: { name: GUARD_MODULE, version: VERSION },
        env: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          dshProfile: process.env.DSH_PROFILE || null,
          dshProfileDir: process.env.DSH_PROFILE_DIR || null,
          pid: process.pid,
        },
        config,
        services,
        typertPackages: packageCount,
        scan: report
          ? { generatedAt: report.generatedAt, runtimeVersion: report.runtimeVersion, summary: report.summary, counts: report.counts }
          : null,
        scanError,
        findings: report ? report.findings.map((item) => ({ id: item.id, severity: item.severity, code: item.code, detail: item.detail })) : [],
        history: sortedHistory,
        interceptions,
      }),
    }
  }

  // -------------------------------------------------------------------------
  // governed cross-plugin invocation
  // -------------------------------------------------------------------------

  async function resolveToolOwner(toolName) {
    let report
    try {
      report = await scan()
    } catch {
      return { owner: null, error: null }
    }
    const row = (report.plugins || []).find((entry) => (entry.tools || []).includes(toolName))
    return { owner: row || null, report }
  }

  async function invoke({ tool, args, signal, agent } = {}) {
    const name = String(tool ?? '').trim()
    if (!name) return { ok: false, error: { code: 'missing-target', message: '需要 tool：要调用的工具名' } }
    const tools = get('tools')
    if (!tools || typeof tools.execute !== 'function') {
      return { ok: false, error: { code: 'service-missing', message: 'tools 服务不可用' } }
    }
    const blocklist = Array.isArray(config.invokeBlocklist) ? config.invokeBlocklist : []
    if (blocklist.includes(name) || name === 'plugin_guard') {
      return {
        ok: false,
        error: {
          code: 'blocked-target',
          message: `拒绝代调用 ${name}：它在本插件的拦截名单中（避免递归与自我管理）`,
        },
      }
    }
    // Non-negotiable: shell, file mutation, plugin management and dynamic
    // packages keep their own approval path. Brokering them here would create a
    // second door into the same capability.
    if (isInvokeDenied(name)) {
      return {
        ok: false,
        error: {
          code: 'hard-denied',
          message: `拒绝代调用 ${name}：高影响工具必须由 agent 直接调用，各自走自己的审批与权限检查`,
        },
      }
    }
    if (!tools.get(name)) {
      return { ok: false, error: { code: 'unknown-tool', message: `当前会话看不到工具 ${name}` } }
    }
    const { owner } = await resolveToolOwner(name)
    if (!owner) {
      return {
        ok: false,
        error: {
          code: 'unattributable',
          message: '无法判定该工具属于哪个插件；代调用只对“其他插件自己的工具”开放',
        },
      }
    }
    if (owner.moduleName === GUARD_MODULE) {
      return { ok: false, error: { code: 'blocked-target', message: '不能代调用插件守护自己的工具' } }
    }
    if (!takeInvokeSlot()) {
      return {
        ok: false,
        error: { code: 'rate-limited', message: '代调用过于频繁（10 分钟内最多 10 次），已暂停，请稍后再试' },
      }
    }
    let callId = `ecosystem-guard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    let result
    try {
      result = await tools.execute({
        callId,
        name,
        arguments: args && typeof args === 'object' ? args : {},
        agent,
        signal,
      })
    } catch (error) {
      return { ok: false, error: { code: 'dispatch-failed', message: reasonOf(error) } }
    }
    record('invoke', { tool: name, owner: owner ? owner.moduleName : null, isError: Boolean(result && result.isError) })
    const payload = result && typeof result === 'object' ? result : { value: null }
    return {
      ok: !(payload.isError === true),
      tool: name,
      owner: owner
        ? { entryId: owner.entryId, moduleName: owner.moduleName, title: owner.title, attribution: 'heuristic' }
        : null,
      isError: Boolean(payload.isError),
      error: payload.error ? jsonSafe(payload.error) : null,
      value: payload.value === undefined ? null : jsonSafe(payload.value),
      content: Array.isArray(payload.content) ? jsonSafe(payload.content) : [],
    }
  }

  return { repair, reset, upgrade, previewUpgrade: inspectUpgrade, debug, invoke, record }
}

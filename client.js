/**
 * dsh-plugin-ecosystem-guard — Client half.
 *
 * Registers one page into Settings → Plugins (`settings.plugins.tab`) and talks
 * to the Host half over the package's private Connection RPC channel
 * `/ecosystem-guard` (see lib/client-rpc.js for the Host side and the evidence that
 * this is the supported seam for a persistent bundle on this build).
 *
 * Registration contract (mirrors the shipped @deepseek-ai/dsh-client-ui-settings-plugin-inventory
 * client, which occupies the same slot):
 *
 *   ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
 *     name: 'settings.plugins.tab', id, order, label: () => t(...), locale, inject
 *   }, Page))
 *
 * The entry receives `t` (bound to the `locale` namespace), every field returned
 * by `inject`, and nothing else. The component tolerates missing props/fields:
 * every value is read defensively and rendered as "—" when absent, and a failed
 * RPC never escapes as a render crash.
 *
 * Plain browser JavaScript: no JSX, no bundler, no imports besides `react`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-ecosystem-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Channel namespace shared with the Host half (lib/client-rpc.js). */
    const CHANNEL = '/ecosystem-guard'
    /** Locale namespace owned by this page. */
    const NS = 'ecosystemGuard'
    /** Dedupe id for the stylesheet tag this module owns. */
    const STYLE_TAG_ID = 'dsh-plugin-ecosystem-guard/client.css'
    /** Upper bound on one request; the Host bridge stays local, so this is generous. */
    const REQUEST_TIMEOUT_MS = 15000
    /** Defensive render cap for a very unhealthy ecosystem. */
    const FINDING_LIMIT = 100
    const SEVERITIES = ['pass', 'info', 'warn', 'fail']
    const SEVERITY_KEYS = {
      pass: 'severityPass',
      info: 'severityInfo',
      warn: 'severityWarn',
      fail: 'severityFail',
    }

    // -----------------------------------------------------------------------
    // Locale dictionaries (zh is the primary language, en the fallback).
    // -----------------------------------------------------------------------

    const ZH = {
      title: '插件守护',
      description: '体检已安装的插件；发现失败、冲突与重复功能，并在你确认后执行修复、重置、升级。',
      pluginVersion: '插件版本',
      runtimeVersion: '运行时',
      profile: '配置文件',
      hostChannel: 'Host 通道',
      channelChecking: '检查中',
      channelAvailable: '可用',
      channelUnavailable: '不可用',
      transportUnavailable: 'Host 通道不可用：设置页无法连接宿主插件，请确认插件守护已启用后重试。',
      requestTimeout: '请求超时：宿主在 15 秒内没有响应。',
      rpcFailed: '通信失败',
      loading: '正在读取插件守护状态…',
      scanSection: '检查结果',
      scanTime: '检查时间',
      capabilitiesSection: '插件能力',
      actionsSection: '操作',
      summaryPass: '通过',
      summaryWarn: '警告',
      summaryFail: '错误',
      findingsEmpty: '未发现需要处理的问题。',
      findingSuggested: '建议',
      moreFindings: '还有 {count} 项未显示',
      severityPass: '通过',
      severityInfo: '提示',
      severityWarn: '警告',
      severityFail: '错误',
      capPlugin: '插件',
      capModule: '模块',
      capEnabled: '启用',
      capPhase: '运行阶段',
      capTools: '暴露的工具',
      enabled: '已启用',
      disabled: '已停用',
      noTools: '未暴露工具',
      emptyCapabilities: '暂无插件能力数据。',
      actionScan: '重新自检',
      actionRepair: '修复',
      actionReset: '重置',
      actionUpgrade: '升级',
      actionDebug: '调试',
      confirmTitle: '确认执行',
      confirmRepair: '将尝试修复所有可自动修复的问题（例如重新启用加载失败的条目），完成后会自动复检。部分修复可能需要重启后才生效。',
      confirmReset: '将重置目标配置，然后自动复检。',
      confirmUpgrade: '将从插件市场检查并安装目标包的最新版本，相关插件行可能会重启。',
      confirmDebug: '将生成一份环境、服务、历史与拦截记录报告，供排查使用。',
      resetTargetLabel: '重置目标',
      resetTargetHint: 'self = 本插件配置；state = 内存历史与缓存；也可以填写某个条目 id。',
      upgradeTargetLabel: '目标包或 bundle',
      upgradeTargetHint: '例如 dsh-workspace-mover',
      targetRequired: '请先填写目标。',
      confirmButton: '确认执行',
      cancelButton: '取消',
      busy: '正在执行…',
      resultTitle: '最近一次结果',
      resultScan: '自检完成',
      resultRepair: '修复完成',
      resultReset: '重置完成',
      resultUpgrade: '升级检查完成',
      resultDebug: '调试报告已生成',
      jsonDetails: '原始 JSON',
      retry: '重试',
      errorBanner: '出现错误',
      changed: '已变更',
      unchanged: '无变更',
      attemptsUnit: '项尝试',
      skippedUnit: '项跳过',
      noRuntime: '页面运行时尚未就绪。',
    }

    const EN = {
      title: 'Plugin Guard',
      description: 'Audits installed plugins for failures, conflicts and duplicate function, and repairs, resets or upgrades them only after you confirm.',
      pluginVersion: 'Plugin version',
      runtimeVersion: 'Runtime',
      profile: 'Profile',
      hostChannel: 'Host channel',
      channelChecking: 'Checking',
      channelAvailable: 'Available',
      channelUnavailable: 'Unavailable',
      transportUnavailable: 'Host channel unavailable: this page cannot reach the Host plugin. Make sure Plugin Guard is enabled and retry.',
      requestTimeout: 'Request timed out: the Host did not answer within 15 seconds.',
      rpcFailed: 'Request failed',
      loading: 'Reading Plugin Guard state…',
      scanSection: 'Findings',
      scanTime: 'Checked at',
      capabilitiesSection: 'Plugin capabilities',
      actionsSection: 'Actions',
      summaryPass: 'Passed',
      summaryWarn: 'Warnings',
      summaryFail: 'Errors',
      findingsEmpty: 'No issues need attention.',
      findingSuggested: 'Suggested',
      moreFindings: '{count} more not shown',
      severityPass: 'Pass',
      severityInfo: 'Info',
      severityWarn: 'Warning',
      severityFail: 'Error',
      capPlugin: 'Plugin',
      capModule: 'Module',
      capEnabled: 'Enabled',
      capPhase: 'Phase',
      capTools: 'Exposed tools',
      enabled: 'Enabled',
      disabled: 'Disabled',
      noTools: 'No tools exposed',
      emptyCapabilities: 'No capability data is available.',
      actionScan: 'Rescan',
      actionRepair: 'Repair',
      actionReset: 'Reset',
      actionUpgrade: 'Upgrade',
      actionDebug: 'Debug',
      confirmTitle: 'Confirm action',
      confirmRepair: 'This attempts every automatic repair (for example re-enabling failed entries) and re-checks afterwards. Some repairs need a restart to take effect.',
      confirmReset: 'This resets the target configuration and re-checks afterwards.',
      confirmUpgrade: 'This checks the plugin market and installs the newest version of the target package; related plugin rows may restart.',
      confirmDebug: 'This generates a report of the environment, services, history and interceptions for troubleshooting.',
      resetTargetLabel: 'Reset target',
      resetTargetHint: 'self = this plugin\'s config; state = in-memory history/cache; or an entry id.',
      upgradeTargetLabel: 'Target package or bundle',
      upgradeTargetHint: 'for example dsh-workspace-mover',
      targetRequired: 'Enter a target first.',
      confirmButton: 'Confirm',
      cancelButton: 'Cancel',
      busy: 'Working…',
      resultTitle: 'Last result',
      resultScan: 'Rescan finished',
      resultRepair: 'Repair finished',
      resultReset: 'Reset finished',
      resultUpgrade: 'Upgrade check finished',
      resultDebug: 'Debug report ready',
      jsonDetails: 'Raw JSON',
      retry: 'Retry',
      errorBanner: 'Something went wrong',
      changed: 'changed',
      unchanged: 'no change',
      attemptsUnit: 'attempt(s)',
      skippedUnit: 'skipped',
      noRuntime: 'The page runtime is not ready yet.',
    }

    /** Runtime handed to the page by `apply`; the slot component reads it. */
    let currentRuntime = null

    // -----------------------------------------------------------------------
    // Small generic helpers.
    // -----------------------------------------------------------------------

    function isZhLocale(id) {
      return typeof id === 'string' && id.toLowerCase().indexOf('zh') === 0
    }

    function localText(key, localeId) {
      const primary = isZhLocale(localeId) ? ZH : EN
      const fallback = isZhLocale(localeId) ? EN : ZH
      if (typeof primary[key] === 'string') return primary[key]
      if (typeof fallback[key] === 'string') return fallback[key]
      return String(key)
    }

    function interpolate(template, params) {
      if (typeof template !== 'string') return ''
      if (!params || typeof params !== 'object') return template
      let output = template
      for (const key of Object.keys(params)) output = output.split('{' + key + '}').join(String(params[key]))
      return output
    }

    function readLocaleId(locale) {
      try {
        if (!locale || typeof locale !== 'object') return null
        const snapshots = []
        if (typeof locale.getSnapshot === 'function') snapshots.push(locale.getSnapshot())
        if (typeof locale.getLocale === 'function') snapshots.push(locale.getLocale())
        for (const snapshot of snapshots) {
          if (!snapshot || typeof snapshot !== 'object') continue
          const candidate = snapshot.id || snapshot.locale || snapshot.language || snapshot.lang
          if (typeof candidate === 'string' && candidate.length > 0) return candidate
        }
      } catch {
        /* locale service shape differs on this build */
      }
      return null
    }

    function detectBrowserLocale() {
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') return navigator.language
      } catch {
        /* non-browser host */
      }
      return null
    }

    function makeFallbackTranslate(locale) {
      return function translate(key) {
        const id = readLocaleId(locale) || detectBrowserLocale() || 'zh'
        return localText(key, id)
      }
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function textOrDash(value) {
      if (value === null || value === undefined) return '—'
      if (typeof value === 'string') return value.length > 0 ? value : '—'
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return '—'
    }

    function messageOf(value) {
      if (value && typeof value === 'object' && typeof value.message === 'string') return value.message
      return typeof value === 'string' ? value : String(value)
    }

    function normalizeError(value) {
      if (value instanceof Error) return value
      const error = new Error(messageOf(value))
      return error
    }

    function channelError(message) {
      const error = new Error(String(message))
      error.code = 'transport-unavailable'
      return error
    }

    function toCount(value) {
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }

    function countText(value) {
      return value === null || value === undefined ? '—' : String(value)
    }

    function severityOf(finding) {
      const value = finding && typeof finding === 'object' ? finding.severity : null
      return SEVERITIES.indexOf(value) >= 0 ? value : 'info'
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value.length === 0) return null
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      try {
        return date.toLocaleString()
      } catch {
        return value
      }
    }

    function safeJson(value) {
      try {
        return JSON.stringify(value, null, 2)
      } catch {
        return String(value)
      }
    }

    function normalizeToolName(tool) {
      if (typeof tool === 'string') return tool
      if (tool && typeof tool === 'object' && typeof tool.name === 'string') return tool.name
      return null
    }

    function toolNames(tools) {
      const names = []
      for (const tool of asArray(tools)) {
        const name = normalizeToolName(tool)
        if (name) names.push(name)
      }
      return names
    }

    function capabilityRows(caps, scan) {
      const rows = asArray(caps && caps.plugins).slice()
      if (rows.length > 0) return rows
      return asArray(scan && scan.plugins).slice()
    }

    function deriveSummary(scan) {
      const summary = scan && typeof scan.summary === 'object' && scan.summary !== null ? scan.summary : null
      if (summary) {
        return {
          pass: toCount(summary.pass),
          warn: toCount(summary.warn),
          fail: toCount(summary.fail),
        }
      }
      const counts = { pass: 0, warn: 0, fail: 0 }
      for (const finding of asArray(scan && scan.findings)) {
        const severity = severityOf(finding)
        if (severity === 'pass') counts.pass += 1
        else if (severity === 'warn') counts.warn += 1
        else if (severity === 'fail') counts.fail += 1
      }
      return counts
    }

    // -----------------------------------------------------------------------
    // Stylesheet (only --dsw-alias-* tokens for colors/borders/backgrounds).
    // Layout, spacing and typography follow the shipped Settings pages:
    // max-width 760px, 13px/20px body text, 18px/600 heading, cards on
    // --dsw-alias-settings-card-* tokens.
    // -----------------------------------------------------------------------

    const CSS = `
.pg-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 760px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
}
.pg-header { display: flex; flex-direction: column; gap: 4px; }
.pg-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
.pg-description { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.pg-meta { margin: 2px 0 0; display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.pg-meta code { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.pg-channel[data-available="true"] { color: var(--dsw-alias-state-success-primary); }
.pg-channel[data-available="false"] { color: var(--dsw-alias-state-error-primary); }
.pg-banners { display: flex; flex-direction: column; gap: 6px; }
.pg-banner {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  border-radius: var(--dsw-radius-md, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
}
.pg-retry-row { display: flex; gap: 8px; }
.pg-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.pg-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.pg-chip strong { font-weight: 600; color: var(--dsw-alias-label-primary); }
.pg-chip[data-tone="pass"] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent); color: var(--dsw-alias-state-success-primary); }
.pg-chip[data-tone="pass"] strong { color: var(--dsw-alias-state-success-primary); }
.pg-chip[data-tone="warn"] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary))) 45%, transparent); color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary))); }
.pg-chip[data-tone="warn"] strong { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary))); }
.pg-chip[data-tone="fail"] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); color: var(--dsw-alias-state-error-primary); }
.pg-chip[data-tone="fail"] strong { color: var(--dsw-alias-state-error-primary); }
.pg-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l3));
  border-radius: var(--dsw-radius-xl, 12px);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1));
  min-width: 0;
}
.pg-panel-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.pg-panel-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 22px; }
.pg-panel-meta { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.pg-empty { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.pg-findings { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.pg-finding {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1);
  min-width: 0;
}
.pg-badge {
  flex: none;
  display: inline-flex;
  padding: 0 8px;
  border: 0.5px solid currentColor;
  border-radius: var(--dsw-radius-sm, 6px);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.pg-badge[data-severity="pass"] { color: var(--dsw-alias-state-success-primary); }
.pg-badge[data-severity="info"] { color: var(--dsw-alias-state-business-primary); }
.pg-badge[data-severity="warn"] { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary))); }
.pg-badge[data-severity="fail"] { color: var(--dsw-alias-state-error-primary); }
.pg-finding-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.pg-finding-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font-size: 13px; line-height: 20px; font-weight: 500; }
.pg-code { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.pg-finding-detail { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.pg-finding-suggest { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.pg-table-wrap { overflow-x: auto; min-width: 0; }
.pg-table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 20px; }
.pg-table th {
  padding: 5px 8px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-weight: 500;
}
.pg-table td { padding: 6px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); vertical-align: top; overflow-wrap: anywhere; }
.pg-table tr:last-child td { border-bottom: 0; }
.pg-table code { color: var(--dsw-alias-label-primary); font-size: 12px; }
.pg-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.pg-button {
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  padding: 5px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.pg-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pg-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.pg-button:disabled { opacity: 0.55; cursor: not-allowed; }
.pg-button[data-variant="primary"] { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.pg-button[data-variant="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.pg-button[data-variant="danger"] { color: var(--dsw-alias-state-error-primary); }
.pg-button[data-variant="danger"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); }
.pg-busy { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.pg-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 0.5px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary))) 50%, transparent);
  border-radius: var(--dsw-radius-md, 8px);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warning-primary, var(--dsw-alias-state-business-primary))) 7%, transparent);
}
.pg-confirm-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
.pg-confirm-detail { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.pg-field { display: flex; flex-direction: column; gap: 4px; }
.pg-field-label { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.pg-field-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.pg-input {
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  min-width: 200px;
  max-width: 100%;
  padding: 4px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.pg-input:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.pg-confirm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.pg-validation { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 13px; line-height: 20px; }
.pg-result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 13px;
  line-height: 20px;
}
.pg-result-title { margin: 0; font-weight: 600; }
.pg-result-text { margin: 0; color: var(--dsw-alias-label-secondary); }
.pg-details summary { cursor: pointer; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.pg-details pre {
  margin: 6px 0 0;
  max-height: 260px;
  overflow: auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pg-loading { display: flex; flex-direction: column; gap: 8px; }
.pg-skeleton { height: 12px; border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-skeleton, var(--dsw-alias-bg-layer-2)); }
.pg-skeleton:nth-child(2) { width: 70%; }
.pg-skeleton:nth-child(3) { width: 45%; }
`

    /**
     * Insert this module's stylesheet unless it is already present.
     * @returns the created tag, or null when nothing was inserted.
     */
    function insertStyles() {
      try {
        if (typeof document === 'undefined') return null
        if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') !== null) return null
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-ecosystem-guard'
        tag.dataset.pluginCss = STYLE_TAG_ID
        tag.textContent = CSS
        document.head.append(tag)
        return tag
      } catch {
        return null
      }
    }

    // -----------------------------------------------------------------------
    // RPC client (Client → Host private channel).
    // -----------------------------------------------------------------------

    /**
     * Build the page-facing request function over `ctx.connection.rpc.call`.
     * @param ctx - client plugin Context.
     * @param t - translate function used for fallback error text.
     * @returns `{ call, available }`; `call(method, args)` rejects on transport failure.
     */
    function createRpcApi(ctx, t) {
      let connection = null

      function resolve() {
        if (connection !== null) return connection
        try {
          const value = ctx && typeof ctx.get === 'function' ? ctx.get('connection') : undefined
          if (value && value.rpc && typeof value.rpc.call === 'function') connection = value
        } catch {
          connection = null
        }
        return connection
      }

      function call(method, args) {
        const target = resolve()
        if (!target) return Promise.reject(channelError(t('transportUnavailable')))
        return new Promise((resolveRequest, rejectRequest) => {
          let settled = false
          let timer = null
          const finish = (settle, value) => {
            if (settled) return
            settled = true
            if (timer !== null) {
              try {
                clearTimeout(timer)
              } catch {
                /* timer unavailable */
              }
            }
            settle(value)
          }
          try {
            timer = setTimeout(() => finish(rejectRequest, channelError(t('requestTimeout'))), REQUEST_TIMEOUT_MS)
          } catch {
            timer = null
          }
          let pending
          try {
            pending = target.rpc.call(CHANNEL, method, args && typeof args === 'object' ? args : {})
          } catch (error) {
            finish(rejectRequest, normalizeError(error))
            return
          }
          Promise.resolve(pending).then(
            (result) => {
              if (!result || result.ok !== true) {
                const message = result && result.error && result.error.message ? result.error.message : t('rpcFailed')
                finish(rejectRequest, normalizeError(message))
                return
              }
              finish(resolveRequest, result.value === undefined ? null : result.value)
            },
            (error) => finish(rejectRequest, normalizeError(error)),
          )
        })
      }

      return {
        call,
        available() {
          return renderAvailable()
        },
      }

      function renderAvailable() {
        return resolve() !== null
      }
    }

    // -----------------------------------------------------------------------
    // Page component.
    // -----------------------------------------------------------------------

    /**
     * Re-render when the Client locale changes. Locale dictionaries are
     * registered by `apply`; this hook only forces a fresh render so the new
     * dictionary wins.
     * @param locale - Client locale service (optional).
     */
    function useLocaleSignal(locale) {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        let dispose
        try {
          dispose = locale.subscribe(() => force((value) => value + 1))
        } catch {
          dispose = undefined
        }
        return () => {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* unsubscribe must not throw during unmount */
          }
        }
      }, [locale])
    }

    /**
     * The Plugin Guard Settings page.
     * @param props - slot props: `{ rpc, t, locale }` (all optional; the
     *   component falls back to the runtime captured by `apply`).
     * @returns the page element tree; never throws for missing data.
     */
    function Page(rawProps) {
      const props = rawProps && typeof rawProps === 'object' ? rawProps : {}
      const injectedRpc = props.rpc && typeof props.rpc.call === 'function' ? props.rpc : null
      const runtime = injectedRpc
        ? {
            rpc: injectedRpc,
            t: typeof props.t === 'function' ? props.t : null,
            locale: props.locale || null,
          }
        : currentRuntime
      const rpcApi = runtime && runtime.rpc && typeof runtime.rpc.call === 'function' ? runtime.rpc : null
      const t = runtime && typeof runtime.t === 'function' ? runtime.t : makeFallbackTranslate(runtime ? runtime.locale : null)
      const locale = runtime ? runtime.locale : null

      useLocaleSignal(locale)

      const [data, setData] = React.useState({ info: null, scan: null, caps: null, reachable: false })
      const [phase, setPhase] = React.useState('loading')
      const [errors, setErrors] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [pending, setPending] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [resetTarget, setResetTarget] = React.useState('self')
      const [upgradeTarget, setUpgradeTarget] = React.useState('')
      const [validation, setValidation] = React.useState(null)
      const mounted = React.useRef(true)

      React.useEffect(() => {
        mounted.current = true
        void loadAll(true)
        return () => {
          mounted.current = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- one initial load per mount
      }, [])

      // ---- data loading ---------------------------------------------------

      function request(method, args) {
        if (!rpcApi) return Promise.reject(channelError(t('transportUnavailable')))
        return Promise.resolve().then(() => rpcApi.call(method, args))
      }

      function pushError(message) {
        const value = String(message && message.length > 0 ? message : t('rpcFailed'))
        setErrors((previous) => (previous.indexOf(value) >= 0 ? previous : previous.concat(value)))
      }

      function assertPayload(payload, method) {
        if (payload && payload.ok === false) {
          const reason = payload.error && payload.error.message ? payload.error.message : t('rpcFailed')
          throw new Error(method + ': ' + reason)
        }
        return payload && typeof payload === 'object' ? payload : {}
      }

      async function loadAll(first) {
        if (first) setPhase('loading')
        const methods = ['guard.status', 'guard.scan', 'guard.capabilities']
        const settled = await Promise.allSettled(methods.map((method) => request(method)))
        if (!mounted.current) return
        const next = { info: null, scan: null, caps: null, reachable: false }
        const failures = []
        const fields = ['info', 'scan', 'caps']
        settled.forEach((outcome, index) => {
          const method = methods[index]
          const field = fields[index]
          if (outcome.status !== 'fulfilled') {
            failures.push(method + ': ' + messageOf(outcome.reason))
            return
          }
          try {
            const payload = assertPayload(outcome.value, method)
            next[field] = payload
            next.reachable = true
          } catch (error) {
            failures.push(messageOf(error))
          }
        })
        setData((previous) => ({
          info: next.info || previous.info,
          scan: next.scan || previous.scan,
          caps: next.caps || previous.caps,
          reachable: next.reachable || previous.reachable,
        }))
        setPhase('ready')
        setErrors(failures)
      }

      // ---- actions --------------------------------------------------------

      function arm(kind) {
        if (busy) return
        setResult(null)
        setValidation(null)
        if (kind === 'reset' && !resetTarget) setResetTarget('self')
        setPending({ kind })
      }

      function confirmPending() {
        if (!pending || busy) return
        if (pending.kind === 'upgrade' && upgradeTarget.trim() === '') {
          setValidation(t('targetRequired'))
          return
        }
        if (pending.kind === 'reset' && resetTarget.trim() === '') {
          setValidation(t('targetRequired'))
          return
        }
        void runAction(pending.kind)
      }

      async function runAction(kind) {
        if (busy) return
        setBusy(true)
        setErrors([])
        setValidation(null)
        setResult(null)
        try {
          let requestArgs = {}
          let method = 'guard.' + kind
          if (kind === 'scan') {
            method = 'guard.scan'
            requestArgs = {}
          } else if (kind === 'repair') {
            requestArgs = { confirmed: true }
          } else if (kind === 'reset') {
            requestArgs = { target: (resetTarget || 'self').trim(), confirmed: true }
          } else if (kind === 'upgrade') {
            requestArgs = { target: upgradeTarget.trim(), confirmed: true }
          } else if (kind === 'debug') {
            requestArgs = { confirmed: true }
          }
          const payload = assertPayload(await request(method, requestArgs), method)
          if (!mounted.current) return
          setResult({ kind, payload })
          if (kind === 'scan') {
            setData((previous) => ({ ...previous, scan: payload, reachable: true }))
          } else if (kind !== 'debug') {
            await loadAll(false)
          }
        } catch (error) {
          if (mounted.current) pushError(messageOf(error))
        } finally {
          if (mounted.current) {
            setBusy(false)
            setPending(null)
          }
        }
      }

      // ---- derived data ---------------------------------------------------

      const info = data.info && typeof data.info === 'object' ? data.info : null
      const scan = data.scan && typeof data.scan === 'object' ? data.scan : null
      const caps = data.caps && typeof data.caps === 'object' ? data.caps : null
      const summary = deriveSummary(scan)
      const findings = asArray(scan && scan.findings).filter((finding) => severityOf(finding) !== 'pass')
      const shownFindings = findings.slice(0, FINDING_LIMIT)
      const rows = capabilityRows(caps, scan)
      const channelState = data.reachable ? 'available' : phase === 'loading' ? 'checking' : 'unavailable'
      const channelOk = channelState === 'available'
      const channelLabel = channelState === 'available'
        ? t('channelAvailable')
        : channelState === 'checking'
          ? t('channelChecking')
          : t('channelUnavailable')

      // ---- render helpers -------------------------------------------------

      function renderFinding(finding, index) {
        const severity = severityOf(finding)
        const title = textOrDash(finding && finding.title)
        const code = finding && finding.code ? String(finding.code) : null
        const detail = finding && finding.detail !== undefined && finding.detail !== null ? textOrDash(finding.detail) : null
        const suggestion = finding && finding.repairable && finding.suggestedAction
          ? t('findingSuggested') + ': ' + String(finding.suggestedAction)
          : null
        return h(
          'li',
          { className: 'pg-finding', 'data-severity': severity, key: String((finding && finding.id) || index) },
          h('span', { className: 'pg-badge', 'data-severity': severity }, t(SEVERITY_KEYS[severity])),
          h(
            'div',
            { className: 'pg-finding-body' },
            h(
              'div',
              { className: 'pg-finding-head' },
              h('span', null, title),
              code ? h('code', { className: 'pg-code' }, code) : null,
            ),
            detail ? h('p', { className: 'pg-finding-detail' }, detail) : null,
            suggestion ? h('p', { className: 'pg-finding-suggest' }, suggestion) : null,
          ),
        )
      }

      function renderChip(tone, label, value) {
        return h(
          'span',
          { className: 'pg-chip', 'data-tone': tone, key: tone },
          h('strong', null, countText(value)),
          h('span', null, label),
        )
      }

      function renderCapabilityRow(row, index) {
        const toolList = toolNames(row && row.tools)
        const enabledText = row && typeof row.enabled === 'boolean' ? (row.enabled ? t('enabled') : t('disabled')) : '—'
        return h(
          'tr',
          { key: String((row && (row.entryId || row.moduleName)) || index) },
          h('td', null, textOrDash(row && (row.title || row.moduleName))),
          h('td', null, h('code', null, textOrDash(row && row.moduleName))),
          h('td', null, enabledText),
          h('td', null, textOrDash(row && row.fiberPhase)),
          h('td', null, toolList.length > 0 ? toolList.join(', ') : t('noTools')),
        )
      }

      function renderConfirm(current) {
        if (!current) return null
        const kind = current.kind
        const labelKey = 'action' + kind.charAt(0).toUpperCase() + kind.slice(1)
        const detailKey = 'confirm' + kind.charAt(0).toUpperCase() + kind.slice(1)
        const children = [
          h('p', { className: 'pg-confirm-title', key: 'title' }, t('confirmTitle') + ' · ' + t(labelKey)),
          h('p', { className: 'pg-confirm-detail', key: 'detail' }, t(detailKey)),
        ]
        if (kind === 'reset') {
          children.push(
            h(
              'label',
              { className: 'pg-field', key: 'field-reset' },
              h('span', { className: 'pg-field-label' }, t('resetTargetLabel')),
              h('input', {
                className: 'pg-input',
                type: 'text',
                value: resetTarget,
                spellCheck: false,
                'aria-label': t('resetTargetLabel'),
                onChange: (event) => {
                  setResetTarget(event.currentTarget.value)
                  setValidation(null)
                },
              }),
              h('span', { className: 'pg-field-hint' }, t('resetTargetHint')),
            ),
          )
        }
        if (kind === 'upgrade') {
          children.push(
            h(
              'label',
              { className: 'pg-field', key: 'field-upgrade' },
              h('span', { className: 'pg-field-label' }, t('upgradeTargetLabel')),
              h('input', {
                className: 'pg-input',
                type: 'text',
                value: upgradeTarget,
                placeholder: 'dsh-workspace-mover',
                spellCheck: false,
                'aria-label': t('upgradeTargetLabel'),
                onChange: (event) => {
                  setUpgradeTarget(event.currentTarget.value)
                  setValidation(null)
                },
              }),
              h('span', { className: 'pg-field-hint' }, t('upgradeTargetHint')),
            ),
          )
        }
        children.push(
          h(
            'div',
            { className: 'pg-confirm-actions', key: 'actions' },
            h(
              'button',
              { type: 'button', className: 'pg-button', 'data-variant': 'primary', disabled: busy, onClick: confirmPending },
              t('confirmButton'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pg-button',
                disabled: busy,
                onClick: () => {
                  setPending(null)
                  setValidation(null)
                },
              },
              t('cancelButton'),
            ),
          ),
        )
        return h('div', { className: 'pg-confirm', role: 'group', 'aria-label': t('confirmTitle') }, children)
      }

      function summarize(kind, payload) {
        if (!payload || typeof payload !== 'object') return ''
        if (kind === 'repair') {
          const attempts = asArray(payload.attempts)
          const skipped = asArray(payload.skipped)
          const after = payload.after && typeof payload.after === 'object' ? payload.after : null
          const parts = [attempts.length + ' ' + t('attemptsUnit') + ', ' + skipped.length + ' ' + t('skippedUnit')]
          if (after) parts.push(t('summaryFail') + ' ' + countText(toCount(after.fail)) + ' · ' + t('summaryWarn') + ' ' + countText(toCount(after.warn)))
          return parts.join(' · ')
        }
        if (kind === 'reset') {
          const changed = payload.changed === true ? t('changed') : t('unchanged')
          return textOrDash(payload.detail) + ' · ' + textOrDash(payload.target) + ' · ' + changed
        }
        if (kind === 'upgrade') {
          const versions = textOrDash(payload.currentVersion) + ' → ' + textOrDash(payload.availableVersion)
          const tail = payload.changed === true ? textOrDash(payload.application) : textOrDash(payload.detail)
          return textOrDash(payload.target) + ' · ' + versions + ' · ' + tail
        }
        if (kind === 'debug') {
          const generatedAt = formatTime(payload.generatedAt)
          return generatedAt ? t('resultDebug') + ' · ' + generatedAt : t('resultDebug')
        }
        const current = deriveSummary(payload)
        return t('summaryPass') + ' ' + countText(current.pass) + ' · ' + t('summaryWarn') + ' ' + countText(current.warn) + ' · ' + t('summaryFail') + ' ' + countText(current.fail)
      }

      function renderResult(current) {
        if (!current) return null
        const kind = current.kind
        const titleKey = 'result' + kind.charAt(0).toUpperCase() + kind.slice(1)
        return h(
          'div',
          { className: 'pg-result', role: 'status' },
          h('p', { className: 'pg-result-title' }, t('resultTitle') + ' · ' + t(titleKey)),
          h('p', { className: 'pg-result-text' }, summarize(kind, current.payload)),
          h(
            'details',
            { className: 'pg-details' },
            h('summary', null, t('jsonDetails')),
            h('pre', null, safeJson(current.payload)),
          ),
        )
      }

      // ---- missing runtime fallback --------------------------------------

      if (!runtime) {
        return h(
          'div',
          { className: 'pg-section' },
          h('h2', { className: 'pg-title' }, t('title')),
          h('div', { className: 'pg-banner', 'data-tone': 'error', role: 'alert' }, t('noRuntime') + ' ' + t('transportUnavailable')),
        )
      }

      // ---- page -----------------------------------------------------------

      const header = h(
        'header',
        { className: 'pg-header' },
        h('h2', { className: 'pg-title' }, t('title')),
        h('p', { className: 'pg-description' }, t('description')),
        h(
          'p',
          { className: 'pg-meta' },
          h('span', null, t('pluginVersion') + ' ', h('code', null, textOrDash(info && info.version))),
          h('span', null, t('runtimeVersion') + ' ', h('code', null, textOrDash(info && info.runtimeVersion))),
          h('span', null, t('profile') + ' ', h('code', null, textOrDash(info && info.profile))),
          h(
            'span',
            null,
            t('hostChannel') + ' ',
            h('span', { className: 'pg-channel', 'data-available': channelOk ? 'true' : 'false' }, channelLabel),
          ),
        ),
      )

      const banners = errors.length > 0
        ? h(
            'div',
            { className: 'pg-banners', key: 'banners' },
            errors.map((message, index) => h('div', { className: 'pg-banner', 'data-tone': 'error', role: 'alert', key: String(index) }, message)),
          )
        : null

      const retryRow = errors.length > 0 && !busy
        ? h(
            'div',
            { className: 'pg-retry-row', key: 'retry' },
            h(
              'button',
              {
                type: 'button',
                className: 'pg-button',
                onClick: () => {
                  void loadAll(true)
                },
              },
              t('retry'),
            ),
          )
        : null

      const loadingCard = phase === 'loading' && !scan && !caps
        ? h(
            'div',
            { className: 'pg-loading', role: 'status', 'aria-busy': 'true', key: 'loading' },
            h('span', { className: 'pg-skeleton' }),
            h('span', { className: 'pg-skeleton' }),
            h('span', { className: 'pg-skeleton' }),
            h('span', { className: 'pg-empty' }, t('loading')),
          )
        : null

      const chips = h(
        'div',
        { className: 'pg-chips', key: 'chips' },
        renderChip('pass', t('summaryPass'), summary.pass),
        renderChip('warn', t('summaryWarn'), summary.warn),
        renderChip('fail', t('summaryFail'), summary.fail),
      )

      const findingsPanel = h(
        'section',
        { className: 'pg-panel', key: 'findings' },
        h(
          'div',
          { className: 'pg-panel-head' },
          h('h3', { className: 'pg-panel-title' }, t('scanSection')),
          scan && scan.generatedAt
            ? h('span', { className: 'pg-panel-meta' }, t('scanTime') + ' ' + textOrDash(formatTime(scan.generatedAt)))
            : null,
        ),
        shownFindings.length === 0
          ? h('p', { className: 'pg-empty' }, t('findingsEmpty'))
          : h('ul', { className: 'pg-findings' }, shownFindings.map((finding, index) => renderFinding(finding, index))),
        findings.length > FINDING_LIMIT
          ? h('p', { className: 'pg-empty' }, interpolate(t('moreFindings'), { count: findings.length - FINDING_LIMIT }))
          : null,
      )

      const capabilitiesPanel = h(
        'section',
        { className: 'pg-panel', key: 'capabilities' },
        h('div', { className: 'pg-panel-head' }, h('h3', { className: 'pg-panel-title' }, t('capabilitiesSection'))),
        rows.length === 0
          ? h('p', { className: 'pg-empty' }, t('emptyCapabilities'))
          : h(
              'div',
              { className: 'pg-table-wrap' },
              h(
                'table',
                { className: 'pg-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    ['capPlugin', 'capModule', 'capEnabled', 'capPhase', 'capTools'].map((key) =>
                      h('th', { scope: 'col', key }, t(key)),
                    ),
                  ),
                ),
                h('tbody', null, rows.map((row, index) => renderCapabilityRow(row, index))),
              ),
            ),
      )

      const actionButtons = [
        h(
          'button',
          {
            type: 'button',
            className: 'pg-button',
            'data-variant': 'primary',
            disabled: busy,
            key: 'scan',
            onClick: () => {
              void runAction('scan')
            },
          },
          t('actionScan'),
        ),
        h(
          'button',
          { type: 'button', className: 'pg-button', 'data-variant': 'danger', disabled: busy, key: 'repair', onClick: () => arm('repair') },
          t('actionRepair'),
        ),
        h(
          'button',
          { type: 'button', className: 'pg-button', 'data-variant': 'danger', disabled: busy, key: 'reset', onClick: () => arm('reset') },
          t('actionReset'),
        ),
        h(
          'button',
          { type: 'button', className: 'pg-button', 'data-variant': 'danger', disabled: busy, key: 'upgrade', onClick: () => arm('upgrade') },
          t('actionUpgrade'),
        ),
        h(
          'button',
          { type: 'button', className: 'pg-button', 'data-variant': 'danger', disabled: busy, key: 'debug', onClick: () => arm('debug') },
          t('actionDebug'),
        ),
      ]

      const actionsPanel = h(
        'section',
        { className: 'pg-panel', key: 'actions' },
        h('div', { className: 'pg-panel-head' }, h('h3', { className: 'pg-panel-title' }, t('actionsSection'))),
        h('div', { className: 'pg-actions', role: 'group', 'aria-label': t('actionsSection') }, actionButtons),
        busy ? h('p', { className: 'pg-busy', role: 'status' }, t('busy')) : null,
        renderConfirm(pending),
        validation ? h('p', { className: 'pg-validation', role: 'alert' }, validation) : null,
        renderResult(result),
      )

      return h(
        'div',
        { className: 'pg-section', 'aria-busy': busy || phase === 'loading' ? 'true' : 'false' },
        header,
        banners,
        retryRow,
        loadingCard,
        chips,
        findingsPanel,
        capabilitiesPanel,
        actionsPanel,
      )
    }

    // -----------------------------------------------------------------------
    // Plugin body.
    // -----------------------------------------------------------------------

    /** Hard dependency: the slot registry. Everything else degrades. */
    const inject = ['slots']

    /**
     * Register the page and its Host channel.
     * @param ctx - client plugin Context.
     */
    function apply(ctx) {
      let locale = null
      try {
        locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null
      } catch {
        locale = null
      }
      if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') locale = null

      let t
      if (locale) {
        try {
          ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'ecosystem-guard: settings page dictionaries')
          t = locale.bind(NS)
          if (typeof t !== 'function') t = makeFallbackTranslate(locale)
        } catch {
          t = makeFallbackTranslate(locale)
        }
      } else {
        t = makeFallbackTranslate(null)
      }

      const rpcApi = createRpcApi(ctx, t)
      currentRuntime = { rpc: rpcApi, t, locale }

      try {
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            const tag = insertStyles()
            return () => {
              try {
                if (tag) tag.remove()
              } catch {
                /* tag may already be gone */
              }
            }
          }, 'ecosystem-guard: settings page styles')
        } else {
          insertStyles()
        }
      } catch {
        insertStyles()
      }

      try {
        if (ctx && ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
          ctx.slots.inject('settings.plugins.tab', () =>
            ctx.slots.register(
              {
                name: 'settings.plugins.tab',
                id: 'ecosystem-guard',
                order: 70,
                label: () => t('title'),
                locale: NS,
                inject: () => ({ rpc: rpcApi, t, locale }),
              },
              Page,
            ),
          )
        }
      } catch (error) {
        try {
          console.error('[ecosystem-guard] 设置页注册失败：', error)
        } catch {
          /* console unavailable */
        }
      }
    }

    return { inject, apply }
  },
})

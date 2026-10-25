/**
 * Self-test for the pure analysis engine. Run with:
 *   node --test ecosystem-guard/test/selftest.mjs
 * It needs no Harness: every input is synthetic, so a failure here is a real
 * engine bug rather than a profile problem.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyzeInstall,
  attributeTools,
  buildCapabilities,
  buildScan,
  compareSemver,
  contentTokens,
  isInvokeDenied,
  isProtectedModule,
  overlapCoefficient,
  parseSemver,
  runtimeVersionFromBundles,
  sanitizeText,
  satisfiesDsh,
  summarizeAnalysis,
  DEFAULTS,
} from '../lib/doctor.js'

const services = {
  pluginManager: true,
  tools: true,
  userQuestions: true,
  connection: true,
  configEditor: true,
}

function plugin(entryId, moduleName, extra = {}) {
  return {
    entryId,
    moduleName,
    enabled: true,
    fiberPhase: 'active',
    meta: { title: moduleName },
    ...extra,
  }
}

function bundle(name, extra = {}) {
  return {
    name,
    official: false,
    availability: 'profile',
    version: '1.0.0',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [{ rowId: name, moduleName: name }],
    overrides: [],
    ...extra,
  }
}

test('semver parsing and comparison', () => {
  assert.deepEqual(parseSemver('1.2.3') && parseSemver('1.2.3').major, 1)
  assert.equal(parseSemver('not-a-version'), null)
  assert.equal(compareSemver('0.2.1', '0.2.0'), 1)
  assert.equal(compareSemver('0.2.1-rc.3', '0.2.1'), -1)
  assert.equal(compareSemver('0.2.1-rc.3', '0.2.1-rc.2'), 1)
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0)
})

test('engines.dsh evaluation never blocks on unknown syntax', () => {
  assert.equal(satisfiesDsh('>=0.2.1-rc.1', '0.2.1-rc.3'), 'ok')
  assert.equal(satisfiesDsh('^0.2.0', '0.2.1-rc.3'), 'ok')
  assert.equal(satisfiesDsh('>=1.0.0', '0.2.1-rc.3'), 'no')
  assert.equal(satisfiesDsh('>=0.1.5-rc.1', '0.2.1-rc.3'), 'ok')
  assert.equal(satisfiesDsh('workspace:*', '0.2.1-rc.3'), 'unknown')
  assert.equal(satisfiesDsh('', '0.2.1-rc.3'), 'unknown')
})

test('runtime version comes from the installation bundle', () => {
  const version = runtimeVersionFromBundles([
    bundle('dsh-workspace-mover', { version: '2.4.1', official: false }),
    bundle('@deepseek-ai/dsh-base', { version: '0.2.1-rc.3', official: true, availability: 'installation' }),
  ])
  assert.equal(version, '0.2.1-rc.3')
})

test('tool attribution follows package-name tokens and stays conservative', () => {
  const plugins = [
    plugin('include:workspace-mover', 'dsh-workspace-mover'),
    plugin('include:plugin-manager', '@deepseek-ai/dsh-plugin-manager/tools'),
    plugin('include:tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'),
  ]
  const tools = [
    { name: 'mover_move_session', description: '' },
    { name: 'plugin_manager', description: '' },
    { name: 'pwsh', description: '' },
    { name: 'totally_unrelated_thing', description: '' },
  ]
  const map = attributeTools(tools, plugins)
  assert.equal(map.get('mover_move_session'), 'include:workspace-mover')
  assert.equal(map.get('plugin_manager'), 'include:plugin-manager')
  assert.equal(map.get('pwsh'), 'include:tool-pwsh')
  assert.equal(map.get('totally_unrelated_thing'), null)
})

test('scan reports failed entries and duplicate mounts', () => {
  const report = buildScan({
    plugins: [
      plugin('include:ok', 'dsh-ok'),
      plugin('include:broken', 'dsh-broken', { fiberPhase: 'failed' }),
      plugin('include:dup-a', 'dsh-dup'),
      plugin('include:dup-b', 'dsh-dup'),
    ],
    bundles: [bundle('dsh-ok'), bundle('dsh-broken')],
    tools: [{ name: 'ok_run', description: '' }],
    services,
    config: DEFAULTS,
  })
  const codes = report.findings.map((item) => item.code)
  assert.ok(codes.includes('entry-failed'))
  assert.ok(codes.includes('duplicate-module'))
  assert.equal(report.counts.plugins, 4)
  assert.ok(report.summary.fail >= 1)
  // A shared module mount is advisory only: preset layers and shared libraries do it on purpose.
  assert.equal(report.findings.find((item) => item.code === 'duplicate-module').severity, 'info')
  const failed = report.findings.find((item) => item.code === 'entry-failed')
  assert.equal(failed.repairable, true)
  assert.equal(failed.action.kind, 'retry-entry')
})

test('a healthy profile reports a pass finding instead of an empty list', () => {
  const report = buildScan({
    plugins: [plugin('include:ok', 'dsh-ok')],
    bundles: [bundle('dsh-ok')],
    tools: [{ name: 'ok_run', description: '' }],
    services,
    config: DEFAULTS,
  })
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].severity, 'pass')
  assert.equal(report.summary.fail, 0)
})

test('bundle errors map to incompatible or repairable findings', () => {
  const report = buildScan({
    plugins: [],
    bundles: [
      bundle('dsh-old', {
        error: {
          code: 'incompatible-version',
          incompatible: [{ name: 'dsh-old', version: '1.0.0', runtimeVersion: '0.2.1', requirements: { dsh: '>=1.0.0' } }],
        },
      }),
      bundle('dsh-flaky', { error: { code: 'operation-error', diagnostic: 'pnpm died' } }),
    ],
    tools: [],
    services,
    config: DEFAULTS,
  })
  const incompatible = report.findings.find((item) => item.subject === 'dsh-old')
  const flaky = report.findings.find((item) => item.subject === 'dsh-flaky')
  assert.equal(incompatible.code, 'incompatible')
  assert.equal(incompatible.repairable, false)
  assert.equal(flaky.repairable, true)
  assert.equal(flaky.action.kind, 'retry-bundle')
})

test('self degradation is reported when a required service is missing', () => {
  const report = buildScan({
    plugins: [],
    bundles: [],
    tools: [],
    services: { pluginManager: false, tools: false },
    config: DEFAULTS,
  })
  const ids = report.findings.map((item) => item.id)
  assert.ok(ids.includes('self-degraded:services'))
  assert.ok(ids.includes('self-degraded:confirmation'))
  assert.equal(report.summary.fail >= 1, true)
})

test('duplicate function detection fires on overlapping descriptions only', () => {
  const near = buildScan({
    plugins: [],
    bundles: [
      bundle('dsh-workspace-heal', { description: 'Recreate deleted workspace folders and import session context as a summary.' }),
      bundle('dsh-workspace-heal-plus', { description: 'Recreate deleted workspace folders and import session context as a summary with extra options.' }),
    ],
    tools: [],
    services,
    config: DEFAULTS,
  })
  const dial = buildScan({
    plugins: [],
    bundles: [
      bundle('dsh-web-search', { description: 'Search the web with a provider and fetch pages.' }),
      bundle('dsh-session-title', { description: 'Generate a session title from the first prompt with a model.' }),
    ],
    tools: [],
    services,
    config: DEFAULTS,
  })
  // Installation-provided composition layers overlap by design and are never compared.
  const composition = buildScan({
    plugins: [],
    bundles: [
      bundle('@deepseek-ai/dsh-base', { availability: 'installation', description: 'Base agent API over the DSH core.' }),
      bundle('@deepseek-ai/dsh-headless', { availability: 'installation', description: 'Headless agent API over the DSH core.' }),
    ],
    tools: [],
    services,
    config: DEFAULTS,
  })
  assert.ok(near.findings.some((item) => item.code === 'duplicate-function'))
  assert.ok(!dial.findings.some((item) => item.code === 'duplicate-function'))
  assert.ok(!composition.findings.some((item) => item.code === 'duplicate-function'))
})

test('analyzeInstall blocks an incompatible local manifest but not a plain refusal', () => {
  // A refusal means "the manager will decline it", not "this conflicts with what
  // you have". Blocking here would put an approval prompt in front of every
  // ordinary reinstall of an installed package.
  const refused = analyzeInstall({
    spec: 'nope',
    inspection: { status: 'refused', problem: 'not-found', reason: 'no such package' },
    bundles: [],
    plugins: [],
    tools: [],
    config: DEFAULTS,
  })
  assert.equal(refused.verdict, 'warn')
  assert.equal(refused.conflicts.length, 0)
  assert.equal(refused.warnings[0].code, 'spec-refused')

  const already = analyzeInstall({
    spec: 'dsh-workspace-mover',
    inspection: { status: 'refused', problem: 'already-installed', reason: 'already installed' },
    bundles: [bundle('dsh-workspace-mover', { version: '2.4.1' })],
    plugins: [],
    tools: [],
    config: DEFAULTS,
  })
  assert.equal(already.verdict, 'warn')
  assert.equal(already.conflicts.length, 0)

  const incompatible = analyzeInstall({
    spec: '/tmp/old-plugin',
    inspection: { status: 'accepted', kind: 'path', name: 'old-plugin', version: '2.0.0', bundle: true },
    bundles: [bundle('@deepseek-ai/dsh-base', { version: '0.2.1-rc.3', official: true, availability: 'installation' })],
    plugins: [],
    tools: [],
    localManifest: JSON.stringify({ name: 'old-plugin', engines: { dsh: '>=1.0.0' } }),
    config: DEFAULTS,
  })
  assert.equal(incompatible.verdict, 'block')
  assert.equal(incompatible.conflicts[0].code, 'incompatible-system')
})

test('analyzeInstall warns without blocking on a version change and duplicate function', () => {
  const analysis = analyzeInstall({
    spec: 'dsh-workspace-heal-plus',
    inspection: {
      status: 'accepted',
      kind: 'registry',
      name: 'dsh-workspace-heal-plus',
      version: '1.1.0',
      bundle: true,
      description: 'Recreate deleted workspace folders and import session context as a summary.',
    },
    bundles: [
      bundle('dsh-workspace-heal', { version: '0.1.1', description: 'Recreate deleted workspace folders and import session context as a summary.' }),
    ],
    plugins: [],
    tools: [],
    config: DEFAULTS,
  })
  assert.equal(analysis.verdict, 'warn')
  assert.equal(analysis.conflicts.length, 0)
  const codes = analysis.warnings.map((item) => item.code)
  assert.ok(codes.includes('duplicate-function'))
  const summary = summarizeAnalysis(analysis)
  assert.match(summary, /插件守护预检/)
})

test('capabilities catalog lists services and tools per plugin', () => {
  const catalog = buildCapabilities({
    plugins: [plugin('include:mover', 'dsh-workspace-mover')],
    tools: [{ name: 'mover_move_session', description: 'move' }],
    packages: [{ package: 'dsh-workspace-mover', face: 'host', model: { services: [{ key: 'workspaceMover' }] } }],
  })
  assert.equal(catalog.plugins.length, 1)
  assert.deepEqual(catalog.plugins[0].tools.map((item) => item.name), ['mover_move_session'])
  assert.deepEqual(catalog.plugins[0].services, ['workspaceMover'])
  assert.equal(catalog.attribution, 'heuristic')
})

test('tool attribution prefers the distinctive package over a generic domain word', () => {
  const plugins = [
    plugin('include:session', '@deepseek-ai/dsh-session'),
    plugin('include:session-title', '@deepseek-ai/dsh-session-title'),
    plugin('include:session-query', '@deepseek-ai/dsh-session-query-sqlite'),
    plugin('include:mover', 'dsh-workspace-mover'),
    plugin('include:subagent', '@deepseek-ai/dsh-agent'),
    plugin('include:codex', '@deepseek-ai/dsh-subagent-codex'),
  ]
  const map = attributeTools([
    { name: 'mover_move_session', description: '' },
    { name: 'mover_repair_sessions', description: '' },
    { name: 'subagent_codex', description: '' },
  ], plugins)
  assert.equal(map.get('mover_move_session'), 'include:mover')
  assert.equal(map.get('mover_repair_sessions'), 'include:mover')
  assert.equal(map.get('subagent_codex'), 'include:codex')
})

test('content token overlap ignores generic words', () => {
  const a = contentTokens('Provides plugin tools for the harness with session migration support')
  const b = contentTokens('Session migration: move a session between workspaces')
  assert.ok(!a.has('plugin'))
  assert.ok(overlapCoefficient(a, b) > 0)
})

// ---------------------------------------------------------------------------
// Security invariants. These are the promises the plugin makes to the user;
// they are asserted here so a future change cannot quietly remove one.
// ---------------------------------------------------------------------------

test('security-boundary modules are protected from repair and reset', () => {
  for (const moduleName of [
    '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-permission-presets',
    '@deepseek-ai/dsh-sandbox-local',
    'dsh-credentials-local',
    '@deepseek-ai/dsh-authorization',
    '@deepseek-ai/dsh-deepseek-account-platform',
  ]) {
    assert.equal(isProtectedModule(moduleName), true, `${moduleName} must be protected`)
  }
  // Ordinary plugins and the guard itself stay maintainable.
  for (const moduleName of ['dsh-plugin-ecosystem-guard', 'dsh-workspace-mover', 'dsh-plugin-manager', '@deepseek-ai/dsh-session-title']) {
    assert.equal(isProtectedModule(moduleName), false, `${moduleName} must not be protected`)
  }
})

test('a failing protected module is reported but never marked repairable', () => {
  const report = buildScan({
    plugins: [
      plugin('include:approval', '@deepseek-ai/dsh-user-approval', { fiberPhase: 'failed' }),
      plugin('include:normal', 'dsh-normal', { fiberPhase: 'failed' }),
    ],
    bundles: [],
    tools: [],
    services,
    config: DEFAULTS,
  })
  const protectedFinding = report.findings.find((item) => item.subject === 'include:approval')
  const normalFinding = report.findings.find((item) => item.subject === 'include:normal')
  assert.equal(protectedFinding.code, 'entry-failed')
  assert.equal(protectedFinding.repairable, false)
  assert.equal(protectedFinding.action, null)
  assert.equal(normalFinding.repairable, true)
})

test('high-impact tools can never be brokered, whatever the config says', () => {
  for (const toolName of [
    'plugin_manager', 'plugin_market', 'run_code', 'bash', 'pwsh', 'write',
    'edit', 'cordis_run', 'cordis_define', 'terminal_send', 'plugin_guard',
  ]) {
    assert.equal(isInvokeDenied(toolName), true, `${toolName} must be denied`)
  }
  for (const toolName of ['mover_move_session', 'workspace_heal', 'session_search']) {
    assert.equal(isInvokeDenied(toolName), false, `${toolName} must be allowed by the hard filter`)
  }
})

test('untrusted text is flattened and bounded before display', () => {
  const hostile = 'line1\nline2\u0000\u001b[31m' + 'x'.repeat(1000)
  const safe = sanitizeText(hostile, 40)
  assert.equal(safe.includes('\n'), false)
  assert.equal(safe.includes('\u0000'), false)
  assert.equal(safe.includes('\u001b'), false)
  assert.ok(safe.length <= 41)
  assert.equal(sanitizeText(undefined), '')
})

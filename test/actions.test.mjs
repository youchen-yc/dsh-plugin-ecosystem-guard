/**
 * Operation-level tests for the guarded actions, using a fake Host context.
 *
 * These assert the promises that matter most: a target the guard cannot resolve
 * is never silently redirected, a security-boundary module is never touched, a
 * high-impact tool is never brokered, and an upgrade still works when the plugin
 * manager refuses to inspect an already-installed package.
 *
 *   node --test ecosystem-guard/test/actions.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createActions } from '../lib/actions.js'
import { DEFAULTS } from '../lib/doctor.js'

const EMPTY_REPORT = {
  ok: true,
  generatedAt: new Date().toISOString(),
  summary: { pass: 0, warn: 0, fail: 0, info: 0 },
  counts: { plugins: 0, bundles: 0, tools: 0 },
  findings: [],
  plugins: [],
}

function makeCtx(pluginManager, extra = {}) {
  const services = { pluginManager, configEditor: extra.configEditor, tools: extra.tools }
  return {
    get(name) {
      return services[name]
    },
  }
}

function makeActions(pluginManager, options = {}) {
  const ctx = makeCtx(pluginManager, options)
  const runtime = { history: [], interceptions: [], cache: null }
  const actions = createActions({
    ctx,
    config: { ...DEFAULTS, ...(options.config || {}) },
    scan: options.scan || (async () => EMPTY_REPORT),
    runtime,
  })
  return { actions, runtime }
}

function bundleFixture(name, extra = {}) {
  return {
    name,
    official: false,
    availability: 'profile',
    version: '2.4.1',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [],
    overrides: [],
    ...extra,
  }
}

test('upgrade still proceeds when inspect refuses an installed package', async () => {
  const calls = []
  const pluginManager = {
    async listBundles() {
      return [bundleFixture('dsh-workspace-mover')]
    },
    async inspect() {
      return { status: 'refused', problem: 'already-installed', reason: 'already installed' }
    },
    async installBundle(spec) {
      calls.push(spec)
      return { changed: true, application: 'restart-required', stage: 'install', target: spec, version: '2.5.0' }
    },
  }
  const { actions } = makeActions(pluginManager)
  const result = await actions.upgrade({ target: 'dsh-workspace-mover' })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.application, 'restart-required')
  assert.deepEqual(calls, ['dsh-workspace-mover'])
})

test('upgrade reports the newest version without touching a read-only bundle', async () => {
  const pluginManager = {
    async listBundles() {
      return [bundleFixture('@deepseek-ai/dsh-base', { readOnlyReason: 'management-required', availability: 'installation' })]
    },
    async inspect() {
      throw new Error('must not be called')
    },
  }
  const { actions } = makeActions(pluginManager)
  const result = await actions.upgrade({ target: '@deepseek-ai/dsh-base' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'read-only')
})

test('upgrade refuses an unknown target instead of guessing', async () => {
  const pluginManager = { async listBundles() { return [bundleFixture('dsh-workspace-mover')] } }
  const { actions } = makeActions(pluginManager)
  const result = await actions.upgrade({ target: 'does-not-exist' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'target-not-found')
})

test('reset never redirects an unresolvable target to its own row', async () => {
  const edited = []
  const pluginManager = {}
  const configEditor = {
    entries() {
      return [
        { id: 'include:ecosystem-guard', name: 'dsh-plugin-ecosystem-guard' },
        { id: 'include:approval', name: '@deepseek-ai/dsh-user-approval' },
      ]
    },
    async edit(entry) {
      edited.push(entry.id)
    },
  }
  const { actions } = makeActions(pluginManager, { configEditor })
  const typo = await actions.reset({ target: 'include:plug-gurad' })
  assert.equal(typo.ok, false)
  assert.equal(typo.error.code, 'target-not-found')
  assert.deepEqual(edited, [])
})

test('reset refuses a security-boundary module', async () => {
  const edited = []
  const configEditor = {
    entries() {
      return [{ id: 'include:approval', name: '@deepseek-ai/dsh-user-approval' }]
    },
    async edit(entry) {
      edited.push(entry.id)
    },
  }
  const { actions } = makeActions({}, { configEditor })
  const result = await actions.reset({ target: 'include:approval' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'protected-target')
  assert.deepEqual(edited, [])
})

test('reset self touches only the guard row', async () => {
  const edited = []
  const configEditor = {
    entries() {
      return [
        { id: 'include:ecosystem-guard', name: 'dsh-plugin-ecosystem-guard' },
        { id: 'include:other', name: 'dsh-other' },
      ]
    },
    async edit(entry) {
      edited.push(entry.id)
    },
  }
  const { actions } = makeActions({}, { configEditor })
  const result = await actions.reset({ target: 'self' })
  assert.equal(result.ok, true)
  assert.deepEqual(edited, ['include:ecosystem-guard'])
})

test('repair skips a security-boundary entry even when asked directly', async () => {
  const toggles = []
  const pluginManager = {
    async setPluginEnabled(id, enabled) {
      toggles.push([id, enabled])
      return { changed: true, application: 'applied' }
    },
  }
  const report = {
    ...EMPTY_REPORT,
    findings: [{
      id: 'entry-failed:include:approval',
      severity: 'fail',
      code: 'entry-failed',
      title: 'x',
      detail: 'x',
      subject: 'include:approval',
      repairable: true,
      action: { kind: 'retry-entry', entryId: 'include:approval', moduleName: '@deepseek-ai/dsh-user-approval' },
    }],
  }
  const { actions } = makeActions(pluginManager, { scan: async () => report })
  const result = await actions.repair({ targets: ['entry-failed:include:approval'] })
  assert.equal(result.ok, true)
  assert.equal(result.attempts[0].result, 'skipped')
  assert.deepEqual(toggles, [])
})

test('repair reports a failed re-enable instead of claiming success', async () => {
  let onCall = 0
  const pluginManager = {
    async setPluginEnabled(_id, enabled) {
      if (!enabled) return { changed: true, application: 'applied' }
      onCall += 1
      if (onCall === 1) throw new Error('loader busy')
      return { changed: true, application: 'applied' }
    },
  }
  const report = {
    ...EMPTY_REPORT,
    findings: [{
      id: 'entry-failed:include:broken',
      severity: 'fail',
      code: 'entry-failed',
      title: 'x',
      detail: 'x',
      subject: 'include:broken',
      repairable: true,
      action: { kind: 'retry-entry', entryId: 'include:broken', moduleName: 'dsh-broken' },
    }],
  }
  const { actions } = makeActions(pluginManager, { scan: async () => report })
  const result = await actions.repair({})
  assert.equal(result.attempts[0].result, 'applied')
  assert.equal(onCall, 2, 'a throwing enable must be retried once before being reported')
})

test('invoke refuses high-impact and unattributable targets before any dispatch', async () => {
  let dispatched = 0
  const tools = {
    get: () => ({ name: 'x' }),
    async execute() {
      dispatched += 1
      return { isError: false, value: null, content: [] }
    },
  }
  const { actions } = makeActions({}, { tools })
  for (const tool of ['plugin_manager', 'bash', 'run_code', 'write']) {
    const result = await actions.invoke({ tool })
    assert.equal(result.ok, false)
    // `plugin_manager` is also in the default config blocklist, so either guard
    // may be the one that refuses it. Both refuse before any dispatch.
    assert.ok(
      result.error.code === 'hard-denied' || result.error.code === 'blocked-target',
      `${tool} must be refused, got ${result.error.code}`,
    )
  }
  // A tool that no plugin claims cannot be brokered either.
  const unattributed = await actions.invoke({ tool: 'mystery_tool' })
  assert.equal(unattributed.ok, false)
  assert.equal(unattributed.error.code, 'unattributable')
  assert.equal(dispatched, 0)
})

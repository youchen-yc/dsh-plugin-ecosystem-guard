/**
 * 安全不变量测试（规则 A-03 / A-05 / A-08 / E-01 / E-02 / E-03 / E-05 / E-06 / D-06 / F-01）。
 *
 * 只测"判定层"与"静态事实"，不需要启动 Host：
 *   - 入口白名单：未登记的名字一律拒绝（默认拒绝）
 *   - 破坏性 RPC 必须带 confirmed
 *   - 硬拒绝名单 / 安全边界模块 / 文本清洗 / 完整性失败关闭
 *   - 运行时源码里不得出现的危险 API（eval / new Function / child_process / 网络 / innerHTML）
 *   - 零运行时依赖（供应链最小面）
 *
 *   node --test plugin-guard/test/security.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RPC_METHODS,
  RPC_REQUIRE_CONFIRMATION,
  TOOL_ACTIONS,
  isKnownAction,
  isKnownRpcMethod,
  rpcNeedsConfirmation,
} from '../lib/policy.js'
import {
  DEFAULTS,
  analyzeInstall,
  buildScan,
  isInvokeDenied,
  isProtectedModule,
  sanitizeText,
} from '../lib/doctor.js'
import { isBlocked, verifyIntegrity } from '../lib/integrity.js'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Runtime files that must never contain the dangerous APIs below. */
const RUNTIME_FILES = ['index.js', 'client.js', 'lib/actions.js', 'lib/doctor.js', 'lib/integrity.js', 'lib/policy.js', 'lib/client-rpc.js']

test('A-03 默认拒绝：未登记的 action / RPC 方法一律不通过', () => {
  assert.equal(isKnownAction('scan'), true)
  assert.equal(isKnownAction('delete-everything'), false)
  assert.equal(isKnownAction(''), false)
  assert.equal(isKnownAction(undefined), false)
  assert.equal(isKnownAction('SCAN'), false, '大小写不同也必须拒绝（不做模糊匹配）')

  assert.equal(isKnownRpcMethod('guard.scan'), true)
  assert.equal(isKnownRpcMethod('guard.drop-database'), false)
  assert.equal(isKnownRpcMethod(undefined), false)

  // 白名单本身不能被意外清空
  assert.ok(TOOL_ACTIONS.length >= 8)
  assert.ok(RPC_METHODS.length >= 7)
})

test('A-08 权限分离：破坏性 RPC 必须带用户确认，只读方法不需要', () => {
  for (const method of ['guard.repair', 'guard.reset', 'guard.upgrade', 'guard.debug']) {
    assert.equal(rpcNeedsConfirmation(method), true, `${method} 必须要求确认`)
  }
  for (const method of ['guard.status', 'guard.scan', 'guard.capabilities']) {
    assert.equal(rpcNeedsConfirmation(method), false, `${method} 是只读，不应要求确认`)
  }
  for (const method of RPC_REQUIRE_CONFIRMATION) {
    assert.ok(RPC_METHODS.includes(method), `${method} 必须在 RPC 白名单内`)
  }
})

test('E-01 白名单优先 + 硬拒绝名单：高危工具永不被代调用', () => {
  for (const name of ['plugin_manager', 'plugin_market', 'run_code', 'bash', 'pwsh', 'write', 'edit', 'delete', 'move', 'cordis_run', 'terminal_send']) {
    assert.equal(isInvokeDenied(name), true, `${name} 必须硬拒绝`)
  }
  for (const name of ['mover_move_session', 'workspace_heal']) {
    assert.equal(isInvokeDenied(name), false)
  }
})

test('A-04/A-08 安全边界模块：只报不动，reset 也要拒绝', () => {
  for (const name of ['@deepseek-ai/dsh-user-approval', '@deepseek-ai/dsh-permission-presets', 'dsh-sandbox-local', 'dsh-credentials-local', '@deepseek-ai/dsh-authorization']) {
    assert.equal(isProtectedModule(name), true, `${name} 必须受保护`)
  }
  assert.equal(isProtectedModule('dsh-plugin-ecosystem-guard'), false)

  const report = buildScan({
    plugins: [{ entryId: 'e1', moduleName: '@deepseek-ai/dsh-user-approval', enabled: true, fiberPhase: 'failed', meta: { title: 'approval' } }],
    bundles: [],
    tools: [],
    services: { pluginManager: true, tools: true, userQuestions: true, connection: true },
    config: DEFAULTS,
  })
  const finding = report.findings.find((item) => item.subject === 'e1')
  assert.equal(finding.repairable, false, '安全边界模块即使加载失败也不能标记为可自动修复')
  assert.equal(finding.action, null)
})

test('A-05/E-02 不可信文本：控制字符被清除、长度有界、不当作指令', () => {
  const hostile = 'a\nb\u0000\u001b[31m' + 'x'.repeat(500)
  const safe = sanitizeText(hostile, 40)
  assert.equal(safe.includes('\n'), false)
  assert.equal(safe.includes('\u0000'), false)
  assert.equal(safe.includes('\u001b'), false)
  assert.ok(safe.length <= 41)
})

test('D-06 密码学失败关闭：篡改/坏清单/伪造摘要都阻断', () => {
  const base = verifyIntegrity({
    expected: { algorithm: 'sha256', files: { 'index.js': 'a'.repeat(64) } },
    read: () => Buffer.from('tampered'),
  })
  assert.equal(base.status, 'mismatch')
  assert.equal(isBlocked(base), true)

  for (const manifest of [
    { algorithm: 'md5', files: { 'index.js': 'a'.repeat(64) } },
    { algorithm: 'sha256', files: { '../escape.js': 'a'.repeat(64) } },
    { algorithm: 'sha256', files: { '/etc/passwd': 'a'.repeat(64) } },
    { algorithm: 'sha256', files: { 'index.js': 'zz' } },
    { algorithm: 'sha256', files: {} },
  ]) {
    const state = verifyIntegrity({ expected: manifest, read: () => Buffer.from('x') })
    assert.equal(state.status, 'invalid-manifest')
    assert.equal(isBlocked(state), true, '非法清单必须阻断而不是放行')
  }
})

test('E-06 业务判定在 Host：预检的阻断结论不依赖调用方声明', () => {
  const analysis = analyzeInstall({
    spec: '/tmp/very-old-plugin',
    inspection: { status: 'accepted', kind: 'path', name: 'very-old-plugin', version: '9.0.0', bundle: true },
    bundles: [{ name: '@deepseek-ai/dsh-base', version: '0.2.1-rc.3', official: true, availability: 'installation' }],
    plugins: [],
    tools: [],
    localManifest: JSON.stringify({ name: 'very-old-plugin', engines: { dsh: '>=9.0.0' } }),
    config: DEFAULTS,
  })
  assert.equal(analysis.verdict, 'block')
  assert.equal(analysis.conflicts[0].code, 'incompatible-system')
})

test('V10 运行时源码无危险 API（无 eval / new Function / 子进程 / 网络 / innerHTML）', () => {
  const forbidden = [
    { pattern: /\beval\s*\(/, why: 'eval' },
    { pattern: /new\s+Function\s*\(/, why: 'new Function' },
    { pattern: /child_process/, why: 'child_process' },
    { pattern: /\bfetch\s*\(/, why: '网络 fetch' },
    { pattern: /require\(['"]https?/, why: 'http 模块' },
    { pattern: /dangerouslySetInnerHTML/, why: 'dangerouslySetInnerHTML' },
    { pattern: /\.innerHTML\s*=/, why: 'innerHTML 赋值' },
    { pattern: /document\s*\.\s*write\s*\(/, why: 'document.write' },
  ]
  for (const file of RUNTIME_FILES) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const rule of forbidden) {
      assert.equal(rule.pattern.test(source), false, `${file} 不得包含 ${rule.why}`)
    }
  }
})

test('E-03 不存在把变量拼进查询/选择器的写法', () => {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  assert.equal(/querySelector\(\s*'[^']*'\s*\+/.test(client), false, 'selector 不得字符串拼接')
  assert.equal(/querySelector\(\s*`[^`]*\$\{/.test(client), false, 'selector 不得模板拼接')
})

test('F-01/J-03 零运行时依赖：没有浮动依赖可漂移', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.dependencies === undefined, true, '不得声明运行时依赖')
  assert.equal(pkg.private === undefined, true, '可发布包不应标记 private')
  assert.equal(typeof pkg.version, 'string')
})

test('J-02 分发包不携带本机绝对路径（源码目录检查）', () => {
  // 模式由片段拼出：这个检查文件本身也不能含"本机路径"字样，否则会被它实现的扫描命中。
  const users = ['U', 's', 'e', 'r', 's'].join('')
  const winHome = new RegExp(`[A-Za-z]:\\\\{1,2}${users}\\\\`, 'i')
  const posixHome = new RegExp(`/${users.toLowerCase()}/`, 'i')
  const offenders = []
  const scan = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.name === 'dist' || name.name === 'node_modules' || name.name === '.git') continue
      const path = join(dir, name.name)
      if (name.isDirectory()) {
        scan(path)
        continue
      }
      if (!/\.(js|mjs|json|yml|md|cmd|ps1)$/.test(name.name)) continue
      if (name.name === 'security.test.mjs') continue
      const text = readFileSync(path, 'utf8')
      if (winHome.test(text) || posixHome.test(text)) {
        offenders.push(path.slice(root.length + 1))
      }
    }
  }
  scan(root)
  assert.deepEqual(offenders, [], `以下文件包含本机绝对路径：${offenders.join(', ')}`)
})

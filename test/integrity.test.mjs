/**
 * Integrity check tests.
 *
 * The guarantee under test is narrow and honest: a packaged release carries a
 * manifest, a modified or missing runtime file is detected, and the detection
 * only ever stops *this* plugin. There is no test for "impossible to bypass" —
 * that property does not exist for JavaScript a Host must load from disk.
 *
 *   node --test plugin-guard/test/integrity.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MANIFEST_NAME,
  checkIntegritySync,
  hashBuffer,
  isBlocked,
  verifyIntegrity,
} from '../lib/integrity.js'

function makePackage(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ecosystem-guard-integrity-'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  const manifest = {
    name: 'dsh-plugin-ecosystem-guard',
    version: '1.0.0',
    algorithm: 'sha256',
    files: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, hashBuffer(Buffer.from(content))]),
    ),
  }
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(manifest))
  return dir
}

test('an intact package verifies and is not blocked', () => {
  const dir = makePackage({ 'index.js': 'export function apply() {}\n', 'lib/doctor.js': 'export const x = 1\n' })
  try {
    const state = checkIntegritySync(dir)
    assert.equal(state.status, 'ok')
    assert.equal(state.files, 2)
    assert.equal(isBlocked(state), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a modified file is detected and blocks work', () => {
  const dir = makePackage({ 'index.js': 'export function apply() {}\n' })
  try {
    writeFileSync(join(dir, 'index.js'), 'export function apply() { /* tampered */ }\n')
    const state = checkIntegritySync(dir)
    assert.equal(state.status, 'mismatch')
    assert.deepEqual(state.mismatched, ['index.js'])
    assert.equal(isBlocked(state), true)
    assert.match(state.detail, /内容被改动/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing file is detected, not silently accepted', () => {
  const dir = makePackage({ 'index.js': 'a', 'lib/doctor.js': 'b' })
  try {
    rmSync(join(dir, 'lib/doctor.js'))
    const state = checkIntegritySync(dir)
    assert.equal(state.status, 'mismatch')
    assert.deepEqual(state.missing, ['lib/doctor.js'])
    assert.equal(isBlocked(state), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a development checkout without a manifest is not blocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosystem-guard-integrity-'))
  try {
    writeFileSync(join(dir, 'index.js'), 'export function apply() {}\n')
    const state = checkIntegritySync(dir)
    assert.equal(state.status, 'unmanifested')
    assert.equal(isBlocked(state), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a hostile manifest is rejected instead of read', () => {
  const read = () => Buffer.from('whatever')
  for (const manifest of [
    { algorithm: 'md5', files: { 'index.js': 'a'.repeat(64) } },
    { algorithm: 'sha256', files: { '../outside.js': 'a'.repeat(64) } },
    { algorithm: 'sha256', files: { '/etc/passwd': 'a'.repeat(64) } },
    { algorithm: 'sha256', files: { 'index.js': 'not-a-digest' } },
    { algorithm: 'sha256', files: {} },
    { algorithm: 'sha256' },
  ]) {
    const state = verifyIntegrity({ expected: manifest, read })
    assert.equal(state.status, 'invalid-manifest', JSON.stringify(manifest))
    assert.equal(isBlocked(state), true)
  }
})

test('a corrupt manifest file is reported, never treated as intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ecosystem-guard-integrity-'))
  try {
    writeFileSync(join(dir, MANIFEST_NAME), '{ not json')
    const state = checkIntegritySync(dir)
    assert.equal(state.status, 'invalid-manifest')
    assert.equal(isBlocked(state), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Core-file integrity check.
 *
 * What this is: a build-time manifest of SHA-256 digests over the files this
 * package actually ships, published inside the tarball as `integrity.json`, and
 * verified on activation. If any listed file differs, the plugin stops doing
 * useful work and reports why.
 *
 * What this is NOT: encryption, or a way to stop someone from reading the
 * source. A DSH plugin is JavaScript that the Host process must load from the
 * user's own disk; any key needed to "decrypt" it would have to ship beside it.
 * Anyone who can edit these files can also delete this check. So the honest
 * guarantee is *tamper-evident and fail-closed for itself*, never
 * "tamper-proof" — and it never touches anybody else's files.
 *
 * A development checkout (installed by path) has no manifest and reports
 * `unmanifested`, which is treated as normal operation.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MANIFEST_NAME = 'integrity.json'
export const ALGORITHM = 'sha256'

/** Digest one file's bytes. */
export function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Manifest paths must be plain, relative, inside-package paths. */
function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  const segments = value.split(/[\\/]+/)
  return segments.every((segment) => segment && segment !== '.' && segment !== '..')
}

/**
 * Verify a manifest against a reader.
 *
 * @param {object} input
 * @param {unknown} input.expected  parsed manifest, or null/undefined when absent
 * @param {(relativePath: string) => (Buffer | string | null)} input.read reader; null = unreadable
 * @returns {{status:'ok'|'unmanifested'|'invalid-manifest'|'mismatch', name?:string, version?:string, files:number, mismatched:string[], missing:string[], detail:string}}
 */
export function verifyIntegrity({ expected, read }) {
  const unmanifested = {
    status: 'unmanifested',
    files: 0,
    mismatched: [],
    missing: [],
    detail: '没有 integrity.json（开发目录安装或旧版本包），跳过完整性校验',
  }
  if (expected === null || expected === undefined) return unmanifested

  const invalid = (reason) => ({
    status: 'invalid-manifest',
    files: 0,
    mismatched: [],
    missing: [],
    detail: `integrity.json 不可用：${reason}`,
  })

  if (typeof expected !== 'object' || Array.isArray(expected)) return invalid('不是对象')
  const manifest = expected
  if (manifest.algorithm !== ALGORITHM) return invalid(`algorithm 必须是 ${ALGORITHM}`)
  const files = manifest.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) return invalid('files 缺失')
  const entries = Object.entries(files)
  if (entries.length === 0) return invalid('files 为空')
  if (entries.length > 500) return invalid('files 条目过多')
  for (const [relativePath, digest] of entries) {
    if (!isSafeRelativePath(relativePath)) return invalid(`路径不安全：${String(relativePath)}`)
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      return invalid(`摘要格式不对：${relativePath}`)
    }
  }

  const mismatched = []
  const missing = []
  for (const [relativePath, digest] of entries) {
    let content = null
    try {
      content = read(relativePath)
    } catch {
      content = null
    }
    if (content === null || content === undefined) {
      missing.push(relativePath)
      continue
    }
    if (hashBuffer(content) !== digest) mismatched.push(relativePath)
  }

  const status = mismatched.length || missing.length ? 'mismatch' : 'ok'
  const parts = []
  if (mismatched.length) parts.push(`内容被改动：${mismatched.slice(0, 8).join(', ')}${mismatched.length > 8 ? ` 等 ${mismatched.length} 个` : ''}`)
  if (missing.length) parts.push(`文件缺失：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` 等 ${missing.length} 个` : ''}`)
  return {
    status,
    name: typeof manifest.name === 'string' ? manifest.name : undefined,
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    files: entries.length,
    mismatched,
    missing,
    detail: status === 'ok'
      ? `${entries.length} 个核心文件摘要一致（${String(manifest.name || '')}@${String(manifest.version || '')}）`
      : parts.join(' · '),
  }
}

/**
 * Read `integrity.json` from a package root and verify it, synchronously.
 *
 * @param {string} rootDir package root directory
 * @returns {ReturnType<typeof verifyIntegrity>}
 */
export function checkIntegritySync(rootDir) {
  const manifestPath = join(rootDir, MANIFEST_NAME)
  let expected = null
  try {
    expected = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return verifyIntegrity({ expected: null, read: () => null })
    return {
      status: 'invalid-manifest',
      files: 0,
      mismatched: [],
      missing: [],
      detail: `integrity.json 无法读取：${String(error && error.message ? error.message : error)}`,
    }
  }
  const read = (relativePath) => {
    try {
      return readFileSync(join(rootDir, relativePath))
    } catch {
      return null
    }
  }
  return verifyIntegrity({ expected, read })
}

/** True when the plugin must not perform any real work. */
export function isBlocked(state) {
  return Boolean(state) && (state.status === 'mismatch' || state.status === 'invalid-manifest')
}

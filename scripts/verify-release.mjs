/**
 * 复核发布产物：SHA-256 + Ed25519 分离签名。
 *
 * 规则 F-03。任何人不信任维护者也应能独立验证：
 *   node scripts/verify-release.mjs <artifact> <artifact>.sig docs/security/release-signing.pub.pem
 */

import { createPublicKey, createHash, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [artifactPath, sigPath, pubPath] = process.argv.slice(2)
if (!artifactPath || !sigPath || !pubPath) {
  console.error('usage: node scripts/verify-release.mjs <artifact> <signature.json> <public-key.pem>')
  process.exit(2)
}

const bytes = readFileSync(artifactPath)
const envelope = JSON.parse(readFileSync(sigPath, 'utf8'))
const publicKey = createPublicKey(readFileSync(pubPath, 'utf8'))

const sha256 = createHash('sha256').update(bytes).digest('hex')
const digestOk = typeof envelope.sha256 === 'string' && envelope.sha256 === sha256
const signatureOk = verify(null, bytes, publicKey, Buffer.from(String(envelope.signature || ''), 'base64'))

console.log(`artifact : ${artifactPath}`)
console.log(`sha256   : ${sha256}`)
console.log(`digest   : ${digestOk ? 'match' : 'MISMATCH'}`)
console.log(`signature: ${signatureOk ? 'valid' : 'INVALID'}`)

if (!digestOk || !signatureOk) {
  console.error('verification FAILED')
  process.exit(1)
}
console.log('verification OK')

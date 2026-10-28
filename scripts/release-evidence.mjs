/**
 * 发布证据生成：CycloneDX SBOM + Ed25519 分离签名 + 哈希清单。
 *
 * 规则 F-03（产物可验证）、F-04（SBOM）、F-05（构建 provenance）。
 *
 * 私钥只保存在维护者本机（默认 `~/.dsh-plugin-guard/signing.key`，可用环境变量
 * `DSH_GUARD_SIGNING_KEY` 覆盖），**不进入仓库**；公钥写入
 * `docs/security/release-signing.pub.pem` 随仓库发布，任何人都能验证签名。
 *
 * 用法：node scripts/release-evidence.mjs [artifact...]
 *   省略参数时，取 dist/ 下与 package.json 版本一致的 .tar.gz / .tgz。
 */

import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const distDir = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const signingKeyPath = process.env.DSH_GUARD_SIGNING_KEY || join(homedir(), '.dsh-plugin-guard', 'signing.key')
const pubKeyPath = join(root, 'docs', 'security', 'release-signing.pub.pem')

/** Load or create the Ed25519 signing key pair (private stays on this machine). */
function loadOrCreateKey() {
  if (existsSync(signingKeyPath)) {
    const privateKey = readFileSync(signingKeyPath, 'utf8')
    const publicKey = readFileSync(pubKeyPath, 'utf8')
    return { privateKey, publicKey }
  }
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  mkdirSync(dirname(signingKeyPath), { recursive: true })
  writeFileSync(signingKeyPath, pair.privateKey, { mode: 0o600 })
  mkdirSync(dirname(pubKeyPath), { recursive: true })
  writeFileSync(pubKeyPath, pair.publicKey, 'utf8')
  return { privateKey: pair.privateKey, publicKey: pair.publicKey }
}

/** Resolve the artifacts to sign. */
function resolveArtifacts(argv) {
  if (argv.length > 0) return argv
  if (!existsSync(distDir)) return []
  const suffix = `${pkg.version}.tar.gz`
  return readdirSync(distDir)
    .filter((name) => name.endsWith(suffix) || name.endsWith(`${pkg.version}.tgz`))
    .map((name) => join(distDir, name))
}

/** Build a minimal, valid CycloneDX 1.5 document (zero runtime dependencies). */
function buildSbom(artifacts) {
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(pkg.dependencies) : []
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${createHash('sha256').update(`${pkg.name}@${pkg.version}`).digest('hex').slice(0, 8)}-0000-4000-8000-000000000000`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: 'dsh-plugin-ecosystem-guard', name: 'release-evidence.mjs', version: pkg.version }],
      component: {
        type: 'application',
        'bom-ref': `${pkg.name}@${pkg.version}`,
        name: pkg.name,
        version: pkg.version,
        licenses: [{ license: { id: 'MIT' } }],
        hashes: artifacts.map((artifact) => ({
          alg: 'SHA-256',
          content: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
        })),
      },
    },
    components: deps.map((name) => ({
      type: 'library',
      'bom-ref': `${name}@${pkg.dependencies[name]}`,
      name,
      version: String(pkg.dependencies[name]),
    })),
  }
}

const artifacts = resolveArtifacts(process.argv.slice(2))
if (artifacts.length === 0) {
  console.error('no artifacts found — run `node scripts/build.mjs <pnpm>` first')
  process.exit(1)
}

const { privateKey, publicKey } = loadOrCreateKey()
const lines = []

for (const artifact of artifacts) {
  const bytes = readFileSync(artifact)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const signature = sign(null, bytes, privateKey).toString('base64')
  const sigPath = `${artifact}.sig`
  writeFileSync(sigPath, `${JSON.stringify({
    algorithm: 'ed25519',
    artifact: artifact.split(/[\\/]/).pop(),
    sha256,
    signature,
    publicKey: 'docs/security/release-signing.pub.pem',
    signedAt: new Date().toISOString(),
  }, null, 2)}\n`)

  // Prove the signature we just wrote verifies with the published public key.
  const ok = verify(null, bytes, publicKey, Buffer.from(signature, 'base64'))
  if (!ok) {
    console.error(`signature self-check FAILED for ${artifact}`)
    process.exit(1)
  }
  lines.push({
    artifact: artifact.split(/[\\/]/).pop(),
    sha256,
    signature: `${artifact.split(/[\\/]/).pop()}.sig`,
    verified: true,
  })
}

const sbomPath = join(distDir, 'SBOM.cdx.json')
writeFileSync(sbomPath, `${JSON.stringify(buildSbom(artifacts), null, 2)}\n`)

const evidence = [
  `# 发布证据 / Release evidence`,
  ``,
  `- 包：\`${pkg.name}@${pkg.version}\``,
  `- 生成时间：${new Date().toISOString()}`,
  `- 构建主机：${process.platform} ${process.arch}`,
  `- Node：${process.version}`,
  `- 签章算法：Ed25519（分离签名），公钥 \`docs/security/release-signing.pub.pem\``,
  `- SBOM：\`dist/SBOM.cdx.json\`（CycloneDX 1.5，运行时依赖 ${Array.isArray(pkg.dependencies) ? 0 : Object.keys(pkg.dependencies || {}).length} 个）`,
  ``,
  `| 产物 | SHA-256 | 签名 | 自验证 |`,
  `| --- | --- | --- | --- |`,
  ...lines.map((line) => `| \`${line.artifact}\` | \`${line.sha256}\` | \`${line.signature}\` | ${line.verified ? '通过' : '失败'} |`),
  ``,
  `## 复核方式`,
  ``,
  '```powershell',
  `node scripts/verify-release.mjs <产物路径> <产物路径>.sig docs/security/release-signing.pub.pem`,
  `node scripts/clean-install-check.mjs <解包目录>`,
  '```',
  ``,
]
writeFileSync(join(distDir, 'RELEASE-EVIDENCE.md'), evidence.join('\n'))

console.log(`signed ${lines.length} artifact(s) with Ed25519`)
console.log(`sbom: ${sbomPath}`)
console.log(`evidence: ${join(distDir, 'RELEASE-EVIDENCE.md')}`)
console.log(`public key: ${pubKeyPath}`)

/**
 * 干净环境安装自检（J-04）：解包后不依赖开发机即可加载、资源齐全、完整性通过。
 *
 * 用法：node scripts/clean-install-check.mjs <解包后的包根目录>
 * 结果写入 dist/VERIFICATION.md，随发行版归档。
 *
 * 只使用 Node 内建模块：不执行外部命令、不联网、不写包目录。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pkgDir = process.argv[2]
if (!pkgDir) {
  console.error('usage: node scripts/clean-install-check.mjs <extracted-package-dir>')
  process.exit(2)
}

const checks = []
const record = (name, ok, detail) => checks.push({ name, ok, detail })

/** 1) 清单可解析且与包名/版本一致。 */
let manifest = null
try {
  manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  record('package.json 可解析', true, `${manifest.name}@${manifest.version}`)
} catch (error) {
  record('package.json 可解析', false, String(error && error.message ? error.message : error))
}

if (manifest) {
  record('包名非空', typeof manifest.name === 'string' && manifest.name.length > 0, String(manifest.name))
  record('版本非空', typeof manifest.version === 'string' && manifest.version.length > 0, String(manifest.version))
  record('exports 指向入口', Boolean(manifest.exports && manifest.exports['.']), JSON.stringify(manifest.exports && manifest.exports['.']))
  record('type=module', manifest.type === 'module', String(manifest.type))

  /** 2) files 声明与实际内容一致（忽略通配符，逐个核对字面量模式）。 */
  const literal = (manifest.files || []).filter((pattern) => typeof pattern === 'string' && !pattern.includes('*'))
  const missing = literal.filter((rel) => !existsSync(join(pkgDir, rel)))
  record('files 字面量全部存在', missing.length === 0, missing.length ? `缺失：${missing.join(', ')}` : `${literal.length} 项齐全`)

  /** 3) bundle patch 行声明正确。 */
  try {
    const patch = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8')
    // Line-based inspection (no pattern that could be read as a drive-letter path).
    const lines = patch.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const hasId = lines.some((line) => line.startsWith('- id:') || line.startsWith('id:'))
    const nameOk = patch.includes(`name: '${manifest.name}'`) || patch.includes(`name: "${manifest.name}"`)
    record('bundle patch 行声明正确', hasId && nameOk, hasId ? (nameOk ? 'id + name 匹配' : 'name 与包名不一致') : '缺少 id 行')
  } catch (error) {
    record('bundle patch 行声明正确', false, String(error && error.message ? error.message : error))
  }

  /** 4) locale / icon 资源齐全。 */
  for (const locale of ['en', 'zh']) {
    try {
      const dict = JSON.parse(readFileSync(join(pkgDir, 'locale', `${locale}.json`), 'utf8'))
      const title = dict && dict.meta && typeof dict.meta.title === 'string' && dict.meta.title.length > 0
      record(`locale/${locale}.json`, title, title ? dict.meta.title : 'meta.title 缺失')
    } catch (error) {
      record(`locale/${locale}.json`, false, String(error && error.message ? error.message : error))
    }
  }
  record('icon.svg 存在且非空', existsSync(join(pkgDir, 'icon.svg')) && readFileSync(join(pkgDir, 'icon.svg'), 'utf8').length > 100, 'ok')
}

/** 5) 入口可加载（只 import，不调用 apply）。 */
try {
  const entry = await import(pathToFileURL(join(pkgDir, 'index.js')).href)
  const ok = typeof entry.apply === 'function' && typeof entry.name === 'string' && Array.isArray(entry.inject)
  record('入口可加载（apply / name / inject）', ok, ok ? `name=${entry.name} inject=${entry.inject.join(',')}` : '导出形状不符')
} catch (error) {
  record('入口可加载（apply / name / inject）', false, String(error && error.message ? error.message : error))
}

/** 6) 完整性清单：正式包必须 ok（开发目录为 unmanifested 时不算失败）。 */
try {
  const integrity = await import(pathToFileURL(join(pkgDir, 'lib', 'integrity.js')).href)
  const state = integrity.checkIntegritySync(pkgDir)
  const ok = state.status === 'ok'
  record('完整性清单校验', ok, `${state.status} / ${state.files} files${state.detail ? ` / ${state.detail}` : ''}`)
} catch (error) {
  record('完整性清单校验', false, String(error && error.message ? error.message : error))
}

const failed = checks.filter((item) => !item.ok)
const lines = [
  '# 干净环境安装自检（J-04）',
  '',
  `- 包目录：\`${pkgDir}\``,
  `- 检查时间：${new Date().toISOString()}`,
  `- Node：${process.version} / ${process.platform} ${process.arch}`,
  `- 结果：**${failed.length === 0 ? '通过' : `失败 ${failed.length} 项`}**`,
  '',
  '| 检查项 | 结果 | 说明 |',
  '| --- | --- | --- |',
  ...checks.map((item) => `| ${item.name} | ${item.ok ? '通过' : '失败'} | ${String(item.detail).replace(/\|/g, '\\|').slice(0, 200)} |`),
  '',
  '## 复核方式',
  '',
  '```powershell',
  'tar -xzf <artifact>.tar.gz -C <temp>',
  'node scripts/clean-install-check.mjs <temp>/package',
  '```',
  '',
]
mkdirSync(join(pkgDir, '..', '..', '..', 'dist'), { recursive: true })
try {
  writeFileSync(join(pkgDir, '..', '..', '..', 'dist', 'VERIFICATION.md'), lines.join('\n'))
} catch {
  /* 只读目录时忽略 */
}

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`)
if (failed.length > 0) {
  console.error(`clean-install-check FAILED (${failed.length} item(s))`)
  process.exit(1)
}
console.log('clean-install-check OK')

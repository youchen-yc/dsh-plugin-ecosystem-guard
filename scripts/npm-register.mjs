/**
 * npm 账号注册/登录向导 —— 绕过被 Cloudflare 拦截的 www.npmjs.com 网页。
 *
 * 使用 npm 注册表自己的「legacy user」接口直接创建/登录账号，成功后把发布令牌
 * 写进 `%USERPROFILE%\.npmrc`，这样 `pnpm publish` 就能直接发布。
 *
 * 密码只在本机终端输入、不打印、不回显、不写入任何日志。
 *
 * 用法：双击 `_toolchain\npm-register.cmd`，或
 *   node scripts/npm-register.mjs
 */

import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REGISTRY = 'https://registry.npmjs.org'
const NPMRC = join(homedir(), '.npmrc')

const c = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  green: '\u001b[32m', red: '\u001b[31m', yellow: '\u001b[33m', cyan: '\u001b[36m',
}

function say(text = '') {
  process.stdout.write(`${text}\n`)
}

/** 读一行普通输入。 */
function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())))
}

/** 读密码：逐字符读取并回显 `*`，回车结束。 */
function askPassword(question) {
  return new Promise((resolve) => {
    process.stdout.write(question)
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode?.(wasRaw ?? false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') { // Ctrl+C
          stdin.setRawMode?.(wasRaw ?? false)
          stdin.pause()
          process.stdout.write('\n')
          process.exit(1)
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        value += char
        process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

/** 用 legacy user 接口创建账号或登录，返回 token。 */
async function authenticate({ username, email, password }) {
  const body = {
    _id: `org.couchdb.user:${username}`,
    name: username,
    password,
    email,
    type: 'user',
    roles: [],
    date: new Date().toISOString(),
  }
  const response = await fetch(`${REGISTRY}/-/user/org.couchdb.user:${encodeURIComponent(username)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {
    payload = null
  }
  return { status: response.status, payload, text }
}

function writeNpmrc(token) {
  const line = `//registry.npmjs.org/:_authToken=${token}`
  let current = ''
  if (existsSync(NPMRC)) {
    current = readFileSync(NPMRC, 'utf8')
    const kept = current
      .split(/\r?\n/)
      .filter((row) => row.trim() && !/^\/\/registry\.npmjs\.org\/:_authToken=/.test(row.trim()))
    current = kept.join('\n')
  }
  const next = `${current ? `${current}\n` : ''}${line}\n`
  writeFileSync(NPMRC, next, 'utf8')
}

async function main() {
  say()
  say(`${c.bold}npm 账号注册 / 登录向导${c.reset}`)
  say(`${c.dim}直接调用 npm 注册表接口，不走被拦截的 www.npmjs.com 网页。${c.reset}`)
  say(`${c.dim}密码只在本机输入，不打印、不外传、不写日志。${c.reset}`)
  say()

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const username = await ask(rl, 'npm 用户名（小写英文/数字，建议 youchen-yc）: ')
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
    say(`${c.red}用户名不合法：只能小写字母、数字、点、下划线、短横线，3-64 位，且以小写字母或数字开头。${c.reset}`)
    rl.close()
    return
  }
  const email = await ask(rl, '邮箱: ')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    say(`${c.red}邮箱格式不对。${c.reset}`)
    rl.close()
    return
  }
  rl.close()

  const password = await askPassword('密码（输入时不显示，至少 8 位）: ')
  if (password.length < 8) {
    say(`${c.red}密码至少 8 位。${c.reset}`)
    return
  }

  say()
  say(`${c.cyan}正在连接 registry.npmjs.org …${c.reset}`)
  let result
  try {
    result = await authenticate({ username, email, password })
  } catch (error) {
    say(`${c.red}连接失败：${error && error.message ? error.message : error}${c.reset}`)
    say(`${c.yellow}请检查网络（本机访问 registry.npmjs.org 正常时才能继续）。${c.reset}`)
    return
  }

  if ((result.status === 200 || result.status === 201) && result.payload && result.payload.token) {
    writeNpmrc(result.payload.token)
    say()
    say(`${c.green}✔ 成功！账号 ${username} 已可用，发布令牌已写入：${c.reset}`)
    say(`  ${NPMRC}`)
    say()
    say(`${c.bold}下一步：回到对话里说一句「注册好了」，我执行 pnpm publish。${c.reset}`)
    if (result.status === 201) {
      say(`${c.dim}（若 npm 要求验证邮箱，请去邮箱点验证链接；未验证可能无法发布。）${c.reset}`)
    }
    return
  }

  if (result.status === 409) {
    say(`${c.red}用户名已被占用：${username}${c.reset}`)
    say('换一个用户名重新运行本向导。')
    return
  }
  if (result.status === 401 || result.status === 403) {
    say(`${c.red}认证未通过（${result.status}）。${c.reset}`)
    say('如果这个用户名已存在，说明密码不对；如果还没账号，换个用户名再试。')
    if (result.payload && result.payload.error) say(`${c.dim}${result.payload.error}${c.reset}`)
    return
  }
  say(`${c.red}失败（HTTP ${result.status}）${c.reset}`)
  say(`${c.dim}${String(result.text).slice(0, 400)}${c.reset}`)
}

main().catch((error) => {
  say(`${c.red}未预期的错误：${error && error.message ? error.message : error}${c.reset}`)
  process.exitCode = 1
})

/**
 * 安全策略白名单（单一事实源）
 *
 * 规则 A-03（默认拒绝）/ E-01（白名单优先）。
 *
 * 这里是本插件唯一的入口白名单：agent 工具的 action、Connection RPC 的方法、
 * 以及哪些 RPC 方法属于"破坏性、必须用户确认"。
 *
 * index.js 只从本模块取判定结果；任何未登记的名字一律被拒绝。
 * 新增入口必须同时改本文件 + test/security.test.mjs（未知值拒绝用例）
 * + docs/security/trust-boundary.md。
 */

/** agent 工具 `plugin_guard` 允许的 action。 */
export const TOOL_ACTIONS = Object.freeze([
  'scan',
  'check-install',
  'capabilities',
  'invoke',
  'repair',
  'reset',
  'upgrade',
  'debug',
])

/** 设置页可通过 Connection RPC 调用的方法。 */
export const RPC_METHODS = Object.freeze([
  'guard.status',
  'guard.scan',
  'guard.capabilities',
  'guard.repair',
  'guard.reset',
  'guard.upgrade',
  'guard.debug',
])

/** 这些 RPC 方法必须在请求里带 confirmed:true（用户在页面上两步确认过）。 */
export const RPC_REQUIRE_CONFIRMATION = Object.freeze([
  'guard.repair',
  'guard.reset',
  'guard.upgrade',
  'guard.debug',
])

/**
 * 工具 action 是否在白名单内。
 * @param {unknown} name
 * @returns {boolean}
 */
export function isKnownAction(name) {
  return typeof name === 'string' && TOOL_ACTIONS.includes(name)
}

/**
 * RPC 方法是否在白名单内。
 * @param {unknown} name
 * @returns {boolean}
 */
export function isKnownRpcMethod(name) {
  return typeof name === 'string' && RPC_METHODS.includes(name)
}

/**
 * 该方法是否必须先拿到用户确认。
 * @param {unknown} name
 * @returns {boolean}
 */
export function rpcNeedsConfirmation(name) {
  return typeof name === 'string' && RPC_REQUIRE_CONFIRMATION.includes(name)
}

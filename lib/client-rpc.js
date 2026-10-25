/**
 * dsh-plugin-ecosystem-guard — Host half of the Settings page RPC channel.
 *
 * The Settings page is a *persistent bundle* client module (plain
 * `window.__ModuleLoader__.load({ id, factory(require) })`), not a model-mounted
 * dynamic package. The dynamic-package closure symbols documented by the Client
 * `Builtin` inspect provider (`host.call(method, args)` paired with the Host
 * `harness.handle(method, fn)`) exist only inside
 * `evaluateClientHalf()` in @deepseek-ai/dsh-cordis-client-runner/lib/client.js,
 * where the closure is invoked with `["React","console","styles","host", ...]`.
 * A bundle's client module receives only `require`, so that seam is unreachable
 * from a persistent bundle.
 *
 * The supported seam on this build therefore is the private Connection RPC
 * channel, the same one the shipped/installed dsh-workspace-mover UI plugin
 * uses:
 *
 *   Host   : ctx.connection.rpc.handle(channel, handler)   (this file)
 *   Client : ctx.connection.rpc.call(channel, endpoint, payload)
 *
 * Evidence in @deepseek-ai/dsh-client-connection/lib/index.js (0.2.1-rc.3):
 *
 *   const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
 *   get rpc() {
 *     const owner = this.ctx
 *     return { handle: (channel, handler) => this.register(owner, channel, handler), ... }
 *   }
 *   register(owner, channel, handler) {
 *     assertChannel(channel)
 *     const fetchHandler = rpcFetchHandler(channel, handler)
 *     ...
 *     return owner.effect(() => owner.webServer.register(route), ...)
 *   }
 *
 * `register()` calls `owner.webServer.register`, so the Context that *reads*
 * `connection` must also resolve `webServer`. That is why this module waits for
 * the pair through `ctx.inject(['connection', 'webServer'], ...)`: on a plain
 * CLI profile neither service exists, the child fiber simply stays parked, and
 * `registerClientRpc` still returns a no-op disposer. Nothing throws.
 *
 * Wire result shape (rpc-host.js `rpcResultSchema`): every handler answers
 * `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.
 *
 * @module dsh-plugin-ecosystem-guard/lib/client-rpc
 */

/** Channel namespace shared with client.js. */
export const CHANNEL = '/ecosystem-guard'

/**
 * Optional third argument read by older Connection builds; 0.2.1-rc.3's
 * `handle(channel, handler)` ignores it (its `register()` closes over the
 * owner context), so passing it is harmless and keeps parity with the
 * installed dsh-workspace-mover plugin.
 */
const HANDLE_OPTIONS = { authority: 'loopback' }

/** Stable no-op used whenever no transport could be established. */
function noop() {}

/**
 * Narrow a cordis disposer-ish value (function or `{ dispose() }`) to a function.
 * @param value - candidate disposer.
 * @returns a callable disposer, or null.
 */
function asDisposer(value) {
  if (typeof value === 'function') return value
  if (value && typeof value.dispose === 'function') return () => value.dispose()
  return null
}

/**
 * Human-readable message of any thrown value.
 * @param error - rejected or constructed value.
 * @returns its message text.
 */
function messageOf(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Build one Connection RPC failure result.
 * @param code - stable machine code.
 * @param message - human-readable text.
 * @returns handler result.
 */
function failure(code, message) {
  return {
    ok: false,
    error: {
      code: String(code || 'internal-error'),
      message: String(message || code || 'internal-error'),
      details: {},
    },
  }
}

/**
 * Keep only JSON-representable data on the wire: the Connection envelope is
 * JSON, so `undefined`/functions would otherwise be silently dropped by the
 * transport in ways that look like a missing field on the page.
 * @param value - dispatch return value.
 * @returns a JSON clone, or null.
 * @throws when the value cannot be serialised.
 */
function toWire(value) {
  if (value === undefined) return null
  const encoded = JSON.stringify(value)
  if (encoded === undefined) return null
  return JSON.parse(encoded)
}

/**
 * Build the Connection RPC handler around the package's own dispatch table.
 * `dispatch` never throws by contract, but a defensive catch keeps a page bug
 * from becoming a 500 on the channel.
 * @param dispatch - index.js `dispatch(method, args, signal)`.
 * @returns ConnectionRpcHandler.
 */
function createHandler(dispatch) {
  return async function handle(endpoint, payload, signal) {
    if (signal && signal.aborted) return failure('cancelled', 'cancelled')
    let value
    try {
      value = await dispatch(endpoint, payload === undefined ? null : payload, signal)
    } catch (error) {
      return failure('handler-error', messageOf(error))
    }
    try {
      return { ok: true, value: toWire(value) }
    } catch (error) {
      return failure('handler-error', messageOf(error))
    }
  }
}

/**
 * Rebind the Connection service to the Context that declares `webServer`.
 *
 * The `rpc` getter reads `this.ctx` (the Context that read the service). The
 * installed dsh-workspace-mover plugin documents the same rebinding for this
 * profile family: `connection[Symbol.for('cordis.original')]` is the raw
 * service, and `[Symbol.for('cordis.extend')]({ ctx: owner })` produces a copy
 * whose owner context has `webServer` injected, so `handle()` can register the
 * channel route. Fall back to the service as-is when the internals differ.
 * @param connection - Host `connection` service.
 * @param owner - injected Context declaring `connection` and `webServer`.
 * @returns a Connection service whose `rpc.handle` is owner-safe.
 */
function scopedConnectionFor(connection, owner) {
  try {
    const original = connection[Symbol.for('cordis.original')] ?? connection
    const extend = original?.[Symbol.for('cordis.extend')]
    if (typeof extend === 'function') {
      const scoped = extend.call(original, { ctx: owner })
      if (scoped && scoped.rpc && typeof scoped.rpc.handle === 'function') return scoped
    }
  } catch {
    /* internals unavailable: fall through to the service itself */
  }
  return connection
}

/**
 * Register the Settings page's private Host channel.
 *
 * Safe on every Host shape: a Host without `connection`/`webServer` (plain CLI
 * profile, or a page-less boot) gets a no-op disposer and no thrown error. The
 * returned function is idempotent, and the channel registration itself is hung
 * on the injected child fiber, so plugin unload removes the route even when the
 * caller never invokes the disposer.
 *
 * @param ctx - Host plugin Context (the object passed to the package `apply`).
 * @param dispatch - `(method, args, signal) => Promise<json>` supplied by index.js.
 * @returns disposer; never throws.
 */
export function registerClientRpc(ctx, dispatch) {
  let disposed = false
  let disposeHandle = null
  let disposeInject = null

  /**
   * Attach the channel to one Context that resolves `connection` + `webServer`.
   * @param owner - the injected child Context.
   */
  const mount = (owner) => {
    if (disposed || disposeHandle !== null) return
    let connection
    try {
      connection = owner ? owner.connection : undefined
    } catch {
      return
    }
    if (!connection || !connection.rpc || typeof connection.rpc.handle !== 'function') return
    try {
      const scoped = scopedConnectionFor(connection, owner)
      const handle = scoped.rpc.handle(CHANNEL, createHandler(dispatch), HANDLE_OPTIONS)
      disposeHandle = asDisposer(handle) ?? noop
    } catch {
      /* channel name collision or missing web server: page degrades to "Host 通道不可用" */
      disposeHandle = null
    }
  }

  /**
   * Tear the channel down; idempotent and silent.
   */
  const dispose = () => {
    if (disposed) return
    disposed = true
    try {
      if (typeof disposeInject === 'function') disposeInject()
    } catch {
      /* disposal must never throw out of unload */
    }
    try {
      if (typeof disposeHandle === 'function') disposeHandle()
    } catch {
      /* disposal must never throw out of unload */
    }
    disposeInject = null
    disposeHandle = null
  }

  try {
    if (typeof dispatch !== 'function') return dispose

    if (ctx && typeof ctx.inject === 'function') {
      try {
        // Park silently until the web transport exists; on CLI profiles this
        // child fiber never activates and never throws.
        disposeInject = asDisposer(
          ctx.inject(['connection', 'webServer'], (webCtx) => {
            try {
              mount(webCtx)
            } catch {
              /* mount is already silent; belt and braces */
            }
          }),
        )
      } catch {
        disposeInject = null
      }
    }

    // Direct fallback for an already-injected Host context (e.g. a future
    // index.js that declares `inject: ['connection', 'webServer']`).
    if (disposeHandle === null && disposeInject === null && ctx && typeof ctx.get === 'function') {
      try {
        const connection = ctx.get('connection')
        if (connection && connection.rpc && typeof connection.rpc.handle === 'function') {
          if (typeof ctx.webServer !== 'undefined') mount(ctx)
        }
      } catch {
        /* no transport on this Host profile */
      }
    }
  } catch {
    /* never throw from apply */
  }

  return dispose
}

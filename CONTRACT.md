# dsh-plugin-ecosystem-guard — Host ⇄ Client contract (frozen)

The Lead owns this file. `client-half` implements against it and must not edit it.

Package: `dsh-plugin-ecosystem-guard` · bundle row id: `ecosystem-guard` · client module id: `dsh-plugin-ecosystem-guard`

## Client half entry points

`lib/client-rpc.js` must export:

```js
export function registerClientRpc(ctx, dispatch) // returns a disposer (sync function)
```

- `ctx` is the **Host** plugin context (the object passed to `apply`).
- `dispatch(method, args, signal)` is supplied by `index.js`; it resolves to a JSON value
  (never throws: errors come back as `{ ok: false, error: { code, message } }`).
- `registerClientRpc` must return a function; if no transport is available it returns a no-op.
- `index.js` already wraps it: `ctx.effect(() => registerClientRpc(ctx, dispatch))`.

## Methods

All responses are plain JSON objects. `ok: false` carries `error: { code, message }`.

### `guard.status` — no args

```json
{
  "ok": true,
  "version": "1.0.0",
  "runtimeVersion": "0.2.1-rc.3",
  "profile": "desktop",
  "transport": "available",
  "services": { "pluginManager": true, "userQuestions": true, "tools": true },
  "config": { "installPolicy": "ask", "invokeRequireConfirmation": true }
}
```

### `guard.scan` — no args (read-only)

```json
{
  "ok": true,
  "generatedAt": "2026-10-25T09:00:00.000Z",
  "version": "1.0.0",
  "runtimeVersion": "0.2.1-rc.3",
  "summary": { "pass": 3, "warn": 2, "fail": 1 },
  "counts": { "plugins": 96, "bundles": 19, "tools": 62 },
  "findings": [
    {
      "id": "entry-failed:include:foo",
      "severity": "fail",
      "code": "entry-failed",
      "title": "插件加载失败：foo",
      "detail": "fiberPhase=failed",
      "subject": "include:foo",
      "repairable": true,
      "suggestedAction": "重新启用该条目以重试加载"
    }
  ],
  "plugins": [
    {
      "entryId": "include:foo",
      "moduleName": "dsh-foo",
      "title": "Foo",
      "enabled": true,
      "fiberPhase": "active",
      "tools": ["foo_run"]
    }
  ]
}
```

`severity` is one of `pass | info | warn | fail`. `code` is a stable machine token
(`entry-failed`, `bundle-error`, `unhealthy-entry`, `duplicate-module`,
`duplicate-function`, `incompatible`, `self-degraded`, `config-invalid`,
`orphan-entry`, `stuck-interception`, `ok`). Findings may include `severity: "pass"`.

### `guard.capabilities` — no args (read-only)

```json
{
  "ok": true,
  "plugins": [
    {
      "entryId": "include:foo",
      "moduleName": "dsh-foo",
      "title": "Foo",
      "description": "…",
      "enabled": true,
      "fiberPhase": "active",
      "tools": [{ "name": "foo_run", "description": "…" }],
      "services": ["fooService"],
      "attribution": "heuristic"
    }
  ],
  "unownedTools": [{ "name": "some_tool", "description": "…" }]
}
```

### `guard.repair` — `{ targets?: string[], confirmed: true }`

`targets` are `finding.id` values; omit to repair every repairable finding.

```json
{
  "ok": true,
  "attempts": [
    { "findingId": "entry-failed:include:foo", "action": "retry-entry", "result": "applied", "detail": "applied" }
  ],
  "skipped": [{ "findingId": "duplicate-function:a:b", "reason": "需要人工选择保留哪个插件" }],
  "after": { "pass": 3, "warn": 1, "fail": 0 }
}
```

`result` is `applied | restart-required | overridden | failed | skipped`.

### `guard.reset` — `{ target: string, confirmed: true }`

`target` is `self` (reset this plugin's own config row to defaults), `state` (clear the
guard's in-memory history/cache), or an entry id (clear that entry's config override).

```json
{ "ok": true, "target": "self", "changed": true, "detail": "已把 ecosystem-guard 配置重置为默认值" }
```

### `guard.upgrade` — `{ target: string, confirmed: true }`

`target` is a bundle name or package name.

```json
{
  "ok": true,
  "target": "dsh-workspace-mover",
  "currentVersion": "2.4.1",
  "availableVersion": "2.4.1",
  "changed": false,
  "application": null,
  "detail": "已是最新版本"
}
```

`availableVersion` may be `null`: the plugin manager refuses to inspect an
already-installed package (`already-installed`), in which case the upgrade still
proceeds against the package's configured source and the result carries the real
`changed` / `application` / `version`.

`application` is the plugin manager outcome (`applied | restart-required | overridden | failed | cancelled`) when something was installed.

### `guard.debug` — `{}` or `{ confirmed: true }`

```json
{
  "ok": true,
  "generatedAt": "…",
  "report": {
    "env": { "platform": "win32", "node": "24.21.0", "profile": "desktop", "runtimeVersion": "0.2.1-rc.3" },
    "services": { "pluginManager": true },
    "history": [{ "at": "…", "kind": "scan", "summary": { "pass": 3, "warn": 0, "fail": 0 } }],
    "interceptions": [{ "at": "…", "spec": "foo", "verdict": "warn", "findings": [] }]
  }
}
```

## UI rules recap

- Register exactly one page into slot `settings.plugins.tab`, id `ecosystem-guard`, order 70.
- Destructive actions (修复 / 重置 / 升级 / 调试) require a second explicit confirmation
  click before the RPC call; only the confirmed call passes `confirmed: true`.
- 重新自检 (`guard.scan`) and capability refresh are read-only and need no confirmation.
- Any RPC failure renders an error banner inside the page; the slot must never crash.

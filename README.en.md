# dsh-plugin-ecosystem-guard

**An ecosystem guard plugin for DeepSeek Harness (DSH).** It audits the plugins you installed, audits a plugin *before* you install it, brokers other plugins' capabilities behind an explicit human confirmation, and performs repair / reset / upgrade / debug only after you say yes.

- Package: `dsh-plugin-ecosystem-guard` · bundle row id: `ecosystem-guard` · client module id: `dsh-plugin-ecosystem-guard`
- Entries: the agent tool `plugin_guard` + a Settings page (**Settings → Plugins → Ecosystem Guard**)
- The Settings page and the agent tool call the same Host operations (`lib/actions.js`). There is no second implementation of any operation.

> **Not the npm package `dsh-plugin-guard`.** That is a different, unrelated project (client-side crash isolation + self-update). This one is about pre-install conflict checking, cross-plugin governance and confirmation-gated maintenance. The package was renamed to avoid the collision.

## What it does

### 1. Health scan — `plugin_guard action=scan` (read-only)

Built from `pluginManager.listPlugins()/listBundles()` and `tools.schemas()`:

| Check | finding code |
| --- | --- |
| A plugin entry failed to load (`fiberPhase=failed`) | `entry-failed` |
| A bundle failed to apply its patch, or is incompatible with this DSH | `bundle-error` / `incompatible` |
| The same package is mounted by several entries | `duplicate-module` (advisory only) |
| Two installed plugins describe overlapping function | `duplicate-function` (heuristic) |
| The guard itself is degraded (missing service, no confirmation channel, no UI channel) | `self-degraded` |
| The guard's own config is invalid | `config-invalid` |

Tool ownership is **heuristic** (package-name tokens weighted by rarity) and always labelled `attribution: "heuristic"`. A guard that guesses silently is worse than one that says it guesses.

### 2. Pre-install conflict check

Two paths, one analyser (`lib/doctor.js#analyzeInstall`):

- **Automatic gate:** a `tools/pre-execute` listener inspects every `plugin_manager install_bundle` call before it runs. A *blocking* conflict turns into an `ask` decision, so the conflict list appears in the approval card; rejecting it means nothing is installed.
- **On demand:** `plugin_guard action=check-install spec=<name|path|git|tarball>`.

| Verdict | Condition |
| --- | --- |
| `block` | A local path package's `engines.dsh` is provably incompatible with the running DSH |
| `warn` | The manager refuses the spec (already installed, not found…), a version change, another entry already mounts the package, or likely duplicate function |
| `ok` | Nothing found |

A refusal is **not** a conflict: the manager will simply decline the installation. Treating it as a conflict would put a scary approval prompt in front of every ordinary reinstall. Version ranges that cannot be parsed never block — the plugin manager has the final say.

### 3. Brokering other plugins' capabilities — `action=capabilities` / `action=invoke`

- `capabilities` lists what each plugin exposes (tools + `typert`-reflected services).
- `invoke` dispatches another plugin's tool through the shared tool pipeline (`ctx.tools.execute`) after resolving the owner and asking the user. Because it goes through the pipeline, scope restrictions, `tools/pre-execute`, approvals and timeouts all still apply — this plugin adds a confirmation, it never removes a check.

### 4. Maintenance — every one of these asks first

| action | Effect | Confirmation |
| --- | --- | --- |
| `repair` | Retry only what is safe to retry: reload failed entries/bundles, refresh the guard's own cache; re-check afterwards and report `verified` | question card |
| `reset` | `self` = defaults for this plugin, `state` = clear in-memory state, `<entryId>` = clear that plugin's config override | question card |
| `upgrade` | `inspect` → resolve the version jump → `installBundle`, reporting the real `applied / restart-required / overridden / failed` | question card |
| `debug` | Redacted diagnostics (environment, service availability, recent decisions), never written to disk | question card |

It never decides which of two duplicate plugins to keep, never grants a version exemption, never approves install scripts.

## Security model (enforced in code, asserted by tests)

| Attacker | Control | Mitigation |
| --- | --- | --- |
| Model / agent (possibly prompt-injected) | tool arguments, `invoke` target, confirmation text | hard deny-list, ownership check, rate limit, agent text shown as unverified data, flattened to plain text |
| Hostile or sloppy plugins | own package name, `meta.title/description`, `package.json` | treated as **data** only: control characters stripped, truncated, labelled "not instructions"; never enters the system prompt or any decision |
| Local process / browser | the Settings page RPC channel | rides the existing DSH `connection` RPC trust boundary; destructive methods require `confirmed:true` and are sent only after two explicit clicks |
| Supply chain | a newer registry version, install scripts | upgrade only follows the source that bundle is already configured with, shows old→new before asking, and **never** passes `approvedBuilds` |

Hard invariants:

1. **No human, no action.** Missing `userQuestions`, a delegated sub-agent caller, a cancel, or a timeout all end in `aborted` — never in assumed consent.
2. **High-impact tools are never brokered.** `plugin_*`, `cordis_*`, `run_code`, `bash`, `pwsh`, `terminal_*`, `write`, `edit`, `delete`, `move` are denied by hard-coded regexes that **do not read config**.
3. **Brokering is limited to other plugins' own tools**: an unattributable tool is refused; the guard cannot call itself; 10 calls per 10 minutes; no nesting.
4. **Security-boundary modules are never touched automatically**: approval, permission presets, sandbox, credentials, authorization and account packages are reported but never reloaded or reset.
5. **No writes, no code execution, no network.** The only file read outside its own package is one `package.json` of a local path spec (`stat` ≤512 KB, `JSON.parse`, only `engines.dsh` / `peerDependencies` strings consulted).
6. **No prompt injection**: no system-prompt section, no session events, no history mutation.
7. **Bounded work**: ≤300 bundles compared, ≤200 findings returned, 20 s `inspect` timeout.
8. **Its own failures stay local**: `apply` never throws; the Settings transport is loaded by lazy dynamic import; every disposer is idempotent.

### What it deliberately is not

- It is **not a sandbox**: it cannot stop another plugin from misbehaving.
- It does **not** verify package signatures or provenance; duplicate detection is heuristic.
- It does **not** override the plugin manager: a blocking pre-check asks the user, it does not veto on their behalf.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `installPolicy` | `ask` | `ask` = request approval on a blocking conflict; `audit` = record only; `off` = do not listen |
| `invokeBlocklist` | `[plugin_guard, plugin_manager, run_code]` | additional deny-list on top of the hard-coded one |
| `invokeTimeoutMs` | `120000` | brokered call timeout |
| `duplicateWarnScore` / `duplicateInfoScore` | `0.7` / `0.45` | duplicate-function thresholds |
| `confirmTimeoutMs` | `600000` | confirmation wait (30 s floor) |
| `locale` | `zh` | report language (`zh` / `en`) |

`invokeRequireConfirmation`, `confirmDestructive` and `confirmDebug` exist in the schema so old patch layers keep parsing, but they are **forced to `true` in code**. A confirmation that can be turned off is not a confirmation.

## Install

```text
plugin_manager action=install_bundle target=dsh-plugin-ecosystem-guard
plugin_manager action=install_bundle target=<path>/dsh-plugin-ecosystem-guard-1.0.0.tgz
plugin_manager action=install_bundle target=git+https://…
```

Requires Node ≥ 20 and DSH ≥ 0.2.1-rc.1. Zero runtime dependencies (Node built-ins plus the host-provided React).

## Remove

```text
plugin_manager action=remove_bundle target=dsh-plugin-ecosystem-guard
```

## Development

```powershell
node --check index.js
node --check lib/doctor.js
node --check lib/actions.js
node --test test/selftest.mjs test/actions.test.mjs   # 27/27
```

`lib/doctor.js` is a pure analysis engine with no Harness dependency; `lib/actions.js` only needs the service objects behind `ctx.get(...)`, so both are unit-testable against a fake Host. The security invariants are asserted in `test/actions.test.mjs`.

## License

MIT — see [LICENSE](LICENSE).

Copyright (c) 2026 游尘 (YC).

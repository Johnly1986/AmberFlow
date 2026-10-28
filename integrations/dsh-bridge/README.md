---
description: "The harness side of calling the AmberFlow browser engine: model-facing tools that observe a page, list and read flow apps, generate an app.mjs skeleton, validate a script's call sequence, run one flow app (with an execution budget), record a flow into a flow app, and run the real-site suite — for deployments that drive browser automation from a session."
kind: "package-bundle"
---

# @deepseek-ai/dsh-amberflow-bridge

English | [中文](README.zh.md)

## Summary

`dsh-amberflow-bridge` exposes an external browser engine as model-facing tools. AmberFlow has exactly ONE app format: a **flow script** at `$AMBERFLOW_HOME/apps/<id>/app.mjs` (or in the checkout's fixtures) exporting `meta` and `flow(ctx)`. The script owns the control flow — `if`, `for`, `while`, sub-functions — while the engine owns each step's target, gate, action and completion signal, and DOM signals are the only completion truth. The bridge adds no browser or app logic of its own and instead spawns that checkout's CLIs and summarizes their artifacts.

The plugin ships **nine** tools: `amberflow_status` (environment/model facts), `amberflow_apps` (list flow apps through `amber apps list --json`), `amberflow_app_show` (metadata + current `app.mjs` source + version anchors), `amberflow_app_check` (load + dry-run the call sequence, no browser), `amberflow_inspect` (read-only page observation and hint candidates), `amberflow_app_create` (generate a flow skeleton with `amber apps new`), `amberflow_run` (run one app; `max_steps` is an execution budget), `amberflow_learn` (record a flow into a flow app, gated by a rules-only replay of the generated script), and `amberflow_test` (real-site regression suite). The plugin's **configuration page** (Settings → Plugins → this bundle's row → Configure) sets exactly three fields for the **online decision model** — Model URL, Token Key, ModelName — so runs can use the unified `decision-service` provider (System One) instead of the local ONNX model — the same three keys `amber config set` writes for the engine CLI.

The authoring loop for an Agent is `amberflow_status` → `amberflow_apps` → `amberflow_app_show` (read `path` and the current source) → **edit `app.mjs` with the file tools** → `amberflow_app_check` → `amberflow_inspect` (look at the real page before writing a hint) → `amberflow_run` with `max_steps`/`trace` for structured feedback → `amberflow_run` full → `amberflow_test`. There is no step-number editing interface: a script has no static step table, steps are runtime facts, and the script version is the only flow version.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the path of a AmberFlow checkout. A path that is not a checkout fails at load time rather than on the first call, so a typo surfaces during composition:

```yaml
repoPath: null                  # optional; resolves config > AMBERFLOW_REPO > the checkout the plugin sits in
nodeBin: null                   # optional; defaults to the running interpreter
timeoutMs: 900000               # optional; live runs are slow by nature
allowDangerous: false           # optional; gates dry-run-gated tool steps
toolPrefix: amberflow          # optional; the model-visible tool-name prefix
envMode: inherit                # optional; `allowlist` strips session secrets from the child env
forwardEnv: []                  # optional; extra env var names forwarded in `allowlist` mode
keepRuns: 30                    # optional; newest $TMPDIR/dsh-amberflow-* dirs kept; 0 disables GC
```

### When to choose it

Choose it when a session should drive a flow that must stay reproducible: the engine refuses to invent a target, reports completion only from a DOM signal, and refuses to save a recorded flow unless a replay of the generated script with zero model calls still passes. Choose a pixel-level browser tool instead when the task depends on what a page looks like, or when no checkout is available to call.

Install it into a profile as a bundle — `dsh plugin --profile <name> add <path-or-package>` (the plugin window runs the same operation). Three channels are supported:

- **Path / link** (this repository's development shape): `dsh plugin --profile web add /absolute/path/to/AmberFlow/integrations/dsh-bridge`
  installs the nested package; its `cordis.patch.yml` addresses the plugin by package name.
- **The engine repository itself over git**: `dsh plugin --profile <name> add github:Johnly1986/AmberFlow`
  installs the repo root, whose `dsh.bundle` points at `dsh-bundle.yml` — the row addresses
  `amberflow/dsh-plugin` (a package subpath), and the root package's `dsh.client` now serves the
  configuration page too. The clone contains the whole engine, so the plugin locates its own
  checkout; no build script runs, so no `allowBuilds` grant is needed for this package itself (its dependencies that do run install scripts — `onnxruntime-node`, `protobufjs` —
  are the only names to approve if pnpm lists them). Pin commits for installs you trust long-term
  (`#<sha>`), and run `npx playwright install chromium` once where the profile boots. The ONNX
  decision model is a large artifact that deliberately stays out of git: rules-only runs and
  `learn`'s zero-forward replay need nothing beyond the clone, but model-fallback decisions on a
  fresh machine want `laya_dec.onnx` (+ `.onnx.data`, optionally the tokenizer) installed — that is
  what the checkout's `npm run model:fetch -- --from <url|path>` does (SHA256-gated, verify-then-swap;
  `npm run doctor` names the missing piece). Without it the run still works and the summary says
  `model: off(missing)`; steps that genuinely need the model fail loudly at load instead of guessing.
- **npm or tarball**: pack with `pnpm pack`; the root `package.json` is the bundle, so the git
  behavior above carries over unchanged.

A package that declares `dsh.bundle` joins `dsh.profile.bundles` on install, so the tools
become available without a hand-written profile patch; a live profile applies that at the next
config reload. `AMBERFLOW_REPO` overrides the checkout the resolved config names; a path that is
not a checkout fails at load time.

### Call it from another plugin

Other plugins can inject the service instead of calling a tool. The bridge provides `ctx.amberflow`
with `listApps`, `run`, `learn`, `status`, `appShow`, `appCheck`, `inspect`, `test`, and
`createApp` — the same code the tools run, so the deployment gate and the failure diagnostics cannot
drift between the two doors. The tools stay the model-facing door; the service is the plugin-facing
one, and it needs no `callId`, no signal, and no tool name.

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-amberflow-bridge'

const Consumer = {
  name: 'consumer',
  inject: ['amberflow'],
  apply(ctx: Context) {
    return ctx.amberflow.run({ app: 'learned-cart', maxSteps: 3 })
  },
}
```

## Understand the implementation

Each tool is a thin wrapper: it assembles an argv, runs one child process with a hard timeout, and
summarizes the JSON the CLI wrote. Business semantics stay in the checkout; the bridge never scans
the apps directory, never interprets app source, and never writes app code.

- `amberflow_apps` spawns `amber apps list --json` and projects the envelope's rows: id, label, goal,
  writable path, source (`user` / `built-in`), `kind=flow`, invariant count, hosts, and an `error` for
  a script that failed to load. There is no static step count — steps are runtime facts — so a row
  never pretends to know how many steps will run. Listing starts no browser and calls no model.
- `amberflow_app_show` spawns `amber apps show <id> --json --code` and returns the path, metadata,
  `script_sha256` / `plan_sha256` (the "which version did I change" anchors) and the current script
  source. `path` is the only place to write; the Agent edits it with its own file tools.
- `amberflow_app_check` spawns `amber apps check <id> --json`: the script is loaded (import + `meta`
  contract + validation) and its `flow(ctx)` call sequence is dry-run, so problems come with the
  script line when the CLI can locate it. Exit code 2 means problems; the bridge reports them.
- `amberflow_app_create` spawns `amber apps new <id> --json` (optional `--goal` / `--host`) and then
  returns `app_show`. Only the flow skeleton is generated — there is no step/format/kind parameter,
  and no JSON app format.
- `amberflow_run` spawns `src/app/app-runner.ts --app <id> --out <dir>` and reads `<id>-result.json`.
  The summary lists failures only; the full per-step table stays in `<id>-report.md`, which the
  result names so a caller can read it when the detail matters. `dry` dry-runs the script's call
  sequence (`--dry`, no browser) and returns it: that run writes no artifact and verifies nothing, so
  it is reported as an expansion rather than as a PASS or a FAIL. `max_steps` is an **execution
  budget** (`--max-steps`), not a step index; the trace flag defaults on for the bridge.
- `amberflow_learn` spawns `tools/learn.ts --json --yes`, which performs the flow once, induces each
  step's completion signal and the end-state invariants, and writes a **flow app** (`app.mjs`) only
  when a rules-only replay of the generated script passes; the bridge reports that replay verbatim.
  `script` is required, because the CLI's only other action source is a human demonstration on an
  interactive terminal: a tool call has neither a terminal nor stdin, and the bridge always passes
  `--yes`. A call without a script is refused before anything is spawned. `apps_dir` overrides where
  the app lands (`--apps-dir`; the default is the user-scope `$AMBERFLOW_HOME/apps`).

The bridge itself calls **no LLM**: the decision fallback is the checkout's local ONNX model, and
`learn`'s save gate is a rules-only replay with zero model calls. LLM doors are CLI-level opt-ins
that need `OPENAI_*` on the machine running the checkout — they are not a plugin requirement.

### Watching the browser (headed runs)

Every browser door can be made visible with `--headful`:

| Surface | How |
|---|---|
| Engine CLI | `amber run <app> --headful`; `amber inspect --url <URL> --headed`; `node tools/learn.ts --headful` |
| DSH tools | `…_run` with `headful: true`, `…_inspect` with `headful: true`, `…_learn` with `headful: true` (or `cdp` to drive a browser you already have open) |

Two things to know:

- **The window appears on the machine that runs the engine** — the deployment host — not inside the
  DSH browser page. Over a headless server, give it a display and look at that display:
  ```bash
  xvfb-run -a -s "-screen 0 1440x900x24" dsh --profile web --no-open --port 3080   # whole host under Xvfb
  # 或只包一次运行：xvfb-run -a amber test --tier smoke --headful
  # 要人眼看：再配 x11vnc / noVNC，或用 ffmpeg -f x11grab -i $DISPLAY 抓帧
  ```
- Headed needs the **full chromium**. Measured here: `--headful` launches `chromium-*/chrome` with no
  `--headless` flag (a real window, captured on the virtual display), while the default launches
  `chrome-headless-shell --headless`. If a box only has the headless shell, a headed run stops with a
  message naming the fix (`npx playwright install chromium`) instead of a Playwright mystery.

### Configuration page: the unified decision service (System One)

The bundle ships a browser half that registers its own row page at `plugins.row.config`, so
Settings → Plugins → this bundle → the `amberflow-bridge` row gains a **Configure** control. The page
shows exactly three fields (they are the only `.volatile()` fields in the plugin's Config), and they
configure the **decision model** the engine executes steps with:

| Field | Forwarded to the engine CLI as | Meaning |
|---|---|---|
| **Decision model URL** | `AMBERFLOW_DECISION_BASE_URL` | service base URL (e.g. `https://…/compatible-mode/v1` or `http://localhost:8008`); the bridge normalizes it to the `/systemone` endpoint (an already-suffixed value is kept as-is) |
| **Decision Token Key** | `AMBERFLOW_DECISION_API_KEY` | bearer token; write-only — the Host never returns it, the UI shows only "configured / not set" |
| **Decision ModelName** | `AMBERFLOW_DECISION_MODEL` | decision model id (e.g. `decision-model-preview`); empty uses the provider default |

How it behaves:

- **Provider default:** with URL **and** token set, the bridge adds `--provider decision-service` to app
  runs (`amberflow_run`), so the plugin runs on the online decision model without a per-call argument.
  An explicit `provider` argument still wins, and ablation arms (`ablate`) never inherit the default.
- **Effective without a restart.** `.volatile()` config fields are committed by the Loader into the
  running references and the bridge re-reads them on `loader/volatile-update`; CLI calls started
  afterwards see the new endpoint. Saves persist in the active profile's `cordis.patch.yml`.
- **Unset = local plane.** Empty fields add no environment entries, so a deployment that configures
  nothing keeps the local ONNX decision model (or rules-only) — the bridge still needs no model key.
- **Scope:** this is the **SystemOne execution** decision model. LLM doors are a separate path and
  still read `OPENAI_*` from the environment.
- **Editing is loopback-only by Harness policy.** A page opened from a non-loopback address makes
  `ctx.remote.$host.isLoopback` false, and Harness switches settings to memory mode there: the Host
  configuration is neither read nor written over a remote page. The row page therefore renders a
  short explanation instead of the form when opened remotely — edit on the Host machine itself, or
  through an SSH tunnel (`ssh -L 8080:127.0.0.1:3080 <host>`). What you save on a loopback page
  applies to every run, including runs started from the remote page.
- **Only these three fields are editable here.** `repoPath`, `nodeBin`, `timeoutMs`,
  `allowDangerous`, `toolPrefix`, `envMode`, `envMode`-forwarding and `keepRuns` stay in
  `cordis.patch.yml` (changing an ordinary field remounts the plugin; `toolPrefix` even renames the
  tools, so it must not be live-edited).
- **Both install doors serve this page.** The bundle ships two byte-equivalent client bundles:
  `client.js` for the nested `integrations/dsh-bridge` install (module id = package name, row key
  `@deepseek-ai/dsh-amberflow-bridge#amberflow-bridge`), and the generated `client-root.js` for the
  repository-root install (`dsh plugin add <repo>`; module id = root package `amberflow`, row key
  `amberflow#amberflow-bridge`). The repository bundle row names the PACKAGE ROOT (`amberflow`),
  because the DSH client scanner only serves a browser half for a package-root row — a hand-written
  profile patch that overrides this row must therefore use `name: amberflow` (the `amberflow/dsh-plugin`
  export alias keeps old Host-only patches loading, but they get no configuration page). Edit
  `client.js` only and regenerate with `node integrations/dsh-bridge/scripts/client-root-sync.mjs`;
  a test pins the generated copy.

### Trust boundary

The bridge spawns a foreign process from `repoPath` and does not route it through the harness sandbox
policy, so enabling the plugin means trusting that checkout. Dangerous tool steps stay refused unless
the deployment sets `allowDangerous: true`, and a call that asks for them on a deployment that has not
is rejected instead of being silently downgraded.

## Further Exploration

- `docs/AGENT_INTERFACE.md` — the authoritative contract for this interface (apps, CLI JSON, bridge
  tools), and `docs/APP_SCRIPT_AUTHORING.md` — how a flow app's `meta` / `flow(ctx)` are written.
- Inside the DSH installation this plugin runs in: `packages/core/tools` is the registry whose
  schemas and dispatch the bridge's tool definitions target.

## Model Experience

The model sees a set of tools with narrow schemas: list/read (`apps` / `app_show`), validate
(`app_check`), observe (`inspect`), author (`app_create` + its own file edits to `app.mjs`), run
(`run` with an optional execution budget), record (`learn`), and regress (`test`).
`amberflow_run` answers with PASS or FAIL, the completion count, invariant counts, the failed steps
with their obstacle text, and the report path; steps that completed are a count, not rows, so a
sixty-step flow costs a line rather than a page. Every answer also carries a **tier line** —
`model: on` / `off(missing)` / `off(rules-only)` — and, when the artifact has it, the per-step
**decision tally** (`rule 19 · laya 1 (conf 0.31) · laya:reobserve 1 · cache 命中 6/12 forwards`):
a user learns which ladder actually ran, and the model's appearances stop being invisible step-log
trivia. A tool step that failed without being refused is named too, and a run that stopped with no
failed step to name reports its exit code or timeout, so a FAIL says why it failed.
`dry` answers with the script's dry-run call sequence instead, so a flow can be inspected without
being run. `amberflow_learn` answers with the replay it was gated on, including the model-call count,
so a flow that could not be reproduced is never reported as learned; without a script it refuses
immediately, before a browser is launched.

## Known Limitations and Deferred Work

- The live tests need a checkout and a chromium build (the recording test also needs the checkout's
  ONNX graph); without them they SKIP with the reason printed.
- The bridge is deliberately not a `tool-*` package, so it stays out of the generated tool catalog.
- Every run leaves its temp directory behind — the result names the report inside it, so that
  directory has to outlive the call. Artifacts are per call, never shared. `keepRuns` caps how many
  of the newest `dsh-amberflow-*` directories survive; a directory is only removed an hour after
  its last write, so a slow live run is never pruned under it.
- The child environment is inherited wholesale by default (trusting the checkout is the stated
  premise). Set `envMode: allowlist` to forward only the run essentials plus `AMBERFLOW_*` and
  `forwardEnv`.
- Upgrading the package while the Host is already running: the Host keeps the module generation it
  loaded at startup, so a newly added configuration page (and its Config schema) appears only after
  the Host process restarts. A fresh install has no such issue.
- The bridge does not edit app source: there is no step/index editing tool, because a flow script has
  no static step table. The Agent reads and writes `app.mjs` itself.
- `amberflow_learn` cannot demonstrate for you: recording a NEW flow needs a recorded action list,
  because the CLI's live recorder needs an interactive terminal. A script-less call is refused up
  front rather than being allowed to fail inside the engine.

### Dev Note

本包不再携带测试文件；在真实 DSH 进程里手工加载验证，或设 `DSH_ROOT` 后运行 `npm run setup && npm run build`。
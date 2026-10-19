---
description: "The harness side of calling the AmberFlow frozen-plan browser engine: four tools that list its apps, run one end to end, record a flow from a goal/page/action list, and plan a site-agnostic flow — for deployments that drive browser automation from a session. A journey may mix application types (web/cli/ssh/stdio)."
kind: "package-bundle"
---

# @deepseek-ai/dsh-amberflow-bridge

English | [中文](README.zh.md)

## Summary

`dsh-amberflow-bridge` exposes an external browser engine as four model-facing tools. AmberFlow plans once and then decides every step **locally**, treats DOM signals as the only completion truth, and can record a flow from one demonstration; the bridge adds no browser logic of its own and instead spawns that checkout's CLIs and summarizes their artifacts. An app may mix **application types** — web/cli/ssh/stdio (interactive processes such as games) in one journey — and the listing reports that mix plus any local service the run needs (e.g. ssh needs a reachable local sshd). The plugin's **configuration page** (Settings → Plugins → this bundle's row → Configure) sets exactly three fields for the **online decision model** — Model URL, Token Key, ModelName — so runs can use the token-plan SystemOne provider instead of the local ONNX model. `amberflow_apps` lists the declared apps and says whether each pack was generated from a spec, recorded from a demonstration, hand-written, or a pure data source. `amberflow_run` runs one app end to end and returns completion, the FAILED steps only, refusals, and invariant results — or, under `dry`, the expanded plan it did not execute. `amberflow_learn` records a flow from a goal, a page and a recorded action list, and reports the rules-only replay that decides whether it was reproducible enough to save.

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
forwardEnv: []                  # optional; `allowlist` 模式下额外转发的环境变量名
keepRuns: 30                    # optional; newest $TMPDIR/dsh-amberflow-* dirs kept; 0 disables GC
```

### When to choose it

Choose it when a session should drive a flow that must stay reproducible: the engine refuses to
invent a target, reports completion only from a DOM signal, and refuses to save a recorded flow
unless a replay with zero model calls still passes. Choose a pixel-level browser tool instead when
the task depends on what a page looks like, or when no checkout is available to call.

Install it into a profile as a bundle — `dsh plugin --profile <name> add <path-or-package>` (the
plugin window runs the same operation). Three channels are supported:

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

A package that declares `dsh.bundle` joins `dsh.profile.bundles` on install, so the four tools
become available without a hand-written profile patch; a live profile applies that at the next
config reload. `AMBERFLOW_REPO` overrides the checkout the resolved config names; a path that is
not a checkout fails at load time.

### Call it from another plugin

Other plugins can inject the service instead of calling a tool. The bridge provides `ctx.amberflow`
with `listApps`, `run`, and `learn` — the same code the tools run, so the deployment gate and the
failure diagnostics cannot drift between the two doors. The tools stay the model-facing door; the
service is the plugin-facing one, and it needs no `callId`, no signal, and no tool name.

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-amberflow-bridge'

const Consumer = {
  name: 'consumer',
  inject: ['amberflow'],
  apply(ctx: Context) {
    return ctx.amberflow.run({ app: 'learned-cart', noModel: true })
  },
}
```

## Understand the implementation

Each tool is a thin wrapper: it assembles an argv, runs one child process with a hard timeout, and
summarizes the artifacts the CLI wrote.

- `amberflow_apps` reads `apps/<id>/pack.json` files only: no browser, no model, no subprocess. A
  directory with no `pack.json` but a `sources/` tree is a **pure data source** and is listed with
  origin `data-source`, because other packs reference it by name.
- `amberflow_run` spawns `src/app-runner.ts --app <id> --out <dir>` and reads `<id>-result.json`.
  The summary lists failures only; the full per-step table stays in `<id>-report.md`, which the
  result names so a caller can read it when the detail matters. `dry` expands the plan and returns
  it: that run writes no artifact and verifies nothing, so it is reported as an expansion rather
  than as a PASS or a FAIL.
- `amberflow_learn` spawns `tools/learn.ts --json --yes`, which performs the flow once, induces
  each step's completion signal and the end-state invariants, and saves the pack only when the
  rules-only replay passes; the bridge reports that replay verbatim. `script` is required, because
  the CLI's only other action source is a human demonstration on an interactive terminal: a tool
  call has neither a terminal nor stdin, and the bridge always passes `--yes`. A call without a
  script is refused before anything is spawned.

### Multi-type applications (web / cli / ssh / stdio)

The engine's adapter layer lets one journey mix application types: a browser step (`web`), a local
command (`cli`), a remote command over `ssh`, and an interactive process (`stdio`, e.g. a game whose
prompts are answered line by line) can sit in the same `journey`, and the engine dispatches each step
by its adapter. Values produced by a step can also travel: a step may declare `returns`, and later
steps consume the named value (`{dataset:NAME}` in process arguments, or a `{from:"dataset"}` command
binding on the browser side).

The bridge surfaces what the session needs before spending a run:

- each listing row carries `types` — the journey's adapter mix, e.g. `web×2 · cli×3 · ssh×1 · stdio×1`
  (sorted; empty for pure data sources) — and `requires` — local services the run needs, e.g. `ssh`
  needs a reachable local sshd;
- the run summary repeats those two fields (only when the app mixes types / declares a requirement), so
  a blocked or refused run caused by a missing local service is interpretable instead of mysterious.

The bridge itself calls **no LLM**: the decision fallback is the checkout's local ONNX model, and
`learn`'s save gate is a rules-only replay with zero model calls. LLM doors (the LLM planner, or the
semantic-flow escalation teacher) are CLI-level opt-ins that need `OPENAI_*` on the machine running
the checkout — they are not a plugin requirement.

### Configuration page: the online decision model (token-plan SystemOne)

The bundle ships a browser half that registers its own row page at `plugins.row.config`, so
Settings → Plugins → this bundle → the `amberflow-bridge` row gains a **Configure** control. The page
shows exactly three fields (they are the only `.volatile()` fields in the plugin's Config), and they
configure the **decision model** the engine executes steps with:

| Field | Forwarded to the engine CLI as | Meaning |
|---|---|---|
| **Decision model URL** | `TOKEN_PLAN_ENDPOINT` | token-plan compatible-mode base URL (e.g. `https://…/compatible-mode/v1`); the bridge appends `/systemone` (an already-suffixed value is kept as-is) |
| **Decision Token Key** | `TOKEN_PLAN_API_KEY` | bearer token; write-only — the Host never returns it, the UI shows only "configured / not set" |
| **Decision ModelName** | `TOKEN_PLAN_MODEL` | decision model id (e.g. `decision-model-preview`); empty uses the provider default |

How it behaves:

- **Provider default:** with URL **and** token set, the bridge adds `--provider token-plan` to app
  runs (`amberflow_run`), so the plugin runs on the online decision model without a per-call argument.
  An explicit `provider` argument still wins, and ablation arms (`ablate`) never inherit the default.
- **Effective without a restart.** `.volatile()` config fields are committed by the Loader into the
  running references and the bridge re-reads them on `loader/volatile-update`; CLI calls started
  afterwards see the new endpoint. Saves persist in the active profile's `cordis.patch.yml`.
- **Unset = local plane.** Empty fields add no environment entries, so a deployment that configures
  nothing keeps the local ONNX decision model (or rules-only) — the bridge still needs no model key.
- **Scope:** this is the **SystemOne execution** decision model. LLM doors (LLM planner, auditor,
  semantic escalation) are a separate path and still read `OPENAI_*` from the environment. The `plan`
  tool's planning phase and semantic-template runs keep their own decision planes, so this page does
  not override them yet.
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

- This repository's `apps/README.md` — how an app pack is declared, the exit-code contract the tools
  surface, and the two biting rules.
- Inside the DSH installation this plugin runs in: `packages/core/tools` is the registry whose
  schemas and dispatch the tests exercise, and `packages/browser-use/browser-use` is the in-tree
  browser automation service this bridge complements.

## Model Experience

The model sees four tools with narrow schemas. `amberflow_run` answers with PASS or FAIL, the
completion count, invariant counts, the failed steps with their obstacle text, and the report path;
steps that completed are a count, not rows, so a sixty-step journey costs a line rather than a page.
Every answer also carries a **tier line** — `model: on` / `off(missing)` / `off(rules-only)` — and, when
the artifact has it, the per-step **decision tally** (`rule 19 · laya 1 (conf 0.31) · laya:reobserve 1 ·
cache 命中 6/12 forwards`): a user learns which ladder actually ran, and the model's appearances stop
being invisible step-log trivia (docs/LAYA_VALUE_PLAN.md P0/P1). A tool step that failed without being
refused is named too, and a run that stopped with no failed step
to name reports its exit code or timeout, so a FAIL says why it failed.
The apps listing is where a session learns an app's **type mix** (`types`, e.g. `web×2 · cli×3 ·
ssh×1 · stdio×1`) and any **local service** the run needs (`requires`, e.g. ssh ⇒ local sshd), and
the run summary repeats both when they apply — a blocked/refused run caused by a missing local
service is interpretable, not mysterious.
`dry` answers with the expanded plan instead, so a journey can be inspected without being run.
`amberflow_learn` answers with the replay it was gated on, including the model-call count, so a flow
that could not be reproduced is never reported as learned; without a script it refuses immediately,
before a browser is launched.

## Known Limitations and Deferred Work

- The live tests need a checkout and a chromium build (the recording test also needs the checkout's
  ONNX graph); without them they SKIP with the reason printed.
- The bridge is deliberately not a `tool-*` package, so it stays out of the generated tool catalog.
- Every run leaves its temp directory behind — the result names the report inside it, so that
  directory has to outlive the call. Artifacts are per call, never shared. `keepRuns` caps how many
  of the newest `dsh-amberflow-*` directories survive; a directory is only removed an hour after
  its last write, so a slow live run is never pruned under it.
- App listings mark `kind=probe` packs (measurement sets the engine refuses to run through the app
  runner) and `data-source` packs, and `…_run` turns the engine's probe refusal into that guidance —
  but the probe drivers themselves are still not exposed as a tool.
- The child environment is inherited wholesale by default (trusting the checkout is the stated
  premise). Set `envMode: allowlist` to forward only the run essentials plus `AMBERFLOW_*` and
  `forwardEnv`.
- Upgrading the package while the Host is already running: the Host keeps the module generation it
  loaded at startup, so a newly added configuration page (and its Config schema) appears only after
  the Host process restarts. A fresh install has no such issue.
- Apps that need a local service (e.g. `ssh` without a reachable sshd) fail **structurally** at
  run time (`requires` in the listing is the heads-up); the bridge does not provision services.
- `amberflow_learn` cannot demonstrate for you: recording a NEW flow needs a recorded action list,
  because the CLI's live recorder needs an interactive terminal. A script-less call is refused up
  front rather than being allowed to fail inside the engine.

### Dev Note

The package is tested at two levels. `tests/bridge.spec.ts` mounts the plugin on a stub checkout whose
CLIs mirror the real ones on the points the bridge depends on — `--dry` prints a plan and writes no
artifact, `learn` refuses without `--script`, stdout carries log lines (one with a brace) before the
JSON — and drives the four tools through `ctx.tools.execute`, covering argument assembly, provenance
parsing, failure-only summarization, load-time validation, the refusal paths and the dry expansion.
`tests/live.spec.ts` drives the real checkout through the same registry path: a recorded two-step app
with an `ablate` arm (`stub` | `rules-only`; omit it and the real model runs), a `dry` expansion, a run forced to fail so the FAIL verdict is checked against a real
artifact, the script-less refusal, and a real recording whose zero-forward replay gates the save.

---
description: "The harness side of calling the LayaWebUse frozen-plan browser engine: three tools that list its apps, run one end to end, and record a flow from a goal, a page and a recorded action list, for deployments that drive browser automation from a session."
kind: "package-bundle"
---

# @deepseek-ai/dsh-layawebuse-bridge

English | [中文](README.zh.md)

## Summary

`dsh-layawebuse-bridge` exposes an external browser engine as three model-facing tools. LayaWebUse plans once and then decides every step **locally**, treats DOM signals as the only completion truth, and can record a flow from one demonstration; the bridge adds no browser logic of its own and instead spawns that checkout's CLIs and summarizes their artifacts. `layawebuse_apps` lists the declared apps and says whether each pack was generated from a spec, recorded from a demonstration, hand-written, or a pure data source. `layawebuse_run` runs one app end to end and returns completion, the FAILED steps only, refusals, and invariant results — or, under `dry`, the expanded plan it did not execute. `layawebuse_learn` records a flow from a goal, a page and a recorded action list, and reports the rules-only replay that decides whether it was reproducible enough to save.

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

Mount the plugin with the path of a LayaWebUse checkout. A path that is not a checkout fails at load time rather than on the first call, so a typo surfaces during composition:

```yaml
repoPath: /path/to/LayaWebUse   # required; must contain src/app-runner.ts
nodeBin: null                   # optional; defaults to the running interpreter
timeoutMs: 900000               # optional; live runs are slow by nature
allowDangerous: false           # optional; gates dry-run-gated tool steps
toolPrefix: layawebuse          # optional; the model-visible tool-name prefix
```

### When to choose it

Choose it when a session should drive a flow that must stay reproducible: the engine refuses to
invent a target, reports completion only from a DOM signal, and refuses to save a recorded flow
unless a replay with zero model calls still passes. Choose a pixel-level browser tool instead when
the task depends on what a page looks like, or when no checkout is available to call.

Install it into a profile as a bundle — `dsh plugin --profile <name> add <path-or-package>` (the
plugin window runs the same operation). A package that declares `dsh.bundle` joins
`dsh.profile.bundles` on install, so the three tools become available without a hand-written profile
patch; a live profile applies that at the next config reload. `LAYAWEBUSE_REPO` overrides the checkout
path the bundle patch passes, and a path that is not a checkout fails at load time.

### Call it from another plugin

Other plugins can inject the service instead of calling a tool. The bridge provides `ctx.layawebuse`
with `listApps`, `run`, and `learn` — the same code the tools run, so the deployment gate and the
failure diagnostics cannot drift between the two doors. The tools stay the model-facing door; the
service is the plugin-facing one, and it needs no `callId`, no signal, and no tool name.

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-layawebuse-bridge'

const Consumer = {
  name: 'consumer',
  inject: ['layawebuse'],
  apply(ctx: Context) {
    return ctx.layawebuse.run({ app: 'learned-cart', noModel: true })
  },
}
```

## Understand the implementation

Each tool is a thin wrapper: it assembles an argv, runs one child process with a hard timeout, and
summarizes the artifacts the CLI wrote.

- `layawebuse_apps` reads `apps/<id>/pack.json` files only: no browser, no model, no subprocess. A
  directory with no `pack.json` but a `sources/` tree is a **pure data source** and is listed with
  origin `data-source`, because other packs reference it by name.
- `layawebuse_run` spawns `src/app-runner.ts --app <id> --out <dir>` and reads `<id>-result.json`.
  The summary lists failures only; the full per-step table stays in `<id>-report.md`, which the
  result names so a caller can read it when the detail matters. `dry` expands the plan and returns
  it: that run writes no artifact and verifies nothing, so it is reported as an expansion rather
  than as a PASS or a FAIL.
- `layawebuse_learn` spawns `tools/learn.ts --json --yes`, which performs the flow once, induces
  each step's completion signal and the end-state invariants, and saves the pack only when the
  rules-only replay passes; the bridge reports that replay verbatim. `script` is required, because
  the CLI's only other action source is a human demonstration on an interactive terminal: a tool
  call has neither a terminal nor stdin, and the bridge always passes `--yes`. A call without a
  script is refused before anything is spawned.

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

The model sees three tools with narrow schemas. `layawebuse_run` answers with PASS or FAIL, the
completion count, invariant counts, the failed steps with their obstacle text, and the report path;
steps that completed are a count, not rows, so a sixty-step journey costs a line rather than a page.
A tool step that failed without being refused is named too, and a run that stopped with no failed step
to name reports its exit code or timeout, so a FAIL says why it failed.
`dry` answers with the expanded plan instead, so a journey can be inspected without being run.
`layawebuse_learn` answers with the replay it was gated on, including the model-call count, so a flow
that could not be reproduced is never reported as learned; without a script it refuses immediately,
before a browser is launched.

## Known Limitations and Deferred Work

- The live tests need a checkout and a chromium build (the recording test also needs the checkout's
  ONNX graph); without them they SKIP with the reason printed.
- The bridge is deliberately not a `tool-*` package, so it stays out of the generated tool catalog.
- Every run leaves its temp directory behind — the result names the report inside it, so that
  directory has to outlive the call. Artifacts are per call, never shared.
- The plugin does not yet expose the app-level probe or induction tools the checkout also provides.
- `layawebuse_learn` cannot demonstrate for you: recording a NEW flow needs a recorded action list,
  because the CLI's live recorder needs an interactive terminal. A script-less call is refused up
  front rather than being allowed to fail inside the engine.

### Dev Note

The package is tested at two levels. `tests/bridge.spec.ts` mounts the plugin on a stub checkout whose
CLIs mirror the real ones on the points the bridge depends on — `--dry` prints a plan and writes no
artifact, `learn` refuses without `--script`, stdout carries log lines (one with a brace) before the
JSON — and drives the three tools through `ctx.tools.execute`, covering argument assembly, provenance
parsing, failure-only summarization, load-time validation, the refusal paths and the dry expansion.
`tests/live.spec.ts` drives the real checkout through the same registry path: a recorded two-step app
with `no_model`, a `dry` expansion, a run forced to fail so the FAIL verdict is checked against a real
artifact, the script-less refusal, and a real recording whose zero-forward replay gates the save.

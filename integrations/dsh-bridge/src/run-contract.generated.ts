/**
 * 由 tools/run-args-gen.ts 从 src/support/run-args-contract.ts 生成——不要手改。
 * 重新生成：npm run run-args:gen；校验：npm run run-args:check。
 */

/** 桥进程 argv 的一个发射项（顺序由契约的 argv.order 决定）。 */
export interface BridgeRunArgvField {
  readonly key: keyof BridgeRunArgs;
  readonly flag: string;
  readonly kind: 'flag' | 'value' | 'repeated' | 'provider';
  readonly when?: 'truthy' | 'defined';
}

/** 一个 tool 参数到 `runArgs` camelCase 名的绑定。 */
export interface BridgeToolFieldBinding {
  readonly key: string;
  readonly param: string;
  readonly collect?: 'slots';
}

/** 一个 tool 参数到桥 argv 参数名的绑定（argvKey 缺省 = 不往引擎进程传）。 */
export interface BridgeServiceFieldBinding {
  readonly key: string;
  readonly argvKey?: string;
}

export interface BridgeRunArgs {
  app: string;
  outDir: string;
  /**
   * Only dry-run the flow's call sequence: no browser, no tools.
   */
  dry?: boolean;
  /**
   * Visible browser window on the machine running the engine.
   * The window is not in the caller's browser page: the deployment host needs a real display, or a
   * virtual one (`xvfb-run -a`) plus VNC/noVNC, for a human to see it.
   */
  headful?: boolean;
  /**
   * Ablation arm (`stub` = scripted fake model, `rules-only` = no model at all). Omit for a real run.
   */
  ablate?: "stub" | "rules-only";
  /**
   * Override the decision provider for this call (laya-onnx, decision-service, a baseline, or an ablation).
   */
  provider?: string;
  /**
   * Skip the data leg.
   */
  noSources?: boolean;
  /**
   * Permit dangerous tool steps; refused unless the deployment set `allowDangerous`.
   */
  dangerous?: boolean;
  /**
   * The engine's middle gate (`--confirm-safe`): with `allowDangerous`, destructive actions are
   * still confirmed per step against their dry-run evidence instead of blanket-approved.
   */
  confirmSafe?: boolean;
  /**
   * P1 experiment switch (engine `--tiered-hint`): an ambiguous-in-tier target hint becomes a
   * SMALLER question to the model (it sees only that tier's candidates instead of the whole pool).
   * Off by default — behaviour byte-identical to before; used for A/B on live apps.
   */
  tieredHint?: boolean;
  /**
   * Walk DEBUG mode for this run (engine `--walk`), default off: `ctx.step` stops reloading the
   * page when its declared `url` re-anchors to the current page (same origin+path; query/hash
   * ignored), so SPA client state survives across steps for single-session walk-throughs and
   * forensics. Cross-page explicit urls and ctx.open/openPage/arrive still navigate. Debug
   * surface only — formal runs keep the re-navigation semantics; the result marks `walk: true`.
   * Mutually exclusive with `dry`.
   */
  walk?: boolean;
  /**
   * Execution budget for this call (engine `--max-steps`), NOT a 1-based step index: the script runs
   * under its own control flow and stops with `budget_exceeded` when the budget is used up
   * (`status=partial`, `verified=false`).
   */
  maxSteps?: number;
  /**
   * Include per-step execution evidence in the result. Defaults to true for the bridge.
   */
  trace?: boolean;
  manualFailFast?: boolean;
  /**
   * Rescue passthrough (engine `--rescue`, design §8 step 5): allow a structured
   * `result.rescue` request to appear on a real human-needed stop. Default off = artifacts
   * byte-identical; the bridge never suspends (stop mode only).
   */
  rescue?: boolean;
  /**
   * Values for declared slots.
   */
  slots?: Record<string, string>;
}
export interface BridgeServiceRunArgs {
  /**
   * App id from {@link AmberFlowService.listApps}.
   */
  app: string;
  /**
   * Only dry-run the flow's call sequence: no browser, no tools.
   */
  dry?: boolean;
  /**
   * Ablation arm (`stub` = scripted fake model, `rules-only` = no model at all). Omit for a real run.
   */
  ablate?: "stub" | "rules-only";
  /**
   * Override the decision provider for this call (laya-onnx, decision-service, a baseline, or an ablation).
   */
  provider?: string;
  /**
   * Skip the data leg.
   */
  noSources?: boolean;
  /**
   * Visible browser window on the machine running the engine.
   * The window is not in the caller's browser page: the deployment host needs a real display, or a
   * virtual one (`xvfb-run -a`) plus VNC/noVNC, for a human to see it.
   */
  headful?: boolean;
  /**
   * Permit dangerous tool steps; refused unless the deployment set `allowDangerous`.
   */
  allowDangerous?: boolean;
  /**
   * The engine's middle gate (`--confirm-safe`): with `allowDangerous`, destructive actions are
   * still confirmed per step against their dry-run evidence instead of blanket-approved.
   */
  confirmSafe?: boolean;
  /**
   * P1 experiment switch (engine `--tiered-hint`): an ambiguous-in-tier target hint becomes a
   * SMALLER question to the model (it sees only that tier's candidates instead of the whole pool).
   * Off by default — behaviour byte-identical to before; used for A/B on live apps.
   */
  tieredHint?: boolean;
  /**
   * Walk DEBUG mode for this run (engine `--walk`), default off: `ctx.step` stops reloading the
   * page when its declared `url` re-anchors to the current page (same origin+path; query/hash
   * ignored), so SPA client state survives across steps for single-session walk-throughs and
   * forensics. Cross-page explicit urls and ctx.open/openPage/arrive still navigate. Debug
   * surface only — formal runs keep the re-navigation semantics; the result marks `walk: true`.
   * Mutually exclusive with `dry`.
   */
  walk?: boolean;
  /**
   * Values for declared slots.
   */
  slots?: Record<string, string>;
  /**
   * Execution budget for this call (engine `--max-steps`), NOT a 1-based step index: the script runs
   * under its own control flow and stops with `budget_exceeded` when the budget is used up
   * (`status=partial`, `verified=false`).
   */
  maxSteps?: number;
  /**
   * Hard wall-clock cap for THIS call, in seconds: the bridge kills the engine child process when the
   * call exceeds it. Defaults to the deployment's `timeoutMs` (900 s — live runs are slow by nature);
   * a long flow (deep tier, many pages) passes a larger value here instead of being killed with all
   * its completed work lost. Integer, 1..{@link RUN_TIMEOUT_MAX_SEC}; a killed run leaves
   * `run-killed.json` in its outDir with the partial evidence.
   */
  timeoutSec?: number;
  /**
   * Include per-step execution evidence in the result. Defaults to true for the bridge.
   */
  trace?: boolean;
  /**
   * Rescue passthrough (engine `--rescue`, design §8 step 5): allow a structured
   * `result.rescue` request to appear on a real human-needed stop. Default off = artifacts
   * byte-identical; the bridge never suspends (stop mode only).
   */
  rescue?: boolean;
}
export const RUN_TOOL_PARAMETERS = {
  app: {
    type: "string",
    required: true,
    description: "App id from `*_apps`.",
  },
  dry: {
    type: "boolean",
    description: "Dry-run the script's call sequence; no browser, no tools.",
  },
  ablate: {
    type: "string",
    description: "Ablation arm for experiments: `stub` (scripted fake model) or `rules-only` (no model). Use only for A/B runs, not routine execution.",
    enum: ["stub", "rules-only"],
  },
  provider: {
    type: "string",
    description: "Override the decision provider for this call: `laya-onnx`, `decision-service`, a baseline or an ablation. Omit to use the configured service or local model.",
  },
  no_sources: {
    type: "boolean",
    description: "Skip the data leg; use already-available data.",
  },
  headful: {
    type: "boolean",
    description: "Show the browser window on the engine host; that host needs a display (or `xvfb-run -a` plus VNC). Headless when omitted.",
  },
  allow_dangerous: {
    type: "boolean",
    description: "Permit dangerous tool steps (dry-run gated). Requires the deployment to enable it.",
  },
  confirm_safe: {
    type: "boolean",
    description: "With `allow_dangerous`, confirm each destructive step against its dry-run evidence instead of blanket-approving.",
  },
  tiered_hint: {
    type: "boolean",
    description: "A/B experiment: when a target hint matches an ambiguous tier, ask the model for that tier's candidates only. Off by default; use for experiments, not routine runs.",
  },
  walk: {
    type: "boolean",
    description: "Walk debug mode: keep one session and skip re-navigation when a step's declared URL is the current page. SPA state then survives across steps, which reproduces state-evolution bugs; formal runs keep re-navigation semantics.",
  },
  slots: {
    type: "array",
    description: "Slot values as `key=value` entries (repeatable), e.g. `date=2026-10-12`.",
    items: { type: "string" },
  },
  max_steps: {
    type: "integer",
    description: "`EXECUTION BUDGET` for this call, counted in steps, not a 1-based start index. When used up the run stops with `budget_exceeded` (status=partial, verified=false).",
  },
  timeout_sec: {
    type: "integer",
    description: "Hard wall-clock cap for this call in seconds; the bridge kills the engine child when exceeded. Raise it for long flows. A killed call leaves `run-killed.json` as partial evidence.",
  },
  trace: {
    type: "boolean",
    description: "Include per-step execution evidence in the result.",
  },
  rescue: {
    type: "boolean",
    description: "Attach a structured `rescue` request to the result when a human is needed. The bridge records the request and never waits for a person; answer it asynchronously by re-running after the human acts or by supplying the missing value.",
  },
} as const;
export const RUN_TOOL_FIELDS: readonly BridgeToolFieldBinding[] = [
  { key: "app", param: "app", },
  { key: "dry", param: "dry", },
  { key: "ablate", param: "ablate", },
  { key: "provider", param: "provider", },
  { key: "noSources", param: "no_sources", },
  { key: "headful", param: "headful", },
  { key: "allowDangerous", param: "allow_dangerous", },
  { key: "confirmSafe", param: "confirm_safe", },
  { key: "tieredHint", param: "tiered_hint", },
  { key: "walk", param: "walk", },
  { key: "slots", param: "slots", collect: "slots", },
  { key: "maxSteps", param: "max_steps", },
  { key: "timeoutSec", param: "timeout_sec", },
  { key: "trace", param: "trace", },
  { key: "rescue", param: "rescue", },
];

export const RUN_SERVICE_FIELDS: readonly BridgeServiceFieldBinding[] = [
  { key: "app" },
  { key: "dry", argvKey: "dry" },
  { key: "ablate", argvKey: "ablate" },
  { key: "provider", argvKey: "provider" },
  { key: "noSources", argvKey: "noSources" },
  { key: "headful", argvKey: "headful" },
  { key: "allowDangerous", argvKey: "dangerous" },
  { key: "confirmSafe", argvKey: "confirmSafe" },
  { key: "tieredHint", argvKey: "tieredHint" },
  { key: "walk", argvKey: "walk" },
  { key: "slots", argvKey: "slots" },
  { key: "maxSteps", argvKey: "maxSteps" },
  { key: "timeoutSec" },
  { key: "trace", argvKey: "trace" },
  { key: "rescue", argvKey: "rescue" },
];

export const RUN_ARGV_FIELDS: readonly BridgeRunArgvField[] = [
  { key: "dry", flag: "--dry", kind: "flag" },
  { key: "headful", flag: "--headful", kind: "flag" },
  { key: "ablate", flag: "--ablate", kind: "value" },
  { key: "provider", flag: "--provider", kind: "provider" },
  { key: "noSources", flag: "--no-sources", kind: "flag" },
  { key: "dangerous", flag: "--allow-dangerous", kind: "flag" },
  { key: "confirmSafe", flag: "--confirm-safe", kind: "flag" },
  { key: "tieredHint", flag: "--tiered-hint", kind: "flag" },
  { key: "walk", flag: "--walk", kind: "flag" },
  { key: "maxSteps", flag: "--max-steps", kind: "value", when: "defined" },
  { key: "trace", flag: "--trace", kind: "flag" },
  { key: "manualFailFast", flag: "--manual-fail-fast", kind: "flag" },
  { key: "rescue", flag: "--rescue", kind: "flag" },
  { key: "slots", flag: "--slot", kind: "repeated" },
];

/** 调用方没给时由 `runApp` 补齐的固定转发（模型不可见）。 */
export const RUN_BRIDGE_DEFAULTS: readonly { readonly key: string; readonly value: boolean }[] = [
  { key: "trace", value: true },
  { key: "manualFailFast", value: true },
];

/** 桥侧校验文案；`{tool}` = `${toolPrefix}_run`。 */
export const RUN_BRIDGE_MESSAGES = {
  "timeoutSec": "amberflow-bridge: {tool} timeout_sec must be an integer in 1..{max} seconds (omit it to use the deployment timeoutMs: {defaultSec} s)",
  "walkDry": "amberflow-bridge: {tool} walk and dry are mutually exclusive — walk is a live-run debug mode (ctx.step keeps SPA state across steps by not re-navigating to the current page), dry only expands the call sequence with no browser",
  "dangerousGate": "amberflow-bridge: this deployment does not permit dangerous tool steps; set Config.allowDangerous=true to allow {tool} with allow_dangerous",
  "slotFormat": "amberflow-bridge: slot {value} must be \"key=value\"",
  "slotDuplicate": "amberflow-bridge: slot {value} was given more than once"
} as const;

/** `timeout_sec` 的防呆上限（秒）。 */
export const RUN_TIMEOUT_MAX_SEC = 7200;

/**
 * `*_pilot` 段——契约 = src/support/run-args-contract.ts 的 PILOT_ARG_FIELDS（同 run 段生成纪律）。
 */

/** `*_pilot` 桥进程 argv 的一个发射项（键域 = BridgePilotArgs；无 provider kind）。 */
export interface BridgePilotArgvField {
  readonly key: keyof BridgePilotArgs;
  readonly flag: string;
  readonly kind: 'flag' | 'value' | 'repeated';
  readonly when?: 'truthy' | 'defined';
}

export interface BridgePilotArgs {
  /**
   * Entry page; the engine opens it inside the hosts envelope (default: its host).
   */
  url: string;
  /**
   * The initiator's goal; the driving question's base text.
   */
  goal: string;
  /**
   * Allowed-host envelope.
   */
  hosts?: string[];
  /**
   * Declared final signal (JSON object text); the engine verifies it, never the model.
   */
  finalSignal?: string;
  /**
   * Driving-step budget, same meaning as the run face's max-steps.
   */
  maxSteps?: number;
  /**
   * Confidence floor override.
   */
  confFloor?: number;
  /**
   * Task-page URL substring for the deterministic off_task_page guard.
   */
  expectUrl?: string;
  /**
   * Pre-declared value bag.
   */
  slots?: Record<string, string>;
  /**
   * Ablation arm selector: whose decision moves each step.
   */
  driver?: "model" | "agent";
  /**
   * Headful switch.
   */
  headful?: boolean;
  /**
   * Bridge-side spawn timeout, never an engine CLI flag.
   */
  timeoutSec?: number;
  /**
   * Fallback playbook (JSONL text) the bridge materializes to the engine's --input file.
   */
  commands?: string;
}
export const PILOT_TOOL_PARAMETERS = {
  url: {
    type: "string",
    required: true,
    description: "Entry page the pilot run opens before the first driving round (http(s) only).",
  },
  goal: {
    type: "string",
    required: true,
    description: "One-line walkthrough goal; the decision model only votes pool refs against it, never generates actions.",
  },
  hosts: {
    type: "array",
    description: "Navigation envelope (defaults to the URL host); redirect stays inside it.",
    items: { type: "string" },
  },
  final_signal: {
    type: "string",
    description: "Final signal spec as JSON text, e.g. '{\"url_contains\":\"/success\"}'. checkSignal must hold for exit 0; absent = drive until budget/inert.",
  },
  max_steps: {
    type: "integer",
    description: "Driving-step budget (default 12, max 200); used up = budget_exceeded handoff.",
  },
  conf_floor: {
    type: "number",
    description: "Confidence floor override in [0,1]; priority: this flag > provider self-report > 0.25. Below it the engine re-asks once wider before any handoff.",
  },
  expect_url: {
    type: "string",
    description: "Task-page URL substring (e.g. '/maps'); when the current URL no longer contains it the pilot stops with `off_task_page` before the next driving step instead of continuing on a drifted page. Omit = no drift guard.",
  },
  slots: {
    type: "array",
    description: "Pre-declared slot values as `k=v` entries for fill/select decisions; both bags empty = needs_value stop, never guessed.",
    items: { type: "string" },
  },
  driver: {
    type: "string",
    description: "Who drives: `model` (default) = the decision model votes each step; `agent` = every step projects bounded candidates and waits for a resume hint, zero model asks.",
    enum: ["model", "agent"],
  },
  headful: {
    type: "boolean",
    description: "Show the browser window (default headless).",
  },
  timeout_sec: {
    type: "integer",
    description: "Hard wall-clock cap for this call in seconds (1-7200); the bridge kills the engine child when exceeded and writes `pilot-killed.json` as partial evidence.",
  },
  commands: {
    type: "string",
    description: "Fallback playbook as JSONL text, one command object per line, e.g. '{\"cmd\":\"resume\",\"hint\":\"Sign in\"}'; the bridge materializes it to `--input` and the engine consumes it line by line at handoff pauses (closed set; a rejected line is a single-line failure).",
  },
} as const;
export const PILOT_TOOL_FIELDS: readonly BridgeToolFieldBinding[] = [
  { key: "url", param: "url", },
  { key: "goal", param: "goal", },
  { key: "hosts", param: "hosts", },
  { key: "finalSignal", param: "final_signal", },
  { key: "maxSteps", param: "max_steps", },
  { key: "confFloor", param: "conf_floor", },
  { key: "expectUrl", param: "expect_url", },
  { key: "slots", param: "slots", collect: "slots", },
  { key: "driver", param: "driver", },
  { key: "headful", param: "headful", },
  { key: "timeoutSec", param: "timeout_sec", },
  { key: "commands", param: "commands", },
];

export const PILOT_ARGV_FIELDS: readonly BridgePilotArgvField[] = [
  { key: "url", flag: "--url", kind: "value" },
  { key: "goal", flag: "--goal", kind: "value" },
  { key: "hosts", flag: "--hosts", kind: "value" },
  { key: "finalSignal", flag: "--final-signal", kind: "value" },
  { key: "maxSteps", flag: "--max-steps", kind: "value", when: "defined" },
  { key: "confFloor", flag: "--conf-floor", kind: "value", when: "defined" },
  { key: "expectUrl", flag: "--expect-url", kind: "value" },
  { key: "slots", flag: "--slot", kind: "repeated" },
  { key: "driver", flag: "--driver", kind: "value" },
  { key: "headful", flag: "--headful", kind: "flag" },
];

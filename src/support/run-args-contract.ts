/**
 * 桥 `*_run` 字段的**共享契约**——一处描述一个 run 参数的四张脸：模型可见 tool 参数、
 * 桥进程 argv、引擎 CLI 旗标、引擎 `ScriptRunOptions` 选项。
 *
 * 为什么需要它：一个字段原先要在五个地方各写一遍（tool schema / `AmberFlowRunArgs` /
 * `runArgs` argv / `app-runner-cli` 的选项表与映射 / 引擎选项），漏一处就是"模型能传但引擎
 * 收不到"的静默降级。契约只有这一份；桥包自带 tsconfig（rootDir=src）不能 import 仓库
 * `src`，所以 `tools/run-args-gen.ts` 把桥需要的子集生成到
 * `integrations/dsh-bridge/src/run-contract.generated.ts`（check in，`npm run run-args:check`
 * 校验过期）；引擎侧（`cli-args` / `app-runner-cli`）直接 import 本模块。
 *
 * 本层是 **L0 纯数据**：只有 type/const，没有 import、没有函数、没有副作用——引擎、工具与
 * 生成器都读它，谁都不许在这里塞运行期行为。
 *
 * 新增一个桥字段 = 在本数组加一条（tool/argv/cli/engine 四块）+ 重新生成；`tool` 缺省 =
 * 引擎/桥内部转发参数（模型不可见），`argv` 缺省 = 不往引擎进程传（桥侧自用）。
 */

/** 模型可见 tool 参数的类型闭集（与 `dsh-tools` 的参数 DSL 对齐）。 */
export type RunToolType = "string" | "boolean" | "integer" | "number" | "array";

/** tool 参数面：模型看得见的类型、必填、枚举、条目与描述（描述逐字进模型提示）。 */
export interface RunToolSpec {
  type: RunToolType;
  required?: true;
  enum?: readonly string[];
  items?: "string";
  /** 模型可见描述；长度预算由 `npm run prompt-hit` 的 bridge_desc 组覆盖。 */
  description: string;
  /** tool 参数的桥侧归集语义：`slots` = 字符串数组 → `Record<string, string>`（其余原样透传）。 */
  collect?: "slots";
}

/** 引擎 CLI 的 parseArgs 条目（key 不带 `--`）。 */
export interface RunCliSpec {
  flag: string;
  type: "string" | "boolean";
  multiple?: true;
}

/** 桥进程 argv 的发射语义。`order` 是 argv 顺序的唯一出处（缺省按字段声明序）。 */
export interface RunArgvSpec {
  /** `runArgs` 参数名；缺省 = 字段 key（例如 allowDangerous 在 `runArgs` 里叫 `dangerous`）。 */
  key?: string;
  flag: string;
  kind: "flag" | "value" | "repeated" | "provider";
  /** value 类字段的发射条件：真值（缺省）或"已定义"（例如 0 也是合法预算）。 */
  when?: "truthy" | "defined";
  /** 桥侧缺省值：调用方没给时由 `runApp` 补齐（模型不可见的固定转发）。 */
  fallback?: boolean;
  order: number;
}

/** 引擎 CLI 值 → `ScriptRunOptions` 选项的映射种类。 */
export type RunEngineMap =
  /** 布尔旗标 → 选项 = 布尔值（原样）。 */
  | "flag"
  /** 布尔旗标 → 仅 true 时写选项（缺省省略 = 引擎侧"没开"）。 */
  | "flag-true"
  /** 字符串旗标 → 选项 = 字符串（缺省省略）。 */
  | "string"
  /** 选项值由入口解析后的上下文提供（如 `--max-steps` 的整数、`--slot` 的槽位袋）。 */
  | "context"
  /** `--no-sources` 取反成 `sources`。 */
  | "sources"
  /** `--headful/--headless` 与配置层默认值合并成 `headful`。 */
  | "headful"
  /** `--confirm-safe/--confirm-unsafe` 与配置层默认值合并成 `confirmSafe`。 */
  | "confirm-safe"
  /** `--tiered-hint` 与配置层默认值合并；关 = 省略（保留引擎的"声明层"判定）。 */
  | "tiered-hint"
  /** `--rescue` 与 `--no-rescue` 互斥门闸；最终 true 才写选项。 */
  | "rescue"
  /** 只进引擎入口流程，不写选项（app/dry/ablate/provider）。 */
  | "none";

export interface RunEngineSpec {
  /** `ScriptRunOptions` / `AppRunOptions` 的属性名；`map:"none"` 时缺省。 */
  option?: string;
  map: RunEngineMap;
}

/** 引擎侧旗标校验：`message` 是逐字报错文案，`{value}` 由调用方代入 `JSON.stringify(原始值)`。 */
export type RunValidationSpec =
  | { kind: "positive-integer"; message: string }
  | { kind: "date"; message: string }
  | { kind: "enum"; message: string };

/** 一个 run 参数的四张脸；tool/argv/cli/engine 都可缺省，缺省含义见字段注释。 */
export interface RunArgField {
  /** 桥侧 camelCase 名（`AmberFlowRunArgs` / `runArgs` 上下文值）。 */
  key: string;
  /** tool 参数名（snake_case）；缺省 = 不对模型暴露。 */
  param?: string;
  /** 桥/服务类型里的 TS 类型文本；缺省由 tool 类型推导（枚举 → 字面量联合）。 */
  tsType?: string;
  tool?: RunToolSpec;
  /** `AmberFlowRunArgs` 字段文档（桥包对外类型面，逐字保留）。 */
  doc?: string;
  cli?: RunCliSpec;
  argv?: RunArgvSpec;
  engine?: RunEngineSpec;
  validate?: RunValidationSpec;
}

/**
 * 契约主体。数组顺序 = tool 参数的声明顺序（模型可见 schema）与引擎读字段的默认序；
 * 桥 argv 顺序只认 `argv.order`。
 */
export const RUN_ARG_FIELDS: readonly RunArgField[] = [
  {
    key: "app",
    param: "app",
    tool: { type: "string", required: true, description: "App id from `*_apps`." },
    doc: "App id from {@link AmberFlowService.listApps}.",
    cli: { flag: "app", type: "string" },
    engine: { map: "none" },
  },
  {
    key: "dry",
    param: "dry",
    tool: { type: "boolean", description: "Dry-run the script's call sequence; no browser, no tools." },
    doc: "Only dry-run the flow's call sequence: no browser, no tools.",
    cli: { flag: "dry", type: "boolean" },
    argv: { flag: "--dry", kind: "flag", order: 1 },
    engine: { map: "none" },
  },
  {
    key: "ablate",
    param: "ablate",
    tool: {
      type: "string",
      enum: ["stub", "rules-only"],
      description:
        "Ablation arm for experiments: `stub` (scripted fake model) or `rules-only` (no model). Use only "
        + "for A/B runs, not routine execution.",
    },
    doc: 'Ablation arm (`stub` = scripted fake model, `rules-only` = no model at all). Omit for a real run.',
    cli: { flag: "ablate", type: "string" },
    argv: { flag: "--ablate", kind: "value", order: 3 },
    engine: { map: "none" },
    validate: { kind: "enum", message: "--ablate 只接受 stub | rules-only（收到 {value}）" },
  },
  {
    key: "provider",
    param: "provider",
    tool: {
      type: "string",
      description:
        "Override the decision provider for this call: `laya-onnx`, `decision-service`, a baseline or an "
        + "ablation. Omit to use the configured service or local model.",
    },
    doc: "Override the decision provider for this call (laya-onnx, decision-service, a baseline, or an ablation).",
    cli: { flag: "provider", type: "string" },
    argv: { flag: "--provider", kind: "provider", order: 4 },
    engine: { map: "none" },
  },
  {
    key: "noSources",
    param: "no_sources",
    tool: { type: "boolean", description: "Skip the data leg; use already-available data." },
    doc: "Skip the data leg.",
    cli: { flag: "no-sources", type: "boolean" },
    argv: { flag: "--no-sources", kind: "flag", order: 5 },
    engine: { option: "sources", map: "sources" },
  },
  {
    key: "headful",
    param: "headful",
    tool: {
      type: "boolean",
      description:
        "Show the browser window on the engine host; that host needs a display (or `xvfb-run -a` plus "
        + "VNC). Headless when omitted.",
    },
    doc:
      "Visible browser window on the machine running the engine.\n"
      + "The window is not in the caller's browser page: the deployment host needs a real display, or a\n"
      + "virtual one (`xvfb-run -a`) plus VNC/noVNC, for a human to see it.",
    cli: { flag: "headful", type: "boolean" },
    argv: { flag: "--headful", kind: "flag", order: 2 },
    engine: { option: "headful", map: "headful" },
  },
  {
    key: "allowDangerous",
    param: "allow_dangerous",
    tool: {
      type: "boolean",
      description: "Permit dangerous tool steps (dry-run gated). Requires the deployment to enable it.",
    },
    doc: "Permit dangerous tool steps; refused unless the deployment set `allowDangerous`.",
    cli: { flag: "allow-dangerous", type: "boolean" },
    argv: { key: "dangerous", flag: "--allow-dangerous", kind: "flag", order: 6 },
    engine: { option: "allowDangerous", map: "flag" },
  },
  {
    key: "confirmSafe",
    param: "confirm_safe",
    tool: {
      type: "boolean",
      description:
        "With `allow_dangerous`, confirm each destructive step against its dry-run evidence instead of "
        + "blanket-approving.",
    },
    doc:
      "The engine's middle gate (`--confirm-safe`): with `allowDangerous`, destructive actions are\n"
      + "still confirmed per step against their dry-run evidence instead of blanket-approved.",
    cli: { flag: "confirm-safe", type: "boolean" },
    argv: { flag: "--confirm-safe", kind: "flag", order: 7 },
    engine: { option: "confirmSafe", map: "confirm-safe" },
  },
  {
    key: "tieredHint",
    param: "tiered_hint",
    tool: {
      type: "boolean",
      description:
        "A/B experiment: when a target hint matches an ambiguous tier, ask the model for that tier's "
        + "candidates only. Off by default; use for experiments, not routine runs.",
    },
    doc:
      "P1 experiment switch (engine `--tiered-hint`): an ambiguous-in-tier target hint becomes a\n"
      + "SMALLER question to the model (it sees only that tier's candidates instead of the whole pool).\n"
      + "Off by default — behaviour byte-identical to before; used for A/B on live apps.",
    cli: { flag: "tiered-hint", type: "boolean" },
    argv: { flag: "--tiered-hint", kind: "flag", order: 8 },
    engine: { option: "tieredHint", map: "tiered-hint" },
  },
  {
    key: "walk",
    param: "walk",
    tool: {
      type: "boolean",
      description:
        "Walk debug mode: keep one session and skip re-navigation when a step's declared URL is the "
        + "current page. SPA state then survives across steps, which reproduces state-evolution bugs; "
        + "formal runs keep re-navigation semantics.",
    },
    doc:
      "Walk DEBUG mode for this run (engine `--walk`), default off: `ctx.step` stops reloading the\n"
      + "page when its declared `url` re-anchors to the current page (same origin+path; query/hash\n"
      + "ignored), so SPA client state survives across steps for single-session walk-throughs and\n"
      + "forensics. Cross-page explicit urls and ctx.open/openPage/arrive still navigate. Debug\n"
      + "surface only — formal runs keep the re-navigation semantics; the result marks `walk: true`.\n"
      + "Mutually exclusive with `dry`.",
    cli: { flag: "walk", type: "boolean" },
    argv: { flag: "--walk", kind: "flag", order: 9 },
    engine: { option: "walk", map: "flag-true" },
  },
  {
    key: "slots",
    param: "slots",
    tsType: "Record<string, string>",
    tool: {
      type: "array",
      items: "string",
      collect: "slots",
      description: "Slot values as `key=value` entries (repeatable), e.g. `date=2026-10-12`.",
    },
    doc: "Values for declared slots.",
    cli: { flag: "slot", type: "string", multiple: true },
    argv: { flag: "--slot", kind: "repeated", order: 14 },
    engine: { option: "slots", map: "context" },
  },
  {
    key: "maxSteps",
    param: "max_steps",
    tool: {
      type: "integer",
      description:
        "`EXECUTION BUDGET` for this call, counted in steps, not a 1-based start index. When used up the "
        + "run stops with `budget_exceeded` (status=partial, verified=false).",
    },
    doc:
      "Execution budget for this call (engine `--max-steps`), NOT a 1-based step index: the script runs\n"
      + "under its own control flow and stops with `budget_exceeded` when the budget is used up\n"
      + "(`status=partial`, `verified=false`).",
    cli: { flag: "max-steps", type: "string" },
    argv: { flag: "--max-steps", kind: "value", when: "defined", order: 10 },
    engine: { option: "maxSteps", map: "context" },
    validate: { kind: "positive-integer", message: "--max-steps 需要正整数（收到 {value}）" },
  },
  {
    key: "timeoutSec",
    param: "timeout_sec",
    tool: {
      type: "integer",
      description:
        "Hard wall-clock cap for this call in seconds; the bridge kills the engine child when exceeded. "
        + "Raise it for long flows. A killed call leaves `run-killed.json` as partial evidence.",
    },
    doc:
      "Hard wall-clock cap for THIS call, in seconds: the bridge kills the engine child process when the\n"
      + "call exceeds it. Defaults to the deployment's `timeoutMs` (900 s — live runs are slow by nature);\n"
      + "a long flow (deep tier, many pages) passes a larger value here instead of being killed with all\n"
      + "its completed work lost. Integer, 1..{@link RUN_TIMEOUT_MAX_SEC}; a killed run leaves\n"
      + "`run-killed.json` in its outDir with the partial evidence.",
    engine: { map: "none" },
  },
  {
    key: "trace",
    param: "trace",
    tool: { type: "boolean", description: "Include per-step execution evidence in the result." },
    doc: "Include per-step execution evidence in the result. Defaults to true for the bridge.",
    cli: { flag: "trace", type: "boolean" },
    argv: { flag: "--trace", kind: "flag", order: 11, fallback: true },
    engine: { option: "captureTraces", map: "flag" },
  },
  {
    key: "rescue",
    param: "rescue",
    tool: {
      type: "boolean",
      description:
        "Attach a structured `rescue` request to the result when a human is needed. The bridge records "
        + "the request and never waits for a person; answer it asynchronously by re-running after the human "
        + "acts or by supplying the missing value.",
    },
    doc:
      "Rescue passthrough (engine `--rescue`, design §8 step 5): allow a structured\n"
      + "`result.rescue` request to appear on a real human-needed stop. Default off = artifacts\n"
      + "byte-identical; the bridge never suspends (stop mode only).",
    cli: { flag: "rescue", type: "boolean" },
    argv: { flag: "--rescue", kind: "flag", order: 13 },
    engine: { option: "rescue", map: "rescue" },
  },
  // ---- 引擎入口/桥内部转发参数：没有 tool 面（模型不可见），仍走同一张表 ----
  {
    key: "today",
    cli: { flag: "today", type: "string" },
    engine: { option: "today", map: "context" },
    validate: { kind: "date", message: "--today 要是 YYYY-MM-DD（拿到 {value}）" },
  },
  {
    key: "emitTrace",
    cli: { flag: "emit-trace", type: "string" },
    engine: { option: "emitTrace", map: "string" },
  },
  {
    key: "replayTrace",
    cli: { flag: "replay", type: "string" },
    engine: { option: "replayTrace", map: "string" },
  },
  {
    key: "manualFailFast",
    cli: { flag: "manual-fail-fast", type: "boolean" },
    argv: { flag: "--manual-fail-fast", kind: "flag", order: 12, fallback: true },
    engine: { option: "manualFailFast", map: "flag" },
  },
];

/**
 * 桥 `*_pilot` 字段的共享契约（PILOTED_WALKTHROUGH §PW3.2：schema 走本生成链）。
 * 同一张四脸表；engine 面校验对着 `src/app/pilot-contract.ts` 的 `PilotOptions` 属性名。
 * `commands`（兜底剧本，JSONL 文本）与 `timeout_sec`（桥侧墙钟）不是引擎 CLI 旗标：
 * commands 由桥物化成临时文件走 `--input`，timeout_sec 只改 spawn 超时——两者只出 tool 面
 *（无 cli/argv/engine），是本数组的合法形状（不得在工具面另手写，否则映射会漏）。
 */
export const PILOT_ARG_FIELDS: readonly RunArgField[] = [
  {
    key: "url",
    param: "url",
    tool: { type: "string", required: true, description: "Entry page the pilot run opens before the first driving round (http(s) only)." },
    doc: "Entry page; the engine opens it inside the hosts envelope (default: its host).",
    cli: { flag: "url", type: "string" },
    argv: { flag: "--url", kind: "value", order: 10 },
    engine: { option: "url", map: "string" },
  },
  {
    key: "goal",
    param: "goal",
    tool: { type: "string", required: true, description: "One-line walkthrough goal; the decision model only votes pool refs against it, never generates actions." },
    doc: "The initiator's goal; the driving question's base text.",
    cli: { flag: "goal", type: "string" },
    argv: { flag: "--goal", kind: "value", order: 20 },
    engine: { option: "goal", map: "string" },
  },
  {
    key: "hosts",
    param: "hosts",
    tool: { type: "array", items: "string", description: "Navigation envelope (defaults to the URL host); redirect stays inside it." },
    doc: "Allowed-host envelope.",
    cli: { flag: "hosts", type: "string" },
    argv: { flag: "--hosts", kind: "value", order: 30 },
    engine: { option: "hosts", map: "string" },
    tsType: "string[]",
  },
  {
    key: "finalSignal",
    param: "final_signal",
    tool: { type: "string", description: "Final signal spec as JSON text, e.g. '{\"url_contains\":\"/success\"}'. checkSignal must hold for exit 0; absent = drive until budget/inert." },
    doc: "Declared final signal (JSON object text); the engine verifies it, never the model.",
    cli: { flag: "final-signal", type: "string" },
    argv: { flag: "--final-signal", kind: "value", order: 40 },
    engine: { option: "finalSignal", map: "string" },
  },
  {
    key: "maxSteps",
    param: "max_steps",
    tool: { type: "integer", description: "Driving-step budget (default 12, max 200); used up = budget_exceeded handoff." },
    doc: "Driving-step budget, same meaning as the run face's max-steps.",
    cli: { flag: "max-steps", type: "string" },
    argv: { flag: "--max-steps", kind: "value", when: "defined", order: 50 },
    engine: { option: "maxSteps", map: "context" },
    validate: { kind: "positive-integer", message: "--max-steps 要是 1..200 的整数（拿到 {value}）" },
  },
  {
    key: "confFloor",
    param: "conf_floor",
    tool: { type: "number", description: "Confidence floor override in [0,1]; priority: this flag > provider self-report > 0.25. Below it the engine re-asks once wider before any handoff." },
    doc: "Confidence floor override.",
    cli: { flag: "conf-floor", type: "string" },
    argv: { flag: "--conf-floor", kind: "value", when: "defined", order: 60 },
    engine: { option: "confFloor", map: "context" },
  },
  {
    key: "slots",
    param: "slots",
    tool: {
      type: "array",
      items: "string",
      collect: "slots",
      description: "Pre-declared slot values as `k=v` entries for fill/select decisions; both bags empty = needs_value stop, never guessed.",
    },
    doc: "Pre-declared value bag.",
    cli: { flag: "slot", type: "string", multiple: true },
    argv: { flag: "--slot", kind: "repeated", order: 70 },
    engine: { option: "slots", map: "context" },
    tsType: "Record<string, string>",
  },
  {
    key: "driver",
    param: "driver",
    tool: {
      type: "string",
      enum: ["model", "agent"],
      description: "Who drives: `model` (default) = the decision model votes each step; `agent` = every step projects bounded candidates and waits for a resume hint, zero model asks.",
    },
    doc: "Ablation arm selector: whose decision moves each step.",
    cli: { flag: "driver", type: "string" },
    argv: { flag: "--driver", kind: "value", order: 80 },
    engine: { option: "driver", map: "string" },
    validate: { kind: "enum", message: "--driver 只接受 model | agent（拿到 {value}）" },
  },
  {
    key: "headful",
    param: "headful",
    tool: { type: "boolean", description: "Show the browser window (default headless)." },
    doc: "Headful switch.",
    cli: { flag: "headful", type: "boolean" },
    argv: { flag: "--headful", kind: "flag", order: 90 },
    engine: { option: "headful", map: "flag" },
  },
  {
    key: "timeoutSec",
    param: "timeout_sec",
    tool: {
      type: "integer",
      description: "Hard wall-clock cap for this call in seconds (1-7200); the bridge kills the engine child when exceeded and writes `pilot-killed.json` as partial evidence.",
    },
    doc: "Bridge-side spawn timeout, never an engine CLI flag.",
  },
  {
    key: "commands",
    param: "commands",
    tool: {
      type: "string",
      description: "Fallback playbook as JSONL text, one command object per line, e.g. '{\"cmd\":\"resume\",\"hint\":\"Sign in\"}'; the bridge materializes it to `--input` and the engine consumes it line by line at handoff pauses (closed set; a rejected line is a single-line failure).",
    },
    doc: "Fallback playbook (JSONL text) the bridge materializes to the engine's --input file.",
  },
];

/** 引擎 CLI 的旗标互斥规则：命中即 exit 2，文案逐字进 stderr。 */
export const RUN_ARG_RULES: readonly {
  kind: "mutually-exclusive";
  flags: readonly string[];
  message: string;
}[] = [
  {
    kind: "mutually-exclusive",
    flags: ["dry", "walk"],
    message: "--walk 与 --dry 互斥：walk 是真跑调试模式（ctx.step 同页重锚不重导航），dry 只展开调用序列、没有浏览器。",
  },
];

/** 桥侧校验文案（生成进桥包；`{tool}` = `${toolPrefix}_run`）。 */
export const RUN_BRIDGE_MESSAGES = {
  timeoutSec:
    "amberflow-bridge: {tool} timeout_sec must be an integer in 1..{max} seconds (omit it to use the "
    + "deployment timeoutMs: {defaultSec} s)",
  walkDry:
    "amberflow-bridge: {tool} walk and dry are mutually exclusive — walk is a live-run debug mode "
    + "(ctx.step keeps SPA state across steps by not re-navigating to the current page), dry only "
    + "expands the call sequence with no browser",
  dangerousGate:
    "amberflow-bridge: this deployment does not permit dangerous tool steps; "
    + "set Config.allowDangerous=true to allow {tool} with allow_dangerous",
  slotFormat: 'amberflow-bridge: slot {value} must be "key=value"',
  slotDuplicate: "amberflow-bridge: slot {value} was given more than once",
} as const;

/** `timeout_sec` 的防呆上限（秒）：更长流程应拆应用，而不是占住一个调用。 */
export const RUN_TIMEOUT_MAX_SEC = 7200;

/** 一个 tool 字段在桥侧的注册项（生成物用它做 tool 参数 → camelCase 的唯一映射）。 */
export interface RunToolFieldBinding {
  key: string;
  param: string;
  collect?: "slots";
}

/** 一个 tool 字段在桥侧的 argv 映射项（字段 key → `runArgs` 参数名）。 */
export interface RunServiceFieldBinding {
  key: string;
  argvKey?: string;
}

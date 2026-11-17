/**
 * 可维护性门禁 · 常量组（constants）
 *
 * 对应 v2.1 治理线 W3（配置/常量出处不统一）：把「配置面读取点」与「调参常量回写」变成
 * 可离线断言的两条纪律。两类断言：
 *
 *   **fail — 配置面裸读**：`src/**` 下 `process.env.<配置键>` 只允许出现在
 *   `src/support/env.ts`（typed getter 是配置面唯一读取点）。env-only 开关
 *   （`AMBERFLOW_BROWSER_CHANNEL` / `AMBERFLOW_RESCUE_SHADOW`，见 env.ts 的 `ENV_ONLY_KEYS`）
 *   同样只允许 env.ts。非配置键的**平台变量**（PATH / NO_COLOR / LOCALAPPDATA / VITEST /
 *   GITHUB_SHA）与 `process.env[...]` 动态下标（`{{env:}}` 占位符）不在 fail 口径内——它们是
 *   运行环境事实/用例数据，不是配置面键；需要新例外时在 `ENV_EXCEPTIONS` 逐条登记理由。
 *
 *   **warn — 调参常量回写**：`src/support/tuning.ts` 收口的常量值在其它 src 文件以**同语义
 *   上下文**出现 → 疑似回写裸数字。纯按值匹配会大量误伤同值不同义（HTTP 400 ≠ 字符预算 400、
 *   动作 5000 ≠ 稳定门 5000、label 40 字符 ≠ 池帽 40 元素、数据腿/ssh 30s ≠ 导航 30s），
 *   因此每个概念带一个语义上下文正则；确认合理但同值的用法登记到 `DIFFERENT_MEANING`（带理由）。
 *
 * 纯离线、零网络；不解析 TS AST（字符串/注释剥离即够，避免把帮助文案/注释当回写）。
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_KEYS } from "../../src/support/config-schema.ts";
import { ENV_ONLY_KEYS } from "../../src/support/env.ts";
import { TUNING_VALUES, type TuningConcept } from "../../src/support/tuning.ts";
import type { Severity } from "./size.ts";

export interface ConstantProblem {
  group: "constants";
  severity: Severity;
  message: string;
}

export interface EnvReadHit {
  /** 仓库相对路径（正斜杠）。 */
  file: string;
  /** 1-based 行号。 */
  line: number;
  /** 命中的配置键 / env-only 键。 */
  key: string;
  text: string;
}

export interface TuningHit {
  file: string;
  line: number;
  concept: TuningConcept;
  value: number;
  text: string;
}

export interface ConstantsSnapshot {
  /** 扫描的 src/*.ts 文件数（0 = 路径异常，判 fail）。 */
  filesScanned: number;
  envReads: EnvReadHit[];
  tuningHits: TuningHit[];
}

export interface ConstantsBaseline {
  /** 白名单外裸读的基线（只许 0；增长即 fail）。 */
  envReads: number;
  /** 疑似调参回写的基线（warn ratchet：新增只提示，不判红）。 */
  tuningHits: number;
}

/** typed getter 所在文件：配置面/env-only 键的唯一读取点。 */
const ENV_READER_FILE = "src/support/env.ts";

/** 显式例外（每条必须有理由）。当前仅 env.ts 自身；新增前先想能否改用 typed getter。 */
const ENV_EXCEPTIONS: ReadonlyArray<{ file: string; reason: string }> = [
  { file: ENV_READER_FILE, reason: "typed getter 是配置面唯一读取点（readString/readInt/... 的默认参数 process.env）" },
];

/**
 * 12 个调参概念的「同语义上下文」正则：token 只在出现这些词的行才算疑似回写。
 * 只用于 warn 判据；豁免按文件+概念登记。
 */
const TUNING_CONCEPTS: ReadonlyArray<{ concept: TuningConcept; context: RegExp }> = [
  { concept: "NAVIGATION_GOTO_TIMEOUT_MS", context: /goto|gotoTimeout|navigation/i },
  { concept: "DECISION_REQUEST_TIMEOUT_MS", context: /decision|systemone|system-one|provider/i },
  { concept: "DONE_POLL_INTERVAL_MS", context: /donePoll|done_poll|pollMs|poll_ms/i },
  { concept: "POOL_CAP_ELEMENTS", context: /MAX_ELEMENTS|actPoolCap|act_pool_cap|POOL_CAP/i },
  { concept: "WIDE_SCAN_POOL_ELEMENTS", context: /WIDE_POOL|wide_scan|wideScan|--wide/i },
  { concept: "WIDE_SCAN_POOL_ELEMENTS_MAX", context: /WIDER_ELEMENTS_MAX|window.?escalation|WIDE_SCAN_POOL_ELEMENTS_MAX/i },
  { concept: "SETTLE_QUIET_MS", context: /quietMs|quiet_ms|settle/i },
  { concept: "SETTLE_TIMEOUT_MS", context: /settle|quiet_ms|DEFAULT_SETTLE/i },
  { concept: "STATE_TEXT_BUDGET_CHARS", context: /stateText|state_text|budget/i },
  { concept: "LAYA_EVIDENCE_CHARS_PER_TOKEN", context: /charsPerToken|CHAR_PER_TOKEN|evidence_truncated|laya.*budget/i },
  { concept: "TOOL_STDERR_TAIL_CAP_CHARS", context: /stderr|TOOL_STDERR/i },
  { concept: "SESSION_IDLE_TIMEOUT_MS", context: /idle/i },
  { concept: "CLI_COMMAND_DEFAULT_TIMEOUT_MS", context: /v\.timeout|--timeout|commandTimeout/i },
];

/**
 * 同值不同义的已确认豁免（file + concept；每条给理由）。
 * config-schema 的 DEFAULT_DECISION_TIMEOUT_MS 是 L0 唯一出处，tuning 常量只是它的别名。
 */
const DIFFERENT_MEANING: ReadonlyArray<{ file: string; concept: TuningConcept; reason: string }> = [
  {
    file: "src/support/config-schema.ts",
    concept: "DECISION_REQUEST_TIMEOUT_MS",
    reason: "L0 配置默认值唯一出处（tuning.DECISION_REQUEST_TIMEOUT_MS 是它的别名，不重复定义数值）",
  },
  {
    file: "src/engine/settle.ts",
    concept: "SETTLE_TIMEOUT_MS",
    reason: "该行 5000 是 quietMs 的上限 clamp 边界（不是 timeout 缺省值；缺省值由 DEFAULT_SETTLE 单源提供）",
  },
];

const CONFIG_KEY_SET: ReadonlySet<string> = new Set(CONFIG_KEYS);
const ENV_ONLY_KEY_SET: ReadonlySet<string> = new Set(ENV_ONLY_KEYS.map((k) => k.key));

/** 数字 token 的源码写法：30000 与 30_000 两种分组写法都算回写。 */
function tokenForms(value: number): string[] {
  const plain = String(value);
  const forms = [plain];
  if (plain.length >= 4) {
    let grouped = "";
    for (let i = 0; i < plain.length; i++) {
      if (i > 0 && (plain.length - i) % 3 === 0) grouped += "_";
      grouped += plain[i];
    }
    if (grouped !== plain) forms.push(grouped);
  }
  return forms;
}

function tokenRegex(value: number): RegExp {
  const alternatives = tokenForms(value).map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\w.])(${alternatives.join("|")})(?![\\w.])`);
}

const TUNING_TOKEN_REGEX: ReadonlyArray<{ concept: TuningConcept; value: number; token: RegExp; context: RegExp }> =
  TUNING_CONCEPTS.map(({ concept, context }) => {
    const value = TUNING_VALUES[concept];
    return { concept, value, token: tokenRegex(value), context };
  });

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/** 剥字符串字面量（保留行结构）：避免把帮助文案/提示词里的数字当回写。 */
function stripStrings(line: string): string {
  return line
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function walkTs(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/node_modules|\.git|dist/.test(full)) continue;
      walkTs(full, out);
      continue;
    }
    if (entry.name.endsWith(".ts")) out.push(full);
  }
}

/** 从内存文件集扫描（自测/正例用）：不碰磁盘。 */
export function scanConstants(files: ReadonlyArray<{ file: string; text: string }>): ConstantsSnapshot {
  const envReads: EnvReadHit[] = [];
  const tuningHits: TuningHit[] = [];
  const envExceptions = new Set(ENV_EXCEPTIONS.map((e) => e.file));
  const differentMeaning = new Set(DIFFERENT_MEANING.map((e) => `${e.file}#${e.concept}`));
  for (const { file, text } of files) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (COMMENT_LINE.test(line)) continue;
      const code = stripStrings(line);
      for (const match of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        const key = match[1]!;
        if (!CONFIG_KEY_SET.has(key) && !ENV_ONLY_KEY_SET.has(key)) continue;
        if (envExceptions.has(file)) continue;
        envReads.push({ file, line: i + 1, key, text: line.trim() });
      }
      for (const { concept, value, token, context } of TUNING_TOKEN_REGEX) {
        if (!token.test(code)) continue;
        if (!context.test(code)) continue;
        if (differentMeaning.has(`${file}#${concept}`)) continue;
        tuningHits.push({ file, line: i + 1, concept, value, text: line.trim() });
      }
    }
  }
  return { filesScanned: files.length, envReads, tuningHits };
}

/** 从仓库工作树扫描 src/**\/*.ts（跳过 tuning.ts 自身）。 */
export function collectConstants(repoRoot: string): ConstantsSnapshot {
  const srcDir = path.join(repoRoot, "src");
  const absolute: string[] = [];
  walkTs(srcDir, absolute);
  const files = absolute
    .map((abs) => path.relative(repoRoot, abs).split(path.sep).join("/"))
    .filter((file) => file !== "src/support/tuning.ts")
    .sort()
    .map((file) => ({ file, text: fs.readFileSync(path.join(repoRoot, file), "utf-8") }));
  return scanConstants(files);
}

/** 判定：裸读 fail（白名单外）；调参回写 warn（带基线 ratchet 提示）。 */
export function evaluateConstants(snapshot: ConstantsSnapshot, baseline: ConstantsBaseline): ConstantProblem[] {
  const problems: ConstantProblem[] = [];
  if (snapshot.filesScanned === 0) {
    problems.push({ group: "constants", severity: "fail", message: "未扫描到任何 src .ts 文件（工作目录/路径异常）" });
  }
  for (const hit of snapshot.envReads) {
    problems.push({
      group: "constants",
      severity: "fail",
      message: `${hit.file}:${hit.line} 裸读 process.env.${hit.key}——配置面读取必须经 src/support/env.ts 的 typed getter`
        + `（readString/readInt/readBool/readEnum）；确属平台事实的例外登记到 tools/maintain/constants.ts 的 ENV_EXCEPTIONS`,
    });
  }
  for (const hit of snapshot.tuningHits) {
    problems.push({
      group: "constants",
      severity: "warn",
      message: `${hit.file}:${hit.line} 疑似回写 tuning 常量 ${hit.concept}（值 ${hit.value}）——改 import src/support/tuning.ts`
        + `；同值不同义请登记 DIFFERENT_MEANING`,
    });
  }
  if (snapshot.tuningHits.length > baseline.tuningHits) {
    problems.push({
      group: "constants",
      severity: "warn",
      message: `调参常量回写新增 ${snapshot.tuningHits.length - baseline.tuningHits} 处（当前 ${snapshot.tuningHits.length} / 基线 ${baseline.tuningHits}）`,
    });
  }
  if (snapshot.envReads.length > baseline.envReads) {
    problems.push({
      group: "constants",
      severity: "fail",
      message: `白名单外裸读 env 增长：${snapshot.envReads.length}（基线 ${baseline.envReads}；基线只许 0）`,
    });
  }
  return problems;
}

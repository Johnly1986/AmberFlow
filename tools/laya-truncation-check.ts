/**
 * `laya-truncation:check` —— laya 证据裁剪（"先裁文本再编码" + `evidence_truncated` 记账）的
 * **确定性离线自测**：fake tokenizer，零 ONNX、零浏览器、零网络。
 *
 * 为什么需要它：`buildSequence` 的三个证据面（head / options / state）各有 token 名额，
 * 超名额时模型看到的证据会被削掉。行为口径是「先按字符预算裁文本、再编码；token 级切片只作
 * 最终安全网」，并且裁剪事实必须一路透出（`buildSequence` → `prepareQuestionSequences` →
 * `PredictResult.evidence_truncated` → provider `ChoiceOutcome`）。本工具用固定输入把这四层
 * 钉死；同时保留一份**参考基线**（token 级切片、无记账）做前后对照——非截断路径的 ids/markers
 * 必须与它逐字节相同，超预算路径必须出现事实。
 *
 * 覆盖：
 *   ① 未超预算：ids/markers 与参考基线 sha256 相同，且无任何截断事实；
 *   ② 长 state：参考基线整段编码后静默裁剪；现实现按字符预算裁文本再编码 + 事实；
 *   ③ 长 option（> 48 token）：参考基线静默保留 48 token；现实现记账并可观察裁剪规模；
 *   ④ 密集 tokenizer（1 token/字符）：字符预算后仍超名额 ⇒ token 安全网兜底，事实记 dropped_tokens；
 *   ⑤ 字符裁剪不切断代理对（前缀/tail 两种模式）；
 *   ⑥ 聚合链：prepareQuestionSequences → aggregateEvidenceTruncation 三面事实与题号；
 *   ⑦ provider 透出：有事实时进 outcome，无事实时该键不出现（其他 provider 形状不变）。
 *
 * 用法：
 *   node --experimental-strip-types tools/laya-truncation-check.ts             # 断言（进本地自测）
 *   node --experimental-strip-types tools/laya-truncation-check.ts --self-test # 额外证明参考基线会红
 * 退出码：0 通过 / 1 断言失败 / 2 用法错误。
 */
import { createHash } from "node:crypto";

import {
  OPTION_TOKEN_BUDGET, buildSequence, renderOptions, serializeState, truncateTextToChars,
  type QuestionDef, type SeqTokenizer, type StateLike,
} from "../src/model/laya-format.ts";
import { aggregateEvidenceTruncation, prepareQuestionSequences } from "../src/model/laya-onnx.ts";
import { layaProvider } from "../src/model/decision-provider.ts";
import { scriptedAgent, type LayaRuntime, type ModelState, type PredictResult } from "../src/model/model.ts";
import type {
  ChoiceOutcome, EvidenceTruncation, ProviderPage,
} from "../src/support/decision-provider-contract.ts";
import { LAYA_EVIDENCE_CHARS_PER_TOKEN } from "../src/support/tuning.ts";

const MAX_LEN = 512;
const HEAD_MAX_LEN = 192;
const USAGE = "usage: node --experimental-strip-types tools/laya-truncation-check.ts [--self-test]";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) return;
  failures += 1;
  console.error(`  ✗ ${name}${detail === undefined ? "" : ` —— ${detail}`}`);
}

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/* ---------------------------------------------------------------- fake tokenizer */

const fnv = (text: string): number => {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

interface RecordingTokenizer extends SeqTokenizer {
  /** 每次 `encode` 收到的文本（按调用顺序；用于证明"模型面只编码裁过的文本"）。 */
  readonly calls: string[];
}

/** 确定性 tokenizer：每 `charsPerToken` 个码点一个 token（`1` = 每字符一个 token）。 */
function makeTokenizer(charsPerToken: number): RecordingTokenizer {
  const calls: string[] = [];
  return {
    maskToken: "[MASK]",
    clsTokenId: 101,
    sepTokenId: 102,
    maskTokenId: 103,
    calls,
    encode(text: string): number[] {
      calls.push(text);
      const codePoints = Array.from(text);
      const ids: number[] = [];
      for (let i = 0; i < codePoints.length; i += charsPerToken) {
        ids.push(1000 + (fnv(codePoints.slice(i, i + charsPerToken).join("")) % 9000));
      }
      return ids;
    },
  };
}

/* ---------------------------------------------------- reference baseline builder */

/**
 * 参考基线：token 级切片、不记账（本工具用来做前后对照与 `--self-test` 的负向证明）。
 * 它只回答"同一 tokenizer 与输入下，未截断路径的 ids/markers 是否逐字节相同"。
 */
function referenceBuildSequence(
  tok: SeqTokenizer,
  state: StateLike,
  q: QuestionDef,
  maxLen = MAX_LEN,
  headMaxLen = HEAD_MAX_LEN,
): { ids: number[]; markers: number[] } {
  const mask = tok.maskToken;
  const opts: string[] = [];
  const crit = q.criteria ?? null;
  if (q.type === "choice") {
    for (const [k, v] of Object.entries((crit ?? {}) as Record<string, unknown>)) {
      opts.push(v === null || v === undefined || v === "" ? k : `${k}: ${String(v)}`);
    }
  }
  const ins = String(q.instructions ?? q.ins ?? "").replaceAll(mask, " ");
  let headIds = tok.encode(`${q.type} question: ${ins}`, { addSpecialTokens: false });
  let optIds: number[][] = [];
  for (let i = 0; i < opts.length; i++) {
    optIds.push([
      tok.maskTokenId,
      ...tok.encode(" " + opts[i]!.replaceAll(mask, " "), { addSpecialTokens: false }).slice(0, 48),
    ]);
  }
  let optBudget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  if (optBudget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    optIds = optIds.map((o) => o.slice(0, per));
    optBudget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  }
  headIds = headIds.slice(0, Math.max(8, optBudget));
  let ids = [tok.clsTokenId, ...headIds, tok.sepTokenId];
  const markers: number[] = [];
  for (const o of optIds) {
    markers.push(ids.length);
    ids = ids.concat(o);
  }
  ids.push(tok.sepTokenId);
  const room = Math.max(0, maxLen - ids.length - 1);
  let st = tok.encode(serializeState(state).replaceAll(mask, " "), { addSpecialTokens: false });
  st = st.slice(0, room);
  ids = ids.concat(st, [tok.sepTokenId]);
  return { ids: ids.slice(0, maxLen), markers: markers.filter((m) => m < maxLen) };
}

/* ------------------------------------------------------------------ fixtures */

const CHOICE: QuestionDef = {
  type: "choice",
  instructions: "pick the next element",
  criteria: { e0: "login", e1: "cart" },
};

const LONG_LABEL = "candidate " + "detail ".repeat(60);
const LONG_OPTION_CHOICE: QuestionDef = {
  type: "choice",
  instructions: "pick",
  criteria: { e0: LONG_LABEL, e1: "b" },
};

const LONG_STATE = "head " + "word ".repeat(1200) + "tail";

/** 序列里 state 面可用的 token 名额：空 state 时序列长度 = 前置部分 + 2（两个 SEP）。 */
function stateRoom(tok: SeqTokenizer, q: QuestionDef): number {
  const emptyLen = buildSequence(tok, "", q, MAX_LEN, HEAD_MAX_LEN).ids.length;
  return MAX_LEN - emptyLen;
}

const allTruncationFalse = (truncation: {
  state: { truncated: boolean }; head: { truncated: boolean }; options: { truncated: boolean };
}): boolean =>
  !truncation.state.truncated && !truncation.head.truncated && !truncation.options.truncated;

/* ------------------------------------------------------------------ case ① */

function caseWithinBudget(): void {
  const currentTok = makeTokenizer(4);
  const referenceTok = makeTokenizer(4);
  const current = buildSequence(currentTok, "goal: click login | title: home", CHOICE, MAX_LEN, HEAD_MAX_LEN);
  const reference = referenceBuildSequence(referenceTok, "goal: click login | title: home", CHOICE, MAX_LEN, HEAD_MAX_LEN);
  check("未超预算：无截断事实（三面全 false）", allTruncationFalse(current.truncation));
  check("未超预算：ids 与参考基线 sha256 相同",
    sha256(current.ids) === sha256(reference.ids), sha256(current.ids));
  check("未超预算：markers 与参考基线 sha256 相同",
    sha256(current.markers) === sha256(reference.markers), sha256(current.markers));
  check("未超预算：整段输入原样进 tokenizer（不预裁）",
    currentTok.calls.includes("goal: click login | title: home"));
}

/** 未超预算输入的确定性扫描：多组选项数/长度/Unicode/head 名额下与参考基线逐字节相同。 */
function caseUntruncatedSweep(): void {
  const labels = ["a", "b", "c", "d", "e", "f", "g"];
  const variants = [
    { instructions: "pick", state: "goal: home", maxLen: 64, headMaxLen: 32, count: 2 },
    { instructions: "pick the next element", state: "goal: cart", maxLen: 128, headMaxLen: 48, count: 4 },
    { instructions: "选择下一个元素", state: "标题: 首页 按钮: 登录", maxLen: 256, headMaxLen: 64, count: 1 },
    { instructions: "pick 😀", state: "🙂 emoji state", maxLen: 512, headMaxLen: 192, count: 7 },
    { instructions: "", state: "", maxLen: 512, headMaxLen: 192, count: 3 },
  ];
  let mismatches = 0;
  let truncatedUnexpectedly = 0;
  for (const variant of variants) {
    const criteria: Record<string, string> = {};
    for (let i = 0; i < variant.count; i++) criteria[`e${i}`] = labels[i % labels.length]!;
    const q: QuestionDef = { type: "choice", instructions: variant.instructions, criteria };
    const current = buildSequence(makeTokenizer(4), variant.state, q, variant.maxLen, variant.headMaxLen);
    const reference = referenceBuildSequence(makeTokenizer(4), variant.state, q, variant.maxLen, variant.headMaxLen);
    if (!allTruncationFalse(current.truncation)) truncatedUnexpectedly += 1;
    if (sha256(current.ids) !== sha256(reference.ids) || sha256(current.markers) !== sha256(reference.markers)) {
      mismatches += 1;
    }
  }
  check(`未超预算扫描（${variants.length} 组）：ids/markers 与参考基线逐字节相同`, mismatches === 0,
    `mismatches=${mismatches}`);
  check("未超预算扫描：无任何截断事实", truncatedUnexpectedly === 0,
    `truncated=${truncatedUnexpectedly}`);
}

/* ------------------------------------------------------------------ case ② */

function caseLongState(): void {
  const currentTok = makeTokenizer(4);
  const referenceTok = makeTokenizer(4);
  const room = stateRoom(currentTok, CHOICE);
  const fullStateTokens = referenceTok.encode(serializeState(LONG_STATE)).length;
  const reference = referenceBuildSequence(referenceTok, LONG_STATE, CHOICE, MAX_LEN, HEAD_MAX_LEN);
  const current = buildSequence(currentTok, LONG_STATE, CHOICE, MAX_LEN, HEAD_MAX_LEN);
  const keptChars = serializeState(LONG_STATE).length - current.truncation.state.droppedChars;
  check("长 state：参考基线整段编码后超名额（静默裁剪）", fullStateTokens > room,
    `full=${fullStateTokens} room=${room}`);
  check("长 state：参考基线没有截断事实字段", !("truncation" in reference));
  check("长 state：现实现记账（state.truncated 且 droppedChars > 0）",
    current.truncation.state.truncated && current.truncation.state.droppedChars > 0,
    JSON.stringify(current.truncation.state));
  check("长 state：字符预算内先裁文本（保留字符数 ≤ 名额 × 常量）",
    keptChars <= room * LAYA_EVIDENCE_CHARS_PER_TOKEN,
    `keptChars=${keptChars} budget=${room * LAYA_EVIDENCE_CHARS_PER_TOKEN}`);
  check("长 state：模型面编码的是裁过的文本（最后一次 encode 长度 = 保留字符数）",
    currentTok.calls.at(-1)!.length === keptChars,
    `last=${currentTok.calls.at(-1)!.length} kept=${keptChars}`);
  check("长 state：char/token=4 下字符预算已足够，不发生 token 安全网",
    current.truncation.state.droppedTokens === 0);
  console.log(`  对照 · 长 state：参考基线保留 ${room} token / 整段 ${fullStateTokens} token（无标记）；`
    + `现实现裁掉 ${current.truncation.state.droppedChars} 字符并标记`);
}

/* ------------------------------------------------------------------ case ③ */

function caseLongOption(): void {
  const currentTok = makeTokenizer(4);
  const referenceTok = makeTokenizer(4);
  const optionText = " " + renderOptions(LONG_OPTION_CHOICE)[0]!;
  const fullOptionTokens = referenceTok.encode(optionText).length;
  const reference = referenceBuildSequence(referenceTok, "short state", LONG_OPTION_CHOICE, MAX_LEN, HEAD_MAX_LEN);
  const current = buildSequence(currentTok, "short state", LONG_OPTION_CHOICE, MAX_LEN, HEAD_MAX_LEN);
  const referenceKept = reference.markers[1]! - reference.markers[0]! - 1;
  const currentKept = current.markers[1]! - current.markers[0]! - 1;
  check("长 option：参考基线静默保留固定 token 上限",
    fullOptionTokens > OPTION_TOKEN_BUDGET && referenceKept === OPTION_TOKEN_BUDGET,
    `full=${fullOptionTokens} kept=${referenceKept}`);
  check("长 option：现实现记账（options.truncated 且 droppedChars > 0）",
    current.truncation.options.truncated && current.truncation.options.droppedChars > 0,
    JSON.stringify(current.truncation.options));
  const keptOptionChars = optionText.length - current.truncation.options.droppedChars;
  check("长 option：模型面编码的是字符预算裁剪后的选项文本",
    currentTok.calls.some((text) => text.startsWith(" e0: ") && text.length === keptOptionChars),
    `keptChars=${keptOptionChars} calls=${currentTok.calls.map((c) => c.length).join(",")}`);
  console.log(`  对照 · 长 option：参考基线保留 ${referenceKept} / 整段 ${fullOptionTokens} token（无标记）；`
    + `现实现保留 ${currentKept} token 并标记 ${current.truncation.options.droppedChars} 字符`);
}

/* ------------------------------------------------------------------ case ④ */

function caseSafetyNet(): void {
  // 1 token/字符：字符预算（名额 × 4 字符）仍会产出 4×名额 token，必须由安全网截断并记账。
  const tok = makeTokenizer(1);
  const room = stateRoom(tok, CHOICE);
  const current = buildSequence(tok, LONG_STATE, CHOICE, MAX_LEN, HEAD_MAX_LEN);
  check("密集 tokenizer：字符预算后仍超名额 ⇒ token 安全网兜底",
    current.truncation.state.droppedTokens > 0 && current.truncation.state.truncated,
    JSON.stringify(current.truncation.state));
  check("密集 tokenizer：安全网把 state 收进名额",
    current.ids.length <= MAX_LEN && room > 0, `ids=${current.ids.length} room=${room}`);
}

/* ------------------------------------------------------------------ case ⑤ */

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function caseSurrogate(): void {
  const text = "ab😀cd";
  const headCut = truncateTextToChars(text, 3, false);
  check("字符裁剪（前缀）：切点落在代理对上时退一位，不产出孤立代理",
    headCut.text === "ab" && !loneSurrogate.test(headCut.text), JSON.stringify(headCut));
  const tailCut = truncateTextToChars(text, 3, true);
  check("字符裁剪（tail）：起点落在低位代理时退一位，不产出孤立代理",
    tailCut.text === "cd" && !loneSurrogate.test(tailCut.text), JSON.stringify(tailCut));
  const untouched = truncateTextToChars(text, text.length, false);
  check("字符裁剪：预算内原样返回（droppedChars=0）",
    untouched.text === text && untouched.droppedChars === 0);
}

/* ------------------------------------------------------------------ case ⑥ */

function caseAccountingChain(): void {
  const tok = makeTokenizer(4);
  const questions = {
    act: {
      type: "choice" as const,
      instructions: "detail ".repeat(400),
      criteria: { e0: LONG_LABEL, e1: "b" },
    },
  };
  const prepared = prepareQuestionSequences(tok, LONG_STATE, questions, MAX_LEN, HEAD_MAX_LEN);
  const facts = prepared[0]!.truncation;
  check("聚合链：prepareQuestionSequences 逐题带出三面事实",
    facts.state.truncated && facts.head.truncated && facts.options.truncated,
    JSON.stringify(facts));
  const aggregate = aggregateEvidenceTruncation(prepared);
  check("聚合链：aggregateEvidenceTruncation 透出三面 + 题号",
    aggregate !== undefined && aggregate.state.truncated && aggregate.head.truncated
      && aggregate.options.truncated && aggregate.questions.join(",") === "act",
    JSON.stringify(aggregate));
  const clean = prepareQuestionSequences(
    makeTokenizer(4), "goal: home",
    { act: { type: "choice", instructions: "pick", criteria: { e0: "login", e1: "cart" } } },
  );
  check("聚合链：未裁剪时不产生 evidence_truncated", aggregateEvidenceTruncation(clean) === undefined);
}

/* ------------------------------------------------------------------ case ⑦ */

interface FakePage extends ProviderPage { }

function fakePage(): FakePage {
  const inner = {
    innerText: async () => "Login page. Cart page.",
    inputValue: async () => "",
  };
  const loc = {
    count: () => 1,
    first: inner,
    all: async () => [],
  };
  return {
    url: "https://example.test/",
    title: async () => "Home",
    locator: () => loc,
  };
}

const FAKE_EVIDENCE: EvidenceTruncation = {
  state: { truncated: true, dropped_chars: 120, dropped_tokens: 3 },
  head: { truncated: false, dropped_chars: 0, dropped_tokens: 0 },
  options: { truncated: true, dropped_chars: 20, dropped_tokens: 1 },
  questions: ["act"],
};

function fakeRuntime(result: PredictResult): LayaRuntime {
  return {
    async load() {
      return scriptedAgent(() => undefined);
    },
    embedFnFromAgent() {
      return null;
    },
    async predictShortlist() {
      return result;
    },
  };
}

async function pickOutcome(result: PredictResult): Promise<ChoiceOutcome> {
  const provider = layaProvider({
    runtime: fakeRuntime(result),
    agentFor: async () => ({ agent: scriptedAgent(() => undefined), embedFn: null }),
  });
  return provider.pick({
    goal: "open login",
    page: fakePage(),
    elems: {
      e0: { tag: "button", label: "Login" },
      e1: { tag: "button", label: "Cart" },
    },
    forbidden: new Set<string>(),
    notes: null,
    narrow: null,
    k: 8,
  });
}

function answerResult(evidence?: EvidenceTruncation): PredictResult {
  const result: PredictResult = {
    answers: { act: { choice: "e0", probabilities: { e0: 0.9, e1: 0.1 }, confidence: 0.9 } },
    shortlist: { act: { passthrough: true } },
  };
  if (evidence !== undefined) result.evidence_truncated = evidence;
  return result;
}

async function caseProviderOutcome(): Promise<void> {
  const withFacts = await pickOutcome(answerResult(FAKE_EVIDENCE));
  check("provider 透出：裁剪事实进 ChoiceOutcome.evidence_truncated",
    sha256(withFacts.evidence_truncated) === sha256(FAKE_EVIDENCE),
    JSON.stringify(withFacts.evidence_truncated));
  const withoutFacts = await pickOutcome(answerResult());
  check("provider 透出：无裁剪时该键不出现（其他 provider 形状不变）",
    !("evidence_truncated" in withoutFacts));
}

/* ------------------------------------------------------------ reference proof */

/** 参考基线在"超预算必须记账"的期望下应红的项数（`--self-test` 用它证明断言有牙）。 */
function referenceSilentDrops(): { missingFacts: boolean; droppedStateTokens: boolean; droppedOptionTokens: boolean } {
  const tok = makeTokenizer(4);
  const room = stateRoom(tok, CHOICE);
  const fullStateTokens = tok.encode(serializeState(LONG_STATE)).length;
  const stateRef = referenceBuildSequence(makeTokenizer(4), LONG_STATE, CHOICE, MAX_LEN, HEAD_MAX_LEN);
  const optionRef = referenceBuildSequence(makeTokenizer(4), "short state", LONG_OPTION_CHOICE, MAX_LEN, HEAD_MAX_LEN);
  const fullOptionTokens = makeTokenizer(4).encode(" " + LONG_LABEL).length;
  return {
    missingFacts: !("truncation" in stateRef) && !("truncation" in optionRef),
    droppedStateTokens: fullStateTokens > room,
    droppedOptionTokens: fullOptionTokens > OPTION_TOKEN_BUDGET
      && optionRef.markers[1]! - optionRef.markers[0]! - 1 === OPTION_TOKEN_BUDGET,
  };
}

function selfTest(): void {
  const silent = referenceSilentDrops();
  check("--self-test：参考基线在超预算输入上缺少截断事实（断言有牙）", silent.missingFacts);
  check("--self-test：参考基线在长 state 上确实发生静默 token 裁剪", silent.droppedStateTokens);
  check("--self-test：参考基线在长 option 上确实发生静默 token 裁剪", silent.droppedOptionTokens);
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const unknown = argv.filter((a) => a !== "--self-test");
  if (unknown.length > 0) {
    console.error(`unknown argument(s): ${unknown.join(" ")}\n${USAGE}`);
    return 2;
  }
  const silent = referenceSilentDrops();
  console.log(`  对照 · 参考基线（token 级切片、无记账）：缺事实=${silent.missingFacts}`
    + ` 长 state 静默裁剪=${silent.droppedStateTokens} 长 option 静默裁剪=${silent.droppedOptionTokens}`);
  caseWithinBudget();
  caseUntruncatedSweep();
  caseLongState();
  caseLongOption();
  caseSafetyNet();
  caseSurrogate();
  caseAccountingChain();
  await caseProviderOutcome();
  if (argv.includes("--self-test")) selfTest();
  if (failures > 0) {
    console.error(`laya-truncation:check: ${failures}/${checks} assertion(s) failed`);
    return 1;
  }
  console.log(`laya-truncation:check: ${checks} assertions passed (fake tokenizer; no ONNX/browser/network)`);
  return 0;
}

process.exit(await main());

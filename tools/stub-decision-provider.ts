/**
 * 确定性决策桩（characterization lane 专用）：按剧本回答 choice，零网络、零模型、可回放。
 *
 * 为什么需要它：引擎的询问路径（规则分支/窄问/宽扫/升级/裁决/族修复）只在**真 provider 在场**
 * 时才分叉；用不可达 provider 只能测降级路径，测不到这些分支。本桩把"provider 回答什么"变成
 * 纯函数输入，从而把引擎的行为差异钉在可比投影上。
 *
 * 纪律：`ChoiceRequest.forbidden` 是**活 Set**（调用方会在重抽池/宽扫时清空重填），`notes`
 * 与 `elems` 也可能被复用——快照必须在 `pick()` 入口**立刻拍平**，绝不存引用。
 */
import type {
  ChoiceOutcome, ChoiceRequest, DecisionProvider, ProviderCapabilities,
} from "../src/support/decision-provider-contract.ts";

export type StubScoreKind = ProviderCapabilities["score_kind"];

/** 一次桩回答：省略 `ref` = 取第一个未禁选候选；`ref: null` = 弃权（shape "none"）。 */
export interface StubTurn {
  ref?: string | null;
  score?: number;
  scoreKind?: StubScoreKind;
  probs?: Record<string, number>;
  /** true = 全池询问（shape full）；false = 子集询问（shape shortlist）。 */
  passthrough?: boolean;
  options?: number;
  /** 模型**显式弃权**（与"没拿到选择"分开；两臂投影与 handoff evidence 依赖它）。 */
  abstained?: boolean;
}

/** `pick()` 入口的请求快照（可比投影；用于 golden 与双臂差分）。 */
export interface StubRequestSnapshot {
  seq: number;
  goal: string;
  url: string;
  narrow: string[] | null;
  /** 本轮实际的选项数上限（`ChoiceRequest.k`；provider 可以忽略，但投影要如实记）。 */
  k: number;
  candidates: Array<{ ref: string; tag: string; label: string }>;
  forbidden: string[];
  notes: Record<string, string> | null;
}

/** 一次桩回答的**返回投影**（与请求快照一一对应；golden 只钉这个形状）。 */
export interface StubResponseSnapshot {
  ref: string | null | undefined;
  score: number;
  scoreKind: StubScoreKind;
  signals: { pTop1: number | null; pTop2: number | null; margin: number | null };
  options: number;
  passthrough: boolean;
  probs: Record<string, number>;
}

export interface StubProvider {
  readonly provider: DecisionProvider;
  readonly requests: StubRequestSnapshot[];
  readonly responses: StubResponseSnapshot[];
  reset(): void;
}

const STUB_NAME = "characterization-stub";

/** 造一个按剧本回答的 provider。`script` 收到请求快照与序号，返回该轮的答案。 */
export function makeStubProvider(
  script: (snap: StubRequestSnapshot) => StubTurn,
  capabilities: Partial<ProviderCapabilities> = {},
): StubProvider {
  const requests: StubRequestSnapshot[] = [];
  const responses: StubResponseSnapshot[] = [];
  const provider: DecisionProvider = {
    name: STUB_NAME,
    version: "characterization-1",
    capabilities: {
      choice: true, risk: false, done: false, shortlist: true,
      score_kind: "calibrated_prob", context: "none", ...capabilities,
    },
    async pick(req: ChoiceRequest): Promise<ChoiceOutcome> {
      const snap = snapshotOf(req, requests.length);
      requests.push(snap);
      const turn = script(snap);
      const allowed = snap.candidates.filter((c) => !snap.forbidden.includes(c.ref));
      const ref = turn.ref === undefined ? (allowed[0]?.ref ?? null) : turn.ref;
      const probs = turn.probs ?? (ref === null ? {} : { [ref]: Math.max(0, Math.min(1, turn.score ?? 0.5)) });
      const values = Object.values(probs).sort((a, b) => b - a);
      const out: ChoiceOutcome = {
        ref,
        score: turn.score ?? (values[0] ?? 0),
        scoreKind: turn.scoreKind ?? "calibrated_prob",
        signals: {
          pTop1: values[0] ?? null,
          pTop2: values[1] ?? null,
          margin: values.length >= 2 ? values[0]! - values[1]! : null,
        },
        options: turn.options ?? allowed.length,
        passthrough: turn.passthrough ?? true,
        probs: { ...probs },
        ...(turn.abstained === true ? { abstained: true as const } : {}),
      };
      responses.push({ ...out, signals: { ...out.signals }, probs: { ...out.probs } });
      return out;
    },
  };
  return { provider, requests, responses, reset: () => { requests.length = 0; responses.length = 0; } };
}

/** 请求快照：活集合/活对象一律立刻拍平（见文件头纪律）。 */
function snapshotOf(req: ChoiceRequest, seq: number): StubRequestSnapshot {
  return {
    seq,
    goal: req.goal,
    url: pageUrlOf(req),
    narrow: req.narrow === null ? null : [...req.narrow],
    k: req.k,
    candidates: Object.entries(req.elems).map(([ref, e]) => ({
      ref, tag: String(e.tag ?? ""), label: String(e.label ?? ""),
    })),
    forbidden: Array.from(req.forbidden),
    notes: req.notes === null ? null : { ...req.notes },
  };
}

/** 页面 URL（provider 面只保证有 `url()`；失败不影响快照语义）。 */
function pageUrlOf(req: ChoiceRequest): string {
  try {
    const u = req.page.url;
    return typeof u === "function" ? u.call(req.page) : String(u);
  } catch {
    return "";
  }
}

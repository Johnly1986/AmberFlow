/**
 * **页面上下文与条件化候选**（S0-v2 实测的单一出处，也是 S2 ③ 运行期接线的一环）。
 *
 * 为什么有这个模块：把提名题面从"一句孤立的描述"
 * 变成"这一步开始时的页面 + 按页面条件化的候选"后，同一个决策模型在 S0 考卷上从 24.8% → 63.6%
 * （只补页面状态）→ 88.5%（候选也条件化）；跨实现歧义组 7.2% → 92.8%。
 * **实验台与运行期必须共用这一份构造**：改措辞/改摘要 = 换实验，两边一起变。
 *
 * 边界：这里只做**只读摘要**（URL/标题/正文 240 字/控件能力分组），不写页面、不读站点知识；
 * 控件分类走 `extraction.elemFamily()`（与执行器同一判据）。
 */
import { elemFamily, extractElements, urlOf, type ElemPool } from "../engine/extraction.ts";

/** 一步**开始时**的页面状态（只读快照；`captureStateView` 开关才采）。 */
export interface StepStateView {
  url: string;
  title: string;
  /** 正文开头一段（决策模型 `main_text` 的形状；压到 240 字，别把整页塞进题面）。 */
  text: string;
  /** 本页可交互控件的**能力摘要**（"页面有什么"的紧凑视图，不是站点知识）。 */
  affordances: {
    /** 文本输入框（fill 族）。 */
    text_inputs: string[];
    selects: string[];
    /** 复选框 / 单选框（check 族）。 */
    checkboxes: string[];
    /** 可点击元素（click 族）。 */
    clickables: string[];
    /** 带价格形态文本的元素数（list_pick 的页面线索）。 */
    prices: number;
  };
}

const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 抓一步开始时的页面状态（只读）。页面瞬态/提取失败一律**如实留空**，绝不编。
 * 调用方拿不到 url/title 时应当把这一步当作"没有上下文"（S0 的教训：没有上下文就别问）。
 */
export async function captureStepStateView(
  page: Parameters<typeof extractElements>[0],
): Promise<StepStateView> {
  const out: StepStateView = {
    url: (() => { try { return urlOf(page as never); } catch { return ""; } })(),
    title: "",
    text: "",
    affordances: { text_inputs: [], selects: [], checkboxes: [], clickables: [], prices: 0 },
  };
  try { out.title = await (page as unknown as { title(): Promise<string> }).title(); } catch { /* 留空 */ }
  try {
    const body = await (page as unknown as { evaluate(expression: string): Promise<unknown> })
      .evaluate("document.body ? document.body.innerText.replace(/\\s+/g, ' ').trim() : ''");
    out.text = clipText(String(body ?? ""), 240);
  } catch { /* 留空 */ }
  try {
    const elems: ElemPool = await extractElements(page);
    const push = (arr: string[], label: string): void => {
      const l = label.trim();
      if (l && arr.length < 8 && !arr.includes(l)) arr.push(clipText(l, 40));
    };
    for (const e of Object.values(elems)) {
      const label = String(e.label ?? "");
      switch (elemFamily(e)) {
        case "fill": push(out.affordances.text_inputs, label); break;
        case "select": push(out.affordances.selects, label); break;
        case "check": push(out.affordances.checkboxes, label); break;
        default: push(out.affordances.clickables, label);
      }
      if (/[¥￥]\s*\d|\d+\s*元|price/i.test(label)) out.affordances.prices += 1;
    }
  } catch { /* 提取失败：留空 */ }
  return out;
}

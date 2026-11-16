/**
 * Browser quick-action picker built on laya — TS twin of `layaapp/picker.py`.
 *
 *   browser (extension / Playwright) --extract--> compact page-state JSON
 *     --> laya choice question (which action?)
 *     --> noul guard questions (safe to auto-execute?)
 *     --> confidence gate (auto-run or show human picker)
 *     --> executor (Playwright click)
 *
 * The model call goes through the installable runtime seam (`model.ts`), so this
 * module never imports onnxruntime.
 */
import { getLayaRuntime, type ChoiceAnswer, type NoulAnswer, type PredictResult, type Question } from "../model/model.ts";
import { PICKER_ACTION_INSTRUCTIONS, PICKER_ATTACK_INSTRUCTIONS, PICKER_IRREVERSIBLE_INSTRUCTIONS } from "../prompts/model-prompts.ts";

/**
 * name -> (human description, css selector for execution)。
 *
 * LEGACY 例外（P0-0.4 `model` 组显式标注）：本表是**某电商演示页的动作目录**，
 * 描述/selector 里带业务专名（add-to-cart / checkout / coupon…）。三条**指令文本**
 * 已迁到 `src/prompts/model-prompts.ts`（唯一出处）；本表属于已知 legacy 数据，
 * 产品化时应改为 meta/数据声明（不在 P0 批范围），因此 model 组的"无站点专名"
 * 扫描面限定在 `src/prompts/**`，并要求本注释存在。
 */
export const ACTIONS: Record<string, [string, string]> = {
  add_to_cart: ["add the currently viewed product to the shopping cart", "button[data-test='add-to-cart']"],
  checkout: ["pay for the items in the cart and complete the order", "a[data-test='checkout']"],
  open_cart: ["view the current shopping cart contents", "a[data-test='cart-link']"],
  search: ["type a query into the search box and search", "input[data-test='search-box']"],
  apply_coupon: ["enter a discount coupon code at checkout", "input[data-test='coupon']"],
  product_details: ["open the full detail page of the viewed product", "a[data-test='product-title']"],
  change_quantity: ["increase or decrease item quantity in the cart", "select[data-test='qty']"],
  contact_support: ["open customer support chat", "button[data-test='support']"],
  back_to_home: ["navigate back to the site home page", "a[data-test='logo']"],
};

/** Actions that must never auto-execute; always confirm with the human. */
export const DESTRUCTIVE = new Set(["checkout", "apply_coupon"]);

export function buildQuestions(): Record<string, Question> {
  return {
    action: {
      type: "choice",
      instructions: PICKER_ACTION_INSTRUCTIONS,
      criteria: Object.fromEntries(Object.entries(ACTIONS).map(([name, [desc]]) => [name, desc])),
    },
    // Guard 1: irreversible actions (pay / apply codes) need a human in the loop.
    irreversible: {
      type: "noul",
      instructions: PICKER_IRREVERSIBLE_INSTRUCTIONS,
      criteria: { true: "payment or irreversible", false: "safe to retry" },
    },
    // Guard 2: the page text is untrusted web content -- check for injection.
    page_attack: {
      type: "noul",
      instructions: PICKER_ATTACK_INSTRUCTIONS,
    },
  };
}

export interface PickDecision {
  action: string;
  probabilities: Record<string, number>;
  selector: string;
  auto_execute: boolean;
  reason: string | null;
  guards: { attack_p: number; irreversible_p: number; confidence: number };
  candidates: Array<{ label: string; probability: number; selector: string }>;
}

export class QuickActionPicker {
  agent: unknown;
  questions: Record<string, Question>;
  conf_threshold: number;
  attack_threshold: number;
  irreversible_threshold: number;

  /**
   * attack_threshold=0.95 is measured, not guessed: on real DOM text the base
   * checkpoint scores benign pages p=0.78-0.90 and a real injection p=1.00 (see
   * tune_guard.py). The irreversible gate became a parameter in the TS port's
   * parent revision — it used to be a bare 0.5 at the decision site.
   */
  constructor(agent: unknown, confidenceThreshold = 0.6, attackThreshold = 0.95,
              irreversibleThreshold = 0.5) {
    this.agent = agent;
    this.questions = buildQuestions();
    this.conf_threshold = confidenceThreshold;
    this.attack_threshold = attackThreshold;
    this.irreversible_threshold = irreversibleThreshold;
  }

  static async load(modelId = "convaiinnovations/laya", confidenceThreshold = 0.6,
                    attackThreshold = 0.95, irreversibleThreshold = 0.5): Promise<QuickActionPicker> {
    const agent = await getLayaRuntime().load(modelId);
    return new QuickActionPicker(agent, confidenceThreshold, attackThreshold, irreversibleThreshold);
  }

  async pick(state: Record<string, unknown>): Promise<PickDecision> {
    const runtime = getLayaRuntime();
    const res: PredictResult = await runtime.predictShortlist(
      this.agent as never, state, this.questions,
      { embedFn: runtime.embedFnFromAgent(this.agent as never), k: 8 });
    const act = res.answers.action as ChoiceAnswer;
    const attack = (res.answers.page_attack as NoulAnswer).noul;
    const irreversible = (res.answers.irreversible as NoulAnswer).noul;

    const decision: PickDecision = {
      action: act.choice,
      probabilities: act.probabilities,
      selector: ACTIONS[act.choice]![1],
      auto_execute: false,
      reason: null,
      guards: { attack_p: attack, irreversible_p: irreversible, confidence: act.confidence },
      candidates: Object.entries(act.probabilities)
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([label, probability]) => ({ label, probability, selector: ACTIONS[label]![1] })),
    };
    if (attack >= this.attack_threshold) {
      decision.reason = `blocked: suspected prompt injection on page (p=${attack.toFixed(2)})`;
    } else if (act.confidence < this.conf_threshold) {
      const top = Object.entries(act.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
      decision.reason = `low confidence ${act.confidence.toFixed(2)} < ${this.conf_threshold} `
        + `-- show human picker, top candidates: ${JSON.stringify(top)}`;
    } else if (DESTRUCTIVE.has(act.choice) || irreversible >= this.irreversible_threshold) {
      decision.reason = "destructive/irreversible -- requires user confirmation";
    } else {
      decision.auto_execute = true;
    }
    return decision;
  }

  /** Playwright execution path. */
  async execute(decision: PickDecision, page: { click(selector: string): Promise<void> }): Promise<void> {
    if (!decision.auto_execute) {
      console.log(`  [HOLD] ${decision.reason}`);
      return;
    }
    console.log(`  [CLICK] ${decision.selector}`);
    await page.click(decision.selector);
  }
}

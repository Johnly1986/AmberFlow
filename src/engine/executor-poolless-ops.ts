/**
 * 池外回退面的**单动作分派与执行**（`actOnce` 在 `el === null` 时调用；从执行器动作模块切出）。
 *
 * 为什么需要独立出口：解析面（`#id` live-DOM 直查 / A3 DOM 回退合成行 / AX 回退）按身份
 * 寻址并给 locator，但合成行不是池行，执行面拿不到 `Elem`。执行层必须以 locator 原语执行
 * **请求的那个 op**：fill/select/hover 若落到点击原语，值不会写入、指针也不会移动，却会真的
 * 在页面上打一枪（动作面与请求面不一致 = 误动作）。本模块只补执行面的 op 分派：
 *   - click / check 保持既有 `clickPoollessTarget`（祖先接住点击时内部重定向）；
 *   - fill / select / hover 的语义与 `_executeElement` 对应分支一致（值只来自声明绑定，
 *     缺失即 `needs_value`；select 先 label（短探测）后 value；hover 只移指针）；
 *   - 其余 op（drag / clickAt / upload / 未知）一律结构化 `action_unsupported`，绝不退化成点击。
 *
 * 不新增解析链、不改池内成功路径：池行仍走 `_executeElement`，本模块只在 `el === null`
 * 的池外回退分支被调用。
 */
import { clickPoollessTarget } from "./executor-actionability.ts";
import { describeActionError, firstLoc } from "./executor-pure.ts";
import { type AnyLoc, type AnyPage } from "./executor-types.ts";
import type { BrowserMiddleware } from "./executor.ts";

/** 池外回退单动作的 `[how, arg]`（与 `_executeElement` 返回元组同形；`how` 进 actOnce 的 ok 闭集）。 */
export type PoollessOpResult = [string, unknown];

/** 声明给池外回退单动作的值绑定（与 `actOnce` 的 bind 参数同形；`byValue` = 已按值解出的 option）。 */
export interface PoollessBind {
  value: unknown;
  byValue?: boolean;
}

/**
 * `actOnce` 的池外回退分派：click/check 走既有点击原语（含可动作祖先重定向），其余 op 交给
 * `executePoollessOp`。动作抛错不在这里吞——与池内动作同一条路，由 `actOnce` 落结构化
 * `action_failed`。
 */
export async function executePoollessAction(
  mw: BrowserMiddleware,
  page: AnyPage,
  loc: AnyLoc,
  op: string,
  bind?: PoollessBind | null,
): Promise<PoollessOpResult> {
  if (op === "click" || op === "check") {
    await clickPoollessTarget(mw, page, loc);
    return ["clicked", null];
  }
  return await executePoollessOp(loc, op, bind);
}

/**
 * 对一个**已定位但无池行**的元素执行单动作。
 *
 * 纪律：投递前不猜值、失败不抛裸栈（动作抛错 → 结构化 `action_failed`，与池内同一停因面）；
 * 不支持的 op 在页面动作发生前就返回，调用方据此报结构化停因而非"点了再说"。
 */
export async function executePoollessOp(
  loc: AnyLoc,
  op: string,
  bind?: PoollessBind | null,
): Promise<PoollessOpResult> {
  const target = firstLoc(loc);
  if (op === "fill") {
    if (bind === undefined || bind === null || bind.value === undefined || bind.value === null) {
      return ["needs_value", null];
    }
    try {
      await target.fill(String(bind.value));
    } catch (e) {
      return ["action_failed", describeActionError(e)];
    }
    return ["filled", bind.value];
  }
  if (op === "select") {
    if (bind === undefined || bind === null || bind.value === undefined || bind.value === null) {
      return ["needs_value", null];
    }
    try {
      // 与 `_executeElement` 的 select 分支同序：声明式按值绑定直接选；否则先试 label
      // （短探测——slot 常给机器值，label 探测预期落空，不该按 30s 缺省付），再按 value。
      if (bind.byValue === true) {
        await target.selectOption({ value: String(bind.value) }, { timeout: 5000 });
      } else {
        try {
          await target.selectOption({ label: String(bind.value) }, { timeout: 1500 });
        } catch {
          await target.selectOption({ value: String(bind.value) }, { timeout: 5000 });
        }
      }
    } catch (e) {
      return ["action_failed", describeActionError(e)];
    }
    return ["filled", bind.value];
  }
  if (op === "hover") {
    if (typeof target.hover !== "function") return ["action_unsupported", "locator has no hover"];
    try {
      await target.hover({ timeout: 5000 });
    } catch (e) {
      return ["action_failed", describeActionError(e)];
    }
    return ["hovered", null];
  }
  return ["action_unsupported",
    `out-of-pool target cannot execute op ${JSON.stringify(op)}`
    + " — supported ops here are fill/select/hover (click/check go through the click fallback); no action was taken"];
}

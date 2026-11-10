/**
 * A3 范围控件（range slider）原语——把"设一个值"落成三条**真实交互策略**，并给出
 * 结构化成败，绝不假装成功。
 *
 * 为什么不是一句 `fill()`：范围控件在真实页面上有三种形态，动作面完全不同——
 *   1. 原生 `<input type="range">`：DOM 值可写（fill，必要时补发 input/change 事件）；
 *   2. `role="slider"` ARIA 手柄：很多站点只实现键盘（Home/ArrowRight），点不出值；
 *   3. 自绘指针手柄：只有 mousedown/mousemove 会更新，且**手柄元素自身可能是 0×0**
 *      （视觉手柄在伪元素/背景里）——此时必须用"最近有尺寸祖先"的 bbox 定位。
 * 三条策略按"最不依赖页面实现"的顺序尝试，每次都用**页面自己的值事实**（aria-valuenow /
 * input.value）校验；三道都失败 = `slider_not_settable`（不抛裸栈、不返回假 achieved）。
 *
 * 本模块不解析目标 hint（执行器负责），只接收已定位的 locator + page，因此可被
 * `mw.setRange` 与将来的其它调用方共用；也不新增 command op。
 */

export type RangeValue = { value: number } | { percent: number };

export interface RangeOptions {
  /** 成功判定的数值容差（缺省 0.5：整数滑块的指针落点不可能像素级精确）。 */
  tolerance?: number;
  /** 总超时（毫秒；缺省 10000）——不可设置的 slider 必须**限时**失败，不能挂住流程。 */
  timeoutMs?: number;
}

export type RangeStrategy = "fill" | "keyboard" | "pointer";

/** task-21/1a：键盘策略收敛失败的可判别原因（probe——进 RangeOutcome 与停因 reason）。 */
export type RangeProbe = "value_unreadable" | "home_ignored" | "lattice_unreachable";

export interface RangeOutcome {
  ok: boolean;
  achieved?: number;
  strategy?: RangeStrategy;
  stopCode?: string;
  reason?: string;
  /**
   * task-21/1a：调用方**请求的原始值**（`{value}` 未折算/未钳制；`{percent}` 为折算后目标）。
   * accurate 恒按 requested 判——修复「越界请求被钳到值域后按钳制值报 accurate:true」的
   * 假成功（违反红线③）。
   */
  requested?: number;
  /** task-21/1a：越界请求被拒绝时，记录引擎**拒绝采用**的钳制值（零动作证据链）。 */
  clamped_from?: number;
  /** task-21/1a：键盘策略收敛失败的可判别原因（value_unreadable|home_ignored|lattice_unreachable）。 */
  probe?: RangeProbe;
  /**
   * S1 effect 读回（页面值事实读回成功才出现）：
   *   - `applied`：控件当前值已经是目标（含“本来就在目标上”的如实成功）；
   *   - `accurate`：**精确语义（task-21/1a 收紧）——achieved === requested**（requested 值
   *     真实在控件上）。容差（缺省 max(0.5, step/2)）只用于交互过程的收敛判定，不再用于
   *     accurate 判定——「容差内但非请求值」如实报 accurate:false（achieved 如实带出）。
   *   - 旧行为（accurate 按钳制值/容差判）已废除——1a 行为变更，CHANGELOG 记录。
   * 失败路径也如实给 false——不把“动作没抛错”当成“值设上了”。
   */
  applied?: boolean;
  accurate?: boolean;
  /** 本次的目标数值（percent 已按 min/max 折算；读回对账用）。 */
  target?: number;
}

interface SliderState {
  tag: string;
  inputType: string;
  isRangeInput: boolean;
  value: number | null;
  now: number | null;
  min: number;
  max: number;
  step: number;
  /** 手柄自身 bbox（可能 0×0）。 */
  bbox: { x: number; y: number; width: number; height: number };
  /** 最近有尺寸祖先的 bbox（手柄 0×0 时的指针落点）。 */
  ancestorBox: { x: number; y: number; width: number; height: number } | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

/** 一次页面往返读全"这个滑块的当前事实"（含 0×0 手柄的最近有尺寸祖先）。 */
async function readState(loc: any): Promise<SliderState | null> {
  try {
    const raw = await loc.evaluate((node: any) => {
      const toNum = (v: unknown) => {
        const n = typeof v === "number" ? v : Number(String(v ?? ""));
        return Number.isFinite(n) ? n : null;
      };
      const rectOf = (el: any) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      let ancestorBox = null;
      let p = node.parentElement;
      for (let k = 0; k < 8 && p; k++, p = p.parentElement) {
        const r = p.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) { ancestorBox = { x: r.x, y: r.y, width: r.width, height: r.height }; break; }
      }
      const attr = (n: string) => node.getAttribute(n);
      const tag = String(node.tagName || "").toLowerCase();
      return {
        tag,
        inputType: String(attr("type") || "").toLowerCase(),
        valueNum: toNum(node.value),
        ariaNow: toNum(attr("aria-valuenow")),
        ariaMin: toNum(attr("aria-valuemin") ?? attr("min")),
        ariaMax: toNum(attr("aria-valuemax") ?? attr("max")),
        ariaStep: toNum(attr("step") ?? attr("aria-valuestep")),
        bbox: rectOf(node),
        ancestorBox,
      };
    });
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const isRangeInput = String(r["tag"]) === "input" && String(r["inputType"]) === "range";
    const min = num(r["ariaMin"]) ?? 0;
    const max = num(r["ariaMax"]) ?? 100;
    return {
      tag: String(r["tag"] ?? ""),
      inputType: String(r["inputType"] ?? ""),
      isRangeInput,
      value: num(r["valueNum"]),
      now: num(r["ariaNow"]),
      min,
      max,
      step: Math.abs(num(r["ariaStep"]) ?? 1) || 1,
      bbox: (r["bbox"] ?? { x: 0, y: 0, width: 0, height: 0 }) as SliderState["bbox"],
      ancestorBox: (r["ancestorBox"] ?? null) as SliderState["ancestorBox"],
    };
  } catch {
    return null;
  }
}

/** 当前值（input.value 优先；ARIA 手柄读 aria-valuenow）。 */
function currentOf(s: SliderState | null): number | null {
  if (s === null) return null;
  return s.isRangeInput ? (s.value ?? s.now) : (s.now ?? s.value);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * 把目标值按页面的 min/max 折算成数值（`{value}` 直取，`{percent}` 按区间比例）。
 * task-21/1a：返回 requested（调用方原话）与 target（折算/钳制后）——**越界不再静默钳制**
 * （钳制后按钳制值报 accurate:true 是假成功，违反红线③）；越界由 applyRange 结构化拒绝
 * （value_out_of_range，零动作）。percent 语义本就是区间比例，恒在值域内，无越界概念。
 */
function targetRangeValue(
  state: SliderState | null, value: RangeValue,
): { requested: number; target: number; clamped: boolean } | null {
  const min = state?.min ?? 0;
  const max = state?.max ?? 100;
  if ("value" in value) {
    const v = num((value as { value: unknown }).value);
    if (v === null) return null;
    const clampedV = clamp(v, min, max);
    return { requested: v, target: clampedV, clamped: clampedV !== v };
  }
  const pct = num((value as { percent: unknown }).percent);
  if (pct === null) return null;
  const t = clamp(min + (max - min) * (pct / 100), min, max);
  return { requested: t, target: t, clamped: false };
}

/** 设置原生 input[type=range] 的值（fill 失败时的 DOM 补发通道）。 */
async function fillNative(loc: any, target: number): Promise<void> {
  try {
    await loc.fill(String(target));
    return;
  } catch {
    /* 有些 Playwright 版本拒绝对 range fill：退回 DOM 写入 + 事件（同一可见事实） */
  }
  try {
    await loc.evaluate((node: any, v: number) => {
      node.value = String(v);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, target);
  } catch {
    /* 交给 verify 判失败 */
  }
}

/**
 * 键盘策略（task-21/1a 格点感知）：Home 归零 → 步长探测 → **最近格点精确步进**。
 * 格点 = atHome + k*step（Home 归 min 后从 min 起算）；最近格点 = Math.round((target-atHome)/step)。
 * accurate 语义：键盘路径**精确**（achieved === target 才算成功）——目标不在格点上
 * （|gap|<step，多按只会越过）→ probe lattice_unreachable，achieved 如实带出最近格点，
 * 不用容差把“最近的格点”说成“目标已达成”。
 * 探针三态：value_unreadable（页面值读不出）/ home_ignored（控件不理 Home）/ 
 * lattice_unreachable（目标不在格点上、步数超界或中途越界）。
 */
async function keyboardSet(
  loc: any, target: number, deadline: number, state0: SliderState,
): Promise<{ achieved: number | null; probe: RangeProbe | null }> {
  try {
    const preNow = currentOf(state0);
    await loc.press("Home");
    await sleep(10);
    const atHome = currentOf(await readState(loc));
    if (atHome === null) return { achieved: null, probe: "value_unreadable" };
    // home_ignored：按 Home 前值不在 min、按了之后仍不在 min → 控件忽略 Home
    //（按 Home 前已在 min 附近 = Home 无需移动，不算 ignored）。
    const nearMin = (v: number): boolean => Math.abs(v - state0.min) <= state0.step / 2;
    if (!nearMin(atHome) && (preNow === null || !nearMin(preNow))) {
      return { achieved: atHome, probe: "home_ignored" };
    }
    await loc.press("ArrowRight");
    await sleep(10);
    const plusOne = currentOf(await readState(loc));
    if (plusOne === null) return { achieved: null, probe: "value_unreadable" };
    if (plusOne === atHome) return { achieved: null, probe: null };   // 页面不响应键盘：键盘策略不可用（落 pointer）
    const step = Math.abs(plusOne - atHome) || 1;
    // 格点感知：格点 = atHome + k*step（Home 归 min 后从 min 起算）；按压数从**已探测的
    // plusOne 位置**起算（步进探测本身消费了一步）；最近格点 = Math.round。
    // |gap|<step 不做微调（多按只会越过目标——±3 微调旧设计已废）。
    const kp = Math.round((target - plusOne) / step);
    if (!Number.isFinite(kp) || Math.abs(kp) > 500) {
      return { achieved: currentOf(await readState(loc)), probe: "lattice_unreachable" };
    }
    const key = kp >= 0 ? "ArrowRight" : "ArrowLeft";
    for (let i = 0; i < Math.abs(kp); i++) {
      if (Date.now() > deadline) {
        return { achieved: currentOf(await readState(loc)), probe: "lattice_unreachable" };
      }
      await loc.press(key);
    }
    const achieved = currentOf(await readState(loc));
    if (achieved === null) return { achieved: null, probe: "value_unreadable" };
    // 收敛判定：键盘路径精确（achieved === target）；最近格点 ≠ 目标 → lattice_unreachable。
    if (achieved !== target) return { achieved, probe: "lattice_unreachable" };
    return { achieved, probe: null };
  } catch {
    return { achieved: null, probe: null };
  }
}

/** 指针策略：在"最近有尺寸祖先"的 bbox 上按目标比例按下（0×0 手柄的落点）。 */
async function pointerSet(
  page: any, loc: any, target: number, deadline: number, tolerance: number,
): Promise<{ achieved: number | null; bbox: SliderState["bbox"] | null }> {
  const state = await readState(loc);
  if (state === null) return { achieved: null, bbox: null };
  const box = (state.bbox.width > 1 && state.bbox.height > 1) ? state.bbox : state.ancestorBox;
  if (box === null || box.width <= 1 || box.height <= 1) return { achieved: null, bbox: null };
  const fraction = state.max > state.min ? (target - state.min) / (state.max - state.min) : 0;
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    const f = clamp(fraction, 0.02, 0.98);
    const x = box.x + f * box.width;
    const y = box.y + box.height / 2;
    try {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + (attempt % 2 === 0 ? 0 : 1), y);
      await page.mouse.up();
    } catch {
      return { achieved: currentOf(await readState(loc)), bbox: box };
    }
    await sleep(20);
    const now = currentOf(await readState(loc));
    if (now !== null && Math.abs(now - target) <= tolerance) return { achieved: now, bbox: box };
  }
  return { achieved: currentOf(await readState(loc)), bbox: box };
}

/**
 * 对已定位的范围控件设置目标值。三道策略按 fill → keyboard → pointer 依次尝试，
 * 每次都用页面值事实校验；全部失败返回 `slider_not_settable`（含已试策略/bbox/当前值）。
 */
export async function applyRange(
  page: any, loc: any, value: RangeValue, opts: RangeOptions = {},
): Promise<RangeOutcome> {
  const state0Ref = await readState(loc);
  if (state0Ref === null) {
    return {
      ok: false, applied: false, accurate: false,
      stopCode: "slider_not_settable",
      reason: "cannot read the slider state (element detached or not a slider)",
    };
  }
  const state0 = state0Ref;
  // task-21/1a：tolerance 缺省 **max(0.5, step/2)**（步长感知——步长 50 的滑杆 0.5 容差没有
  // 判定意义）；显式声明仍优先。
  const tolerance = Math.abs(opts.tolerance ?? Math.max(0.5, state0.step / 2));
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  const tv = targetRangeValue(state0, value);
  if (tv === null) {
    return {
      ok: false, applied: false, accurate: false,
      stopCode: "slider_not_settable",
      reason: `invalid range value ${JSON.stringify(value)}`,
    };
  }
  const requested = tv.requested;
  const target = tv.target;
  // task-21/1a：越界请求**结构化拒绝，零动作**（不 clamp、不策略、不假装）——旧行为把
  // 越界目标钳进值域后按钳制值报 accurate:true，违反红线③（完成只认证据/不假装成功）。
  if (tv.clamped) {
    return {
      ok: false, applied: false, accurate: false,
      requested, clamped_from: target, target,
      stopCode: "value_out_of_range",
      reason: `requested value ${requested} is outside the slider range [${state0.min}, ${state0.max}] `
        + `(would clamp to ${target}) — refused without any interaction (never pretend success; `
        + "narrow the request or pick a control whose range covers the target)",
    };
  }
  const strategies: string[] = [];
  let state: SliderState | null = state0;
  const initial = currentOf(state);
  // 已经在目标上：如实成功（accurate 精确语义——initial 恰为 requested 才 accurate:true；
  // 容差邻域但非精确值 → ok:true + accurate:false + achieved 如实带出）。
  if (initial !== null && Math.abs(initial - requested) <= tolerance) {
    return {
      ok: true, achieved: initial, strategy: state0.isRangeInput ? "fill" : "keyboard",
      applied: true, accurate: initial === requested, target, requested,
    };
  }
  let lastProbe: RangeProbe | null = null;
  // ① 原生 range：DOM 值写入（fill 优先）。accurate 语义：精确（achieved === requested）。
  if (state0.isRangeInput) {
    strategies.push("fill");
    await fillNative(loc, target);
    await sleep(10);
    state = await readState(loc);
    const got = currentOf(state);
    if (got !== null && got === requested) {
      return { ok: true, achieved: got, strategy: "fill", applied: true, accurate: true, target, requested };
    }
  }  // ② 键盘（ARIA 手柄的主力；input range 若 fill 失败也试一次）。
  // accurate 语义：精确（achieved === requested——格点感知下目标可精确到达才算）。
  strategies.push("keyboard");
  if (Date.now() < deadline) {
    const kb = await keyboardSet(loc, target, deadline, state0);
    if (kb.achieved !== null && kb.achieved === requested) {
      return { ok: true, achieved: kb.achieved, strategy: "keyboard", applied: true, accurate: true, target, requested };
    }
    lastProbe = kb.probe;
  }
  // ③ 指针（自绘手柄；0×0 手柄用最近有尺寸祖先）。accurate 精确语义：achieved === requested
  //（容差只用于 pointer 内部的收敛判定——非精确落点如实 ok:false + achieved 带出）。
  strategies.push("pointer");
  if (Date.now() < deadline) {
    const { achieved, bbox } = await pointerSet(page, loc, target, deadline, tolerance);
    if (achieved !== null && achieved === requested) {
      return { ok: true, achieved, strategy: "pointer", applied: true, accurate: true, target, requested };
    }
    const now = currentOf(await readState(loc));
    return {
      ok: false,
      applied: false, accurate: false, target, requested,
      ...(lastProbe !== null ? { probe: lastProbe } : {}),
      stopCode: "slider_not_settable",
      reason: `target ${requested} not reached after strategies [${strategies.join(" → ")}] `
        + `(current=${now ?? "unknown"}, bbox=${bbox === null ? "none" : `${Math.round(bbox.width)}×${Math.round(bbox.height)}`}, `
        + `timeoutMs=${timeoutMs}${lastProbe !== null ? `, probe=${lastProbe}` : ""}) `
        + "— the page does not expose a settable slider surface (never pretend success)",
    };
  }
  return {
    ok: false,
    applied: false, accurate: false, target, requested,
    ...(lastProbe !== null ? { probe: lastProbe } : {}),
    stopCode: "slider_not_settable",
    reason: `timeout after ${timeoutMs}ms with strategies [${strategies.join(" → ")}] — the range control did not accept any interaction`,
  };
}

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

export interface RangeOutcome {
  ok: boolean;
  achieved?: number;
  strategy?: RangeStrategy;
  stopCode?: string;
  reason?: string;
  /**
   * S1 effect 读回（页面值事实读回成功才出现）：
   *   - `applied`：控件当前值已经是目标（含“本来就在目标上”的如实成功）；
   *   - `accurate`：`|achieved - target| <= tolerance`（容差内）。
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

/** 把目标值按页面的 min/max 折算成数值（`{value}` 直取，`{percent}` 按区间比例）。 */
function targetRangeValue(
  state: SliderState | null, value: RangeValue,
): number | null {
  const min = state?.min ?? 0;
  const max = state?.max ?? 100;
  if ("value" in value) {
    const v = num((value as { value: unknown }).value);
    return v === null ? null : clamp(v, min, max);
  }
  const pct = num((value as { percent: unknown }).percent);
  if (pct === null) return null;
  return clamp(min + (max - min) * (pct / 100), min, max);
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

/** 键盘策略：Home + ArrowRight/ArrowLeft（先探测页面是否真的响应键盘）。 */
async function keyboardSet(
  loc: any, target: number, deadline: number, tolerance: number,
): Promise<number | null> {
  try {
    await loc.press("Home");
    await sleep(10);
    const atHome = currentOf(await readState(loc));
    if (atHome === null) return null;
    await loc.press("ArrowRight");
    await sleep(10);
    const plusOne = currentOf(await readState(loc));
    if (plusOne === null || plusOne === atHome) return null;   // 页面不响应键盘
    const step = Math.abs(plusOne - atHome) || 1;
    const need = Math.round((target - plusOne) / step);
    if (!Number.isFinite(need) || Math.abs(need) > 500) return null;
    const key = need >= 0 ? "ArrowRight" : "ArrowLeft";
    for (let i = 0; i < Math.abs(need); i++) {
      if (Date.now() > deadline) return null;
      await loc.press(key);
    }
    // 少量步进误差：最多再 ±3 次微调
    for (let k = 0; k < 3; k++) {
      const now = currentOf(await readState(loc));
      if (now === null) return null;
      if (Math.abs(now - target) <= tolerance) return now;
      await loc.press(now < target ? "ArrowRight" : "ArrowLeft");
    }
    return currentOf(await readState(loc));
  } catch {
    return null;
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
  const tolerance = Math.abs(opts.tolerance ?? 0.5);
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  let state = await readState(loc);
  if (state === null) {
    return {
      ok: false, applied: false, accurate: false,
      stopCode: "slider_not_settable",
      reason: "cannot read the slider state (element detached or not a slider)",
    };
  }
  const target = targetRangeValue(state, value);
  if (target === null) {
    return {
      ok: false, applied: false, accurate: false,
      stopCode: "slider_not_settable",
      reason: `invalid range value ${JSON.stringify(value)}`,
    };
  }
  const strategies: string[] = [];
  const initial = currentOf(state);
  const within = (v: number | null | undefined): boolean => v !== null && v !== undefined && Math.abs(v - target) <= tolerance;
  // 已经在目标上：如实成功（策略按控件类型标注，不虚构交互）。
  if (initial !== null && Math.abs(initial - target) <= tolerance) {
    return {
      ok: true, achieved: initial, strategy: state.isRangeInput ? "fill" : "keyboard",
      applied: true, accurate: true, target,
    };
  }

  // ① 原生 range：DOM 值写入（fill 优先）
  if (state.isRangeInput) {
    strategies.push("fill");
    await fillNative(loc, target);
    await sleep(10);
    state = await readState(loc);
    const got = currentOf(state);
    if (within(got)) {
      return { ok: true, achieved: got!, strategy: "fill", applied: true, accurate: true, target };
    }
  }

  // ② 键盘（ARIA 手柄的主力；input range 若 fill 失败也试一次）
  strategies.push("keyboard");
  if (Date.now() < deadline) {
    const got = await keyboardSet(loc, target, deadline, tolerance);
    if (within(got)) {
      return { ok: true, achieved: got!, strategy: "keyboard", applied: true, accurate: true, target };
    }
  }

  // ③ 指针（自绘手柄；0×0 手柄用最近有尺寸祖先）
  strategies.push("pointer");
  if (Date.now() < deadline) {
    const { achieved, bbox } = await pointerSet(page, loc, target, deadline, tolerance);
    if (within(achieved)) {
      return { ok: true, achieved: achieved!, strategy: "pointer", applied: true, accurate: true, target };
    }
    const now = currentOf(await readState(loc));
    return {
      ok: false,
      applied: false, accurate: false, target,
      stopCode: "slider_not_settable",
      reason: `target ${target} not reached after strategies [${strategies.join(" → ")}] `
        + `(current=${now ?? "unknown"}, bbox=${bbox === null ? "none" : `${Math.round(bbox.width)}×${Math.round(bbox.height)}`}, `
        + `timeoutMs=${timeoutMs}) — the page does not expose a settable slider surface (never pretend success)`,
    };
  }
  return {
    ok: false,
    applied: false, accurate: false, target,
    stopCode: "slider_not_settable",
    reason: `timeout after ${timeoutMs}ms with strategies [${strategies.join(" → ")}] — the range control did not accept any interaction`,
  };
}

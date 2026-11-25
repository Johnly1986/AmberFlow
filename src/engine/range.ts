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
import { sleep } from "../support/sleep.ts";

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
   * 失败路径也如实给 false——不把“动作没抛错”当成“值设上了”。
   */
  applied?: boolean;
  accurate?: boolean;
  /** 本次的目标数值（percent 已按 min/max 折算；读回对账用）。 */
  target?: number;
  /**
   * 生效值域被**格点吸附**时的原请求值与落地值（`requested === snapped_to` 时缺省）。
   *
   * 为什么要有：`input[type=range] step=10` 物理上不可能持有 11（浏览器自己会把它钉到 10）。
   * 不吸附就只能三道策略全试、最后 `slider_not_settable`——那是把**值域事实**说成
   * **控件设不上**，还白等满超时。吸附后 `applied:true` + `accurate:false` + `snapped_to:10`：
   * 动作成功了，但请求的精确值在值域里不存在——两件事分开说。
   */
  snapped_to?: number;
  /** 该目标所在的**手柄数**（1 = 单柄；>1 = 多柄/耦合范围控件）。仅按到多柄时出现。 */
  handles?: number;
  /** 本次作用的是耦合组内第几个手柄（1-based；单柄不出现）。 */
  handle_index?: number;
  /**
   * 耦合组内各柄的值域事实（≤8；多柄才出现）：`[{handle, min, max, value, valuetext?}]`。
   * 越界拒绝时用来回答"这个值是哪一个柄的值域"——多柄控件里请求值对另一柄合法是常态，
   * 引擎只按本次命中的那一柄判越界，事实必须一起带出，否则"指错柄"会被读成"值不合法"。
   */
  peers?: Array<{ handle: number; min: number; max: number; value: number | null; valuetext: string | null }>;
  /**
   * 池侧 `row_index`（同 tag+label 的 dup 组内 DOM 先序位次；池行携带才算）。与 `handle_index`
   * 是两条不同的序：滑杆 label 常为空串，会和页面其它空 label 输入同组，所以"第几个手柄"
   * 与"同名组第几个"不能互相推导——两个事实都带出，寻址仍由作者选定。
   */
  pool_row_index?: number;
  /**
   * 控件的人读档位文本（`aria-valuetext`，如 "HK$200"）——只在页面提供时出现。
   * 为什么带上它：数值读回只能证明"数字是多少"，页面真正展示给用户的是档位文案；
   * 二者不一致时（价格滑杆）作者要靠它判断请求值落在哪一档。
   */
  valuetext?: string;
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
  /**
   * 多柄/耦合范围控件的手柄数（同一容器内 `input[type=range]` 或 `[role=slider]` 的个数）。
   * 1 = 普通单柄。>1 时"当前值/值域"是**一对**手柄的联合事实，percent 或跨柄目标不能
   * 按单柄的值域解释——这才是「双柄联动后区间瞬变」的真因，必须作为事实带出。
   */
  handles: number;
  /** 页面提供的档位文本（`aria-valuetext`）；未提供 = null（不编造）。 */
  valuetext: string | null;
  /**
   * 耦合组内**本柄**的 1-based 位次（1 = 组内 DOM 先序第一个）；单柄恒 1。
   * 与 `row_index` 不是一回事：`row_index` 是"同 tag+label 的 dup 组内序"（两个滑杆 label
   * 常常都是空串，会和页面其它空 label 输入同组），耦合组位次才是"第几个手柄"。两条事实都
   * 只在诊断里出现，寻址仍走作者选定的 hint 形状。
   */
  handleIndex: number;
  /**
   * 耦合组内各柄的**值域事实**（≤8；同一次 evaluate 读，零额外往返）。多柄控件里"请求值对
   * 第二柄合法、对第一柄越界"是常态——只拿本柄 min/max 判越界会把"指错了柄"说成"值不合法"，
   * 所以把各柄的 min/max/当前值一并带出（单柄 = 长度 1，不呈现）。
   */
  peers: Array<{ handle: number; min: number; max: number; value: number | null; valuetext: string | null }>;
}

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
      // 手柄数（多柄/耦合范围控件的判定）：最近一层**只装滑块**的祖先容器里同类控件个数。
      //   - 排除 body/html/main（页级容器不是耦合组，否则任意两个不相干滑杆都会被算成一对）；
      //   - 组内不得混有其他表单控件（input 非 range / select / textarea / button）——混了
      //     就说明这是普通表单而不是一对耦合手柄，停止上溯按单柄处理（多柄事实只陈述，
      //     不靠猜测把无关控件绑定成区间）。
      let handles = 1;
      let peerNodes: any[] = [];
      let boxHost = node.parentElement;
      for (let k = 0; k < 8 && boxHost; k++, boxHost = boxHost.parentElement) {
        const hostTag = String(boxHost.tagName || '').toLowerCase();
        if (hostTag === 'body' || hostTag === 'html') break;
        try {
          const peers = boxHost.querySelectorAll('input[type=range], [role=slider]');
          if (peers.length < 2) continue;
          const others = boxHost.querySelectorAll('input:not([type=range]), select, textarea, button');
          handles = others.length > 0 ? 1 : Math.min(peers.length, 8);
          if (handles > 1) peerNodes = Array.prototype.slice.call(peers, 0, 8);
          break;
        } catch (err) { break; /* 选择器失败：按单柄处理（不猜多柄） */ }
      }
      const selfIdx = peerNodes.indexOf(node);
      const peerFacts = (peerNodes.length > 1 ? peerNodes : []).map((pe: any, i: number) => ({
        handle: i + 1,
        min: toNum(pe.getAttribute('aria-valuemin') ?? pe.getAttribute('min')) ?? (toNum(pe.value) ?? 0),
        max: toNum(pe.getAttribute('aria-valuemax') ?? pe.getAttribute('max')) ?? (toNum(pe.value) ?? 100),
        value: toNum(pe.value) ?? toNum(pe.getAttribute('aria-valuenow')),
        valuetext: pe.getAttribute('aria-valuetext'),
      }));
      return {
        tag,
        inputType: String(attr("type") || "").toLowerCase(),
        valueNum: toNum(node.value),
        ariaNow: toNum(attr("aria-valuenow")),
        ariaMin: toNum(attr("aria-valuemin") ?? attr("min")),
        ariaMax: toNum(attr("aria-valuemax") ?? attr("max")),
        ariaStep: toNum(attr("step") ?? attr("aria-valuestep")),
        valuetext: attr("aria-valuetext"),
        handles,
        selfHandle: peerFacts.length > 1 && selfIdx >= 0 ? selfIdx + 1 : 1,
        peers: peerFacts,
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
      handles: Math.max(1, num(r["handles"]) ?? 1),
      valuetext: typeof r["valuetext"] === "string" && r["valuetext"] !== "" ? r["valuetext"] : null,
      handleIndex: Math.max(1, num(r["selfHandle"]) ?? 1),
      peers: Array.isArray(r["peers"])
        ? (r["peers"] as Array<Record<string, unknown>>).map((pe, i) => ({
          handle: num(pe["handle"]) ?? i + 1,
          min: num(pe["min"]) ?? 0,
          max: num(pe["max"]) ?? 100,
          value: num(pe["value"]),
          valuetext: typeof pe["valuetext"] === "string" && pe["valuetext"] !== "" ? pe["valuetext"] : null,
        }))
        : [],
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
 *
 * 格点吸附（`snapped`）：`input[type=range] step=N` 的物理值域是 min + k·step，请求值落在
 * 两格之间时浏览器/键盘都只能给最近格点——精确值**不存在**。不吸附的代价是三策略全部
 * 收敛失败 + 满超时白等 + `slider_not_settable`（值域事实被说成控件设不上）。吸附先于
 * 动作发生，`snapped_to` 如实带出（`applied:true` + `accurate:false`）。
 */
function targetRangeValue(
  state: SliderState | null, value: RangeValue,
): { requested: number; target: number; clamped: boolean; snapped: boolean } | null {
  const min = state?.min ?? 0;
  const max = state?.max ?? 100;
  const step = state === null || !Number.isFinite(state.step) || state.step <= 0 ? null : state.step;
  /** 值域是离散格点时把目标钉到最近格点；非格点值域（step 缺省=1 也算格点）恒吸附。 */
  const snapTo = (v: number): { value: number; snapped: boolean } => {
    if (step === null) return { value: v, snapped: false };
    const k = Math.round((v - min) / step);
    const snapped = min + k * step;
    const bounded = clamp(snapped, min, max);
    return { value: bounded, snapped: bounded !== v };
  };
  if ("value" in value) {
    const v = num((value as { value: unknown }).value);
    if (v === null) return null;
    const clampedV = clamp(v, min, max);
    const snappedTo = snapTo(clampedV);
    return { requested: v, target: snappedTo.value, clamped: clampedV !== v, snapped: snappedTo.snapped };
  }
  const pct = num((value as { percent: unknown }).percent);
  if (pct === null) return null;
  const t = clamp(min + (max - min) * (pct / 100), min, max);
  // percent 是**比例语义**，不是精确值语义：吸附后如实带出请求值（requested = 折算值），
  // 让调用方按 accurate 判读"档位是否恰好等价"。
  const snappedTo = snapTo(t);
  return { requested: t, target: snappedTo.value, clamped: false, snapped: snappedTo.snapped };
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
 * 多柄控件的值域事实句（越界/percent 拒绝的 reason 尾巴）：命中 N 个同形手柄时，把各柄的
 * min/max 摊开并点名本次作用于哪一个——单柄温差（`[0,10]` vs `[1,11]`）下，"请求值对第二柄
 * 合法"是对上号才有意义的信息，只报本柄越界会把"指错柄"伪装成"值不合法"。
 * 单柄 = 空串（reason 逐字节不变）。
 */
function peerFactsNote(state: SliderState, handles: number): string {
  if (handles <= 1 || state.peers.length <= 1) return "";
  const fmt = state.peers
    .map((p) => `#${p.handle} min=${p.min} max=${p.max}`
      + (p.value === null ? "" : ` value=${p.value}`)
      + (p.valuetext === null ? "" : ` (${p.valuetext})`))
    .join(", ");
  return ` — this target matched ${handles} same-shaped range handles and resolves to handle `
    + `#${state.handleIndex} [${fmt}]; the requested value may be in range for another handle — `
    + "address a specific handle with a row-index:N (dup-group order) or #id suffix on the target";
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
  const handles = state0.handles;
  // 多柄控件的事实（只在 >1 时出现）：单柄读法解释不了"区间瞬变"，必须让调用方看见。
  // peers 是各柄自己的 min/max——"请求值对另一柄合法"只有它说得清（同一次 readState 读出）。
  const handleFacts = handles > 1
    ? { handles, handle_index: state0.handleIndex, ...(state0.peers.length > 1 ? { peers: state0.peers } : {}) }
    : {};
  const valueFacts = state0.valuetext === null ? {} : { valuetext: state0.valuetext };
  // task-21/1a：tolerance 缺省 **max(0.5, step/2)**（步长感知——步长 50 的滑杆 0.5 容差没有
  // 判定意义）；显式声明仍优先。
  const tolerance = Math.abs(opts.tolerance ?? Math.max(0.5, state0.step / 2));
  const timeoutMs = Math.max(1, opts.timeoutMs ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  // percent 是**区间比例**：单柄上唯一可解释；多柄（双滑块价格区间等）上"区间"本身就是两个
  // 手柄之间的量，没有唯一目标——结构化拒绝、零动作，并指名用 `{value}` 打具体手柄。
  if ("percent" in value && handles > 1) {
    return {
      ok: false, applied: false, accurate: false,
      ...handleFacts, ...valueFacts,
      requested: num((value as { percent: unknown }).percent) ?? undefined,
      stopCode: "config_error",
      reason: `percent is not applicable: this control has ${handles} handles (a coupled range), so `
        + "a single percentage has no unique target — send {value: <number>} for the specific handle "
        + "instead (each handle keeps its own min/max and the pair's bounds move as you drag)"
        + peerFactsNote(state0, handles),
    };
  }
  const tv = targetRangeValue(state0, value);
  if (tv === null) {
    return {
      ok: false, applied: false, accurate: false,
      ...handleFacts, ...valueFacts,
      stopCode: "slider_not_settable",
      reason: `invalid range value ${JSON.stringify(value)}`,
    };
  }
  const requested = tv.requested;
  // 生效目标 = 吸附后的格点值（值域里真实存在的那一档）。requested 仍留原请求用于 accurate。
  const target = tv.target;
  const snapFacts = tv.snapped ? { snapped_to: target } : {};
  // task-21/1a：越界请求**结构化拒绝，零动作**（不 clamp、不策略、不假装）——旧行为把
  // 越界目标钳进值域后按钳制值报 accurate:true，违反红线③（完成只认证据/不假装成功）。
  if (tv.clamped) {
    return {
      ok: false, applied: false, accurate: false,
      ...handleFacts, ...valueFacts,
      requested, clamped_from: target, target,
      stopCode: "value_out_of_range",
      reason: `requested value ${requested} is outside the slider range [${state0.min}, ${state0.max}] `
        + `(would clamp to ${target}) — refused without any interaction (never pretend success; `
        + "narrow the request or pick a control whose range covers the target)"
        + peerFactsNote(state0, handles),
    };
  }
  const strategies: string[] = [];
  let state: SliderState | null = state0;
  /** 命中**生效目标**即成功；accurate 仍按 requested 判（吸附过 = 精确值不在值域里）。 */
  const hit = (achieved: number | null, strategy: RangeStrategy): RangeOutcome | null =>
    achieved === null || achieved !== target
      ? null
      : { ok: true, achieved, strategy, applied: true, accurate: !tv.snapped && achieved === requested, target, requested, ...snapFacts, ...handleFacts, ...valueFacts };
  const initial = currentOf(state);
  // 已经在目标上：如实成功（accurate 精确语义——initial 恰为 requested 才 accurate:true；
  // 容差邻域但非精确值 → ok:true + accurate:false + achieved 如实带出）。
  if (initial !== null && Math.abs(initial - target) <= tolerance) {
    const done = hit(initial, state0.isRangeInput ? "fill" : "keyboard");
    if (done !== null) return done;
  }
  let lastProbe: RangeProbe | null = null;
  // ① 原生 range：DOM 值写入（fill 优先）。
  if (state0.isRangeInput) {
    strategies.push("fill");
    await fillNative(loc, target);
    await sleep(10);
    state = await readState(loc);
    const done = hit(currentOf(state), "fill");
    if (done !== null) return done;
  }  // ② 键盘（ARIA 手柄的主力；input range 若 fill 失败也试一次）。
  strategies.push("keyboard");
  if (Date.now() < deadline) {
    const kb = await keyboardSet(loc, target, deadline, state0);
    const done = hit(kb.achieved, "keyboard");
    if (done !== null) return done;
    lastProbe = kb.probe;
  }
  // ③ 指针（自绘手柄；0×0 手柄用最近有尺寸祖先）。容差只用于 pointer 内部的收敛判定。
  strategies.push("pointer");
  if (Date.now() < deadline) {
    const { achieved, bbox } = await pointerSet(page, loc, target, deadline, tolerance);
    const done = hit(achieved, "pointer");
    if (done !== null) return done;
    const now = currentOf(await readState(loc));
    return {
      ok: false,
      applied: false, accurate: false, target, requested,
      ...handleFacts, ...valueFacts,
      ...(lastProbe !== null ? { probe: lastProbe } : {}),
      stopCode: "slider_not_settable",
      reason: `target ${target} not reached after strategies [${strategies.join(" → ")}] `
        + `(current=${now ?? "unknown"}, bbox=${bbox === null ? "none" : `${Math.round(bbox.width)}×${Math.round(bbox.height)}`}, `
        + `timeoutMs=${timeoutMs}${lastProbe !== null ? `, probe=${lastProbe}` : ""}) `
        + "— the page does not expose a settable slider surface (never pretend success)",
    };
  }
  return {
    ok: false,
    applied: false, accurate: false, target, requested,
    ...handleFacts, ...valueFacts,
    ...(lastProbe !== null ? { probe: lastProbe } : {}),
    stopCode: "slider_not_settable",
    reason: `timeout after ${timeoutMs}ms with strategies [${strategies.join(" → ")}] — the range control did not accept any interaction`,
  };
}

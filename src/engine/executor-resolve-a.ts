/**
 * 执行器实现模块（从 executor.ts 切分，大文件拆分 X1）：本文件函数都是
 * `BrowserMiddleware` 的实现片段，显式接收 `mw` 实例（唯一执行循环仍在 executor.ts）。
 */
import { parseClickAtValue } from "./click-at.ts";
import { FN_EMPTIES } from "./eval-snippets.ts";
import { EFFECT_MASK, carriesSecret, describeActionError, firstLoc, redactValue } from "./executor-pure.ts";
import { type AnyPage, type StateEffect } from "./executor-types.ts";
import { type ActionCapability, type Elem, type ElemPool, actionCapabilities, elemFamily, framesOf } from "./extraction.ts";
import { type HintMatchOptions, hintCandidates } from "./rules.ts";
import fs from "node:fs";
import path from "node:path";
import type { BrowserMiddleware } from "./executor.ts";

  /**
   * The action model: click / fill / select — with submit-type inputs clicked
   * (never filled: their `value` is the visible label) and `select` trying the
   * human label first with a SHORT timeout (a slot usually carries the machine
   * value, so the label probe is expected to miss and Playwright's 30 s default
   * would charge that miss to every select fill).
   *
   * P3 exception: when the value came from a **declared** `{from:"option"}` binding it was already
   * resolved against this page's option list, so the fill selects by VALUE directly (`bound.byValue`)
   * — the label probe would only cost 1.5 s and could select a different option whose label happens
   * to equal the machine value. Every path without a declared binding keeps the order above.
   */
export async function _executeElement(mw: BrowserMiddleware, page: AnyPage, el: Elem, slots: Record<string, unknown>,
    /**
     * P2/P3：命令闭集带来的**具名绑定**。`byValue` = 这个值是从当次观察到的候选里按值解出来的
     * （`{from:"option"}`），所以 `<select>` 直接按值选——见下面 select 分支的注释。
     */
    bound?: { value: unknown; byValue?: boolean } | null,
    op?: string,
    /** S4：步级 `force`（Playwright force 语义；缺省 false = 逐字节今天）。 */
    force = false,
    /**
     * U1：步级显式值袋（决策路径传入；命令步不传——`bound` 具名绑定恒优先）。
     * 只在无 `bound` 时参与 `_slotValue` 的值解析。
     */
    values?: Record<string, unknown> | null,): Promise<[string, unknown, StateEffect?]> {
    const tag = el.tag;
    const forceOpt = force ? { force: true } : {};
    if (op === "clickAt") {
      // U7：坐标点击原语。坐标值只来自声明绑定（slot/dataset），是**元素相对**坐标
      // （Playwright locator.click({position}) 语义：相对元素 padding box 左上角）。
      // 坏格式/越界都是结构化 config_error（reason 点名合法格式/实测尺寸），不是页面问题。
      if (elemFamily(el) !== "click") {
        return ["action_unsupported", "clickAt requires a click-family element"];
      }
      const parsed = parseClickAtValue(bound?.value);
      if (!parsed.ok) return ["config_error", parsed.reason];
      const loc = await mw._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      const target = firstLoc(loc);
      const measure = (target as unknown as {
        boundingBox?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
      }).boundingBox;
      const box = typeof measure === "function" ? await measure.call(target) : null;
      if (box === null) {
        return ["action_failed", "clickAt: element has no bounding box (detached or zero-size)"];
      }
      const { x, y } = parsed.position;
      if (x < 0 || x >= box.width || y < 0 || y >= box.height) {
        return ["config_error",
          `clickAt position ${x},${y} is outside the element ${el.tag} "${el.label}" — measured `
          + `width=${box.width}, height=${box.height} (need 0 <= x < width, 0 <= y < height)`];
      }
      try {
        await target.click({ position: { x, y }, timeout: 5000, ...forceOpt });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return ["clicked", { position: { x, y } }];
    }
    if (op === "hover") {
      // S4：hover 原语——只移动指针，不点击、不导航；`locator.hover()` 同样受 force 影响。
      const loc = await mw._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      const hover = (firstLoc(loc) as unknown as { hover?: (o?: unknown) => Promise<void> }).hover;
      if (typeof hover !== "function") return ["action_unsupported", "locator has no hover"];
      try {
        await hover.call(firstLoc(loc), { timeout: 5000, ...forceOpt });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return ["hovered", null];
    }
    if (op === "drag") {
      const loc = await mw._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      const destSel = bound && bound.value !== undefined && bound.value !== null ? String(bound.value) : "";
      if (!destSel.trim()) return ["needs_value", null];
      const dragTo = (firstLoc(loc) as unknown as { dragTo?: (t: unknown, o?: unknown) => Promise<void> }).dragTo;
      if (typeof dragTo !== "function") return ["action_unsupported", "locator has no dragTo"];
      try {
        await dragTo.call(firstLoc(loc), page.locator(destSel), { timeout: 5000, ...forceOpt });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return ["dragged", destSel];
    }
    if (op === "scroll") {
      const loc = await mw._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      try {
        await firstLoc(loc).evaluate((node: unknown) => {
          const el = node as { scrollIntoView(o?: unknown): void };
          const anyEl = node as { scrollIntoViewIfNeeded?: (o?: unknown) => void };
          if (typeof anyEl.scrollIntoViewIfNeeded === "function") {
            anyEl.scrollIntoViewIfNeeded({ block: "center", behavior: "instant" });
          } else {
            el.scrollIntoView({ block: "center", behavior: "instant" });
          }
        });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return ["scrolled", null];
    }
    if (op === "upload") {
      // U6：上传原语。能力面由调用方（actionCapabilities/命令预检）先判一次；这里再守一道，
      // 保证非 file 目标得到结构化 action_unsupported，而不是 Playwright 的裸错。
      const isFileInput = tag === "input" && String(el["input_type"] ?? "").toLowerCase() === "file";
      if (!isFileInput) return ["action_unsupported", "upload requires input[type=file]"];
      const raw = bound?.value;
      let files: string[];
      if (typeof raw === "string") files = [raw];
      else if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) files = raw.slice() as string[];
      else if (raw === null || raw === undefined) return ["needs_value", null];
      else {
        return ["config_error",
          `upload value must be a path string or a string[] of paths (got ${Array.isArray(raw) ? "array" : typeof raw})`];
      }
      if (files.length === 0 || files.some((f) => f.trim() === "")) {
        return ["config_error",
          "upload value is empty — a declared path is required (empty string / empty list is not a file)"];
      }
      // 值只来自声明绑定：不做通配/目录遍历/环境变量展开；执行前逐条校验存在性。
      const missing = files.filter((f) => {
        try { return !fs.existsSync(f); } catch { return true; }
      });
      if (missing.length) {
        return ["config_error",
          `upload file(s) not found: ${missing.map((f) => path.basename(f)).join(", ")}`];
      }
      const loc = await mw._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      const target = firstLoc(loc);
      const setInputFiles = (target as unknown as {
        setInputFiles?: (f: unknown, o?: unknown) => Promise<void>;
      }).setInputFiles;
      if (typeof setInputFiles !== "function") return ["action_unsupported", "locator has no setInputFiles"];
      try {
        // Playwright 1.58 的 setInputFiles 只认 noWaitAfter/timeout（没有 force）；步级 force 不作用于上传。
        await setInputFiles.call(target, files, { timeout: 5000 });
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      // 证据只记 basename；changed 由调用方按 count >= expected 判（读不到就如实记 null）。
      let count: number | null = null;
      try {
        const n = await target.evaluate((node: unknown) => {
          const f = (node as { files?: { length?: number } | null }).files;
          return f && typeof f.length === "number" ? f.length : 0;
        });
        count = typeof n === "number" && Number.isFinite(n) ? n : null;
      } catch { count = null; }
      return ["uploaded", { files: files.map((f) => path.basename(f)), count, expected: files.length }];
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (mw._isSubmit(el)) return mw._clickOnly(page, el, force);
      // P2: a command-space fill/select arrives with its value ALREADY BOUND BY NAME
      // (`{from:"slot", key}` from the plan) — it must not fall back to `_slotValue`'s
      // substring heuristic, which is how a value once got handed to a radio. When no
      // binding was given (every pre-existing path), the heuristic stays exactly as today.
      const val = bound !== undefined && bound !== null ? bound.value : mw._slotValue(el, slots, values ?? undefined);
      if (val === null || val === undefined) return ["needs_value", null];
      // W8 secretSlots：本次 fill 的值若携带当次袋里的敏感槽位值 → (a) 整步 before/after
      // 一律掩码（含 applied=false 的分支——「一律」口径；applied 布尔仍保留）；(b) 把命中
      // 的**真值本身**（不是可能更长的合成串）记入实例级集合，供后续步在同一输入上的残留
      // before 命中——那时当次袋里可能已看不到该值（R3 案例 S 的值就是步级 slots 提供的）。
      // 对 select 同样生效（select 无读回、不影响本步 effect，但值可能残留在页面上）。
      const secretsNow = [
        ...mw._secretValuesIn(slots),
        // U1/W8 同口径：values 袋里键命中敏感槽位名单的条目，其值同样算"敏感值"——
        // 同一秘密经 values 声明与经 slots 声明在 effect 读回掩码上不应当有两样待遇。
        ...mw._secretValuesIn(values ?? {}),
      ];
      const valStr = String(val);
      let valSecret = false;
      for (const x of secretsNow) {
        if (valStr === x || (x.length >= 4 && valStr.includes(x))) {
          valSecret = true;
          mw._secretValuesSeen.add(x);
        }
      }
      const loc = await mw._locatorFor(page, el);
      if (loc === null) return ["stale_ref", null];
      // A failing action is a RESULT, not an exception: a disabled/hidden field
      // or a page that unmounts mid-step must forbid the ref (the loop does that
      // for any non-"filled"/"clicked" outcome) and keep the subgoal alive. The
      // Python reference let Playwright's TimeoutError escape `run()` and killed
      // the whole plan; found by the live zh.wikipedia case.
      let effect: StateEffect | undefined;
      try {
        if (tag === "select") {
          if (bound?.byValue) {
            // 声明式绑定已经**按值**命中过当次观察到的候选：直接按值选（不付 label 探测，
            // 也不会选中"标签恰好等于这个机器值"的另一个 option）。
            await firstLoc(loc).selectOption({ value: String(val) }, { timeout: 5000, ...forceOpt });
          } else {
            try {
              await firstLoc(loc).selectOption({ label: String(val) }, { timeout: 1500, ...forceOpt });
            } catch {
              await firstLoc(loc).selectOption({ value: String(val) }, { timeout: 5000, ...forceOpt });
            }
          }
        } else {
          // S1 effect 读回：动作只证明“调用了 fill”，读回值才证明“真的填进去了”。
          // 读不到（组件不可读/被卸载）就整条省略——降级跳过，不假装。
          let before: string | null = null;
          if (mw.fillReadback) {
            try {
              const b = await firstLoc(loc).inputValue();
              before = typeof b === "string" ? b : null;
            } catch { before = null; }
          }
          await firstLoc(loc).fill(String(val), force ? { force: true } : undefined);
          if (mw.fillReadback && before !== null) {
            let after: string | null = null;
            try {
              const a = await firstLoc(loc).inputValue();
              after = typeof a === "string" ? a : null;
            } catch { after = null; }
            if (after !== null) {
              // W8 掩码在**源头**做（执行器构造 effect 一次，step_traces[i].result.state.effect
              // 与 step_traces[i].state.effect 两条投影同源同掩，收尾不再处理）。判定链：
              // ① 值来自敏感槽位（valSecret）→ before/after 整体 "***"（EFFECT_MASK，与顶层
              //    slots 掩码同值、不保留长度——秘密值绝不进产物）；
              // ② 读回内容命中敏感值（当次袋 ∪ 实例累计——跨步残留 before）→ 同样掩码；
              // ③ 都不命中 → 维持既有行为：password/file/hidden 输入形态 redactValue 的
              //    "***(N)"，其余明文（非敏感槽位/字面值的读回证据不变）。
              // applied 用**原始读回**判定：保留布尔、不保留值——“真的填进去了”是核心证据。
              const secretHit = (s: string): boolean =>
                valSecret || carriesSecret(s, secretsNow) || carriesSecret(s, mw._secretValuesSeen);
              const masked = (s: string): string => (secretHit(s) ? EFFECT_MASK : String(redactValue(el, s)));
              effect = {
                kind: "fill", before: masked(before), after: masked(after),
                applied: after === String(val),
              };
            }
          }
        }
      } catch (e) {
        return ["action_failed", describeActionError(e)];
      }
      return effect === undefined ? ["filled", val] : ["filled", val, effect];
    }
    return mw._clickOnly(page, el, force);
  }

  /**
   * Visible empty inputs/textareas whose value the frozen plan supplies.
   *
   * Not just `[required]`: a submit button guarded by JS on an empty field is
   * inert without it. Deterministic pre-fill from the plan's data bag — values
   * never come from the model. Reuses the scan the caller already has:
   * re-extracting here cost a SECOND full extraction before every click.
   */
export async function _missingRequired(mw: BrowserMiddleware, page: AnyPage, slots: Record<string, unknown>, elems: ElemPool | null = null,
    /**
     * U1：步级显式值袋（决策路径的预填通道——required 空字段的值请求与当步 fill/select
     * 用同一个解析顺序「values → slots」，两通道不一致会出现"过滤放行、执行却 needs_value"的错位）。
     */
    values?: Record<string, unknown> | null,
    candidatePriority: "bucketed" | "main-first" = "bucketed",): Promise<Elem[]> {
    const empties: Array<{ tag: string; dt: string; name: string; id: string }> = [];
    for (const fr of framesOf(page)) {
      try {
        empties.push(...((await fr.evaluate(FN_EMPTIES)) as Array<{ tag: string; dt: string; name: string; id: string }> ?? []));
      } catch {
        continue;
      }
    }
    const out: Elem[] = [];
    for (const em of empties) {
      // Match a slot to this field by attribute AND by the label text
      // `_slotValue` would see (placeholder/wrapper label): composer fields are
      // keyed by their placeholder, not by data-test.
      const elemsNow = elems ?? (await mw._extractPoolSettled(page, candidatePriority)).elems;
      let match: Elem | undefined;
      for (const e of Object.values(elemsNow)) {
        if ((em.dt && e["data_test"] === em.dt)
          || (em.id && e["id"] === em.id)
          || (em.name && e["name"] === em.name)) {
          match = e;
          break;
        }
      }
      if (match === undefined || mw._slotValue(match, slots, values ?? undefined) === null) continue;
      // carry the handle fields so _locatorFor resolves inside the right frame
      // instead of degrading to a bare attribute lookup
      out.push({
        ref: match["ref"] as string,
        frame: (match["frame"] as number) ?? 0,
        dsh_ref: (match["dsh_ref"] as string) ?? "",
        tag: em.tag,
        label: match.label,
        data_test: em.dt,
        name: em.name,
        id: em.id,
        input_type: (match["input_type"] as string) ?? "",
        href: "",
      });
    }
    return out;
  }

  /* -- A1 hint matching options --------------------------------------------- */

  /**
   * A1：本实例的池侧 hint 匹配口径（`meta.policy.attr_value_match`）。run 面的每一处
   * hintMatch/hintCandidates/affordanceRule 都从这里取；缺省 `full_label`（= A1 修复后）。
   * inspect/observe/session 不构造 policy ⇒ 同一缺省（恒 full_label）。
   */
export function _hintOpts(mw: BrowserMiddleware): HintMatchOptions {
    return { attrValueMatch: mw.attrValueMatch };
  }

  /* -- A2 command-target resolution ---------------------------------------- */

  /**
   * A2：命令目标的**可行动优先**候选解析（纯函数，不动作、不猜）。
   *
   * 为什么需要它：`hintMatch` 只给一个 ref，遇到同 label 的 `div[role=button]` + `button`
   * 时会按 DOM 序选中 div——被覆盖层挡住就白烧一次动作，而真正可点的是后面的 button。
   * 这里把"候选集"按可行动性排序后交给动作层**逐个尝试**（最多前 4 个）：
   *   1. 动作族对得上当前 op 的优先（click 会剔除明确不可点击的族；若剔除后为空则保留原
   *      顺序，让动作层照旧给 `action_unsupported` 的诚实停因）；
   *   2. 原生可行动 tag/role（a/button/input/label/select/textarea；role button/link/menuitem/
   *      tab/option…）优先于自绘 div/span；
   *   3. 最后按 DOM 序（scan）——与旧行为同序，确定性。
   * `forbidden` 里的 ref 会被过滤（动作阶段失败的候选由 forbid 记账，下一步自动看下一个）。
   */
export function resolveCommandRef(mw: BrowserMiddleware, target: string, elems: ElemPool, op: string, forbidden?: ReadonlySet<string> | null,): string[] {
    if (typeof target !== "string" || !target.trim()) return [];
    const cand = hintCandidates(target, elems, _hintOpts(mw, ));
    if (cand === null) return [];
    const seen = new Set<string>();
    const refs: string[] = [];
    for (const r of (cand.decided === null ? cand.refs : [cand.decided, ...cand.refs])) {
      if (elems[r] === undefined || seen.has(r)) continue;
      seen.add(r);
      refs.push(r);
    }
    const eligible = forbidden ? refs.filter((r) => !forbidden.has(r)) : refs;
    const opCap = op as ActionCapability;
    const fits = (r: string): boolean => actionCapabilities(elems[r]!).includes(opCap);
    const nativeRank = (r: string): number => {
      const e = elems[r]!;
      const tag = String(e.tag ?? "").toLowerCase();
      const role = String(e.role ?? "").toLowerCase();
      const nativeTag = ["a", "button", "input", "label", "select", "textarea"].includes(tag);
      const nativeRole = ["button", "link", "menuitem", "tab", "option", "checkbox", "radio",
        "switch", "textbox", "searchbox", "combobox", "slider"].includes(role);
      return nativeTag || nativeRole ? 0 : 1;
    };
    const posOf = new Map(refs.map((r, i) => [r, i]));
    const ordered = [...eligible].sort((a, b) =>
      (fits(a) ? 0 : 1) - (fits(b) ? 0 : 1)
      || nativeRank(a) - nativeRank(b)
      || ((elems[a]!.scan ?? posOf.get(a) ?? 0) - (elems[b]!.scan ?? posOf.get(b) ?? 0)));
    // click：剔除明确不可点击的族；若全被剔除（目标确实不是按钮），保留原顺序交给动作层报
    // action_unsupported，而不是把目标"变成不存在"。
    if (op === "click" || op === "clickAt") {
      const clickable = ordered.filter(fits);
      return clickable.length ? clickable : ordered;
    }
    return ordered;
  }

  /* -- A3 list/range primitives ------------------------------------------- */


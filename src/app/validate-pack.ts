/**
 * 应用 pack 的加载期校验：validatePack（校验顺序 = 下列子校验的调用顺序）与 validateSiteBlock。
 *
 * 子校验各自只回答问题、只往 p 里追加同文案的错误；顺序与错误文案是加载期契约，搬动时不可重排。
 */
import { isDict } from "../support/pystr.ts";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../flow/flow.ts";
import { PlanningRules, TaskPlan } from "../engine/plan.ts";
import type { Subgoal } from "../engine/plan.ts";
import { validateSignalSpec } from "../engine/signals.ts";
import { getAppAdapter, listAppAdapterObjects, webStepForPlan } from "./app-adapters.ts";
import type { AppAdapter } from "./app-adapters.ts";
import { loadSource } from "../data/datasource.ts";
import { extractSlots } from "../engine/extraction.ts";
import { PACK_KEYS, SPEC_VERSION, appStepKeys, DEVICE_KEYS } from "./app-pack.ts";
import type { AppPack } from "./app-pack.ts";
import { adapterKind, stepKind, substitute, RUNTIME_PLACEHOLDERS } from "./pack-expand.ts";
import { POLICY_KEYS, RISK_ASK_MODES, NAVIGATION_MODES, ACT_HINT_MODES, ACT_HINT_TIER_MODES, TARGET_RESOLUTION_MODES, ATTR_VALUE_MATCH_MODES, BROWSER_CHANNELS, validatePolicyExtras } from "./pack-policy.ts";

type ValidatePackOptions = {
  slots?: Record<string, unknown>;
  sources?: string[];
  allowEmptyJourney?: boolean;
};

/** 加载期校验 `site` 块（形状错 = 报清楚，别等运行期取不到）。 */
export function validateSiteBlock(site: unknown, where: string, p: string[]): void {
  if (!isDict(site)) { p.push(`${where} must be an object`); return; }
  for (const k of Object.keys(site)) {
    if (k !== "pages" && k !== "listExtract") p.push(`${where}.${k}: unknown key (known: pages, listExtract)`);
  }
  if (site["pages"] !== undefined) {
    if (!isDict(site["pages"])) p.push(`${where}.pages must be an object of role -> url`);
    else {
      for (const [role, url] of Object.entries(site["pages"] as Record<string, unknown>)) {
        if (typeof url !== "string" || !url.trim()) p.push(`${where}.pages.${role}: non-empty url string required`);
      }
    }
  }
  if (site["listExtract"] !== undefined) {
    if (!isDict(site["listExtract"])) {
      p.push(`${where}.listExtract must be an object of name -> {rows, fields}`);
    } else {
      for (const [name, spec] of Object.entries(site["listExtract"] as Record<string, unknown>)) {
        const at = `${where}.listExtract.${name}`;
        if (!isDict(spec)) { p.push(`${at}: must be {rows, fields}`); continue; }
        for (const k of Object.keys(spec)) {
          if (k !== "rows" && k !== "fields") p.push(`${at}.${k}: unknown key (known: rows, fields)`);
        }
        if (typeof spec["rows"] !== "string" || !spec["rows"].trim()) p.push(`${at}.rows: non-empty selector string required`);
        if (!isDict(spec["fields"])) {
          p.push(`${at}.fields must be an object of field -> selector`);
        } else {
          for (const [field, sel] of Object.entries(spec["fields"] as Record<string, unknown>)) {
            if (typeof sel !== "string" || !sel.trim()) p.push(`${at}.fields.${field}: non-empty selector string required`);
          }
        }
      }
    }
  }
}

function validatePackHeaderFields(pack: AppPack, p: string[]): void {
  for (const k of Object.keys(pack)) {
    if (!(PACK_KEYS as readonly string[]).includes(k) && !k.startsWith("_")) {
      p.push(`${k}: unknown pack key (known: ${PACK_KEYS.join(", ")})`);
    }
  }

  if (pack.spec_version !== SPEC_VERSION) {
    p.push(`spec_version must be ${SPEC_VERSION} (got ${JSON.stringify(pack.spec_version)})`);
  }

  for (const k of ["id", "label", "goal"] as const) {
    if (typeof pack[k] !== "string" || !pack[k]) p.push(`${k} is required`);
  }

  // G-H：几个"看着能用其实会误导"的类型错误在加载期就报。最典型的是把 `sources` 写成**裸字符串**
  // ——它会被当列表逐字符遍历，于是报出一串"未知数据源"的伪错误，把人引到错的方向。
  if (pack.max_subgoals !== undefined
    && (!Number.isInteger(pack.max_subgoals) || pack.max_subgoals < 1)) {
    p.push("max_subgoals must be a positive integer");
  }

  if (pack.slots !== undefined && !isDict(pack.slots)) {
    p.push("slots must be an object of slot -> value");
  }

  if (pack.site !== undefined) validateSiteBlock(pack.site, "site", p);

  if (pack.required_slots !== undefined
    && (!Array.isArray(pack.required_slots) || pack.required_slots.some((x) => typeof x !== "string"))) {
    p.push("required_slots must be a list of slot names");
  }

  if (pack.sources !== undefined
    && (!Array.isArray(pack.sources) || pack.sources.some((x) => typeof x !== "string"))) {
    p.push("sources must be a list of source names (a bare string would be read as a list of characters)");
  }

  // 数据腿回写槽位：取值点必须在**数据源自己的声明里**真的存在——
  // "写了一个永远取不到的 select 名"在运行期只会表现为"槽位没值"，而那与"数据源没查到"
  // 长得一模一样。加载期点名，两种失败就不必靠猜。
  if (pack.source_slots !== undefined) {
    if (!isDict(pack.source_slots)) {
      p.push("source_slots must be an object of slot -> {source, select|count, field?}");
    } else {
      const declared = new Set((Array.isArray(pack.sources) ? pack.sources : []).map((x) => String(x)));
      for (const [slot, raw] of Object.entries(pack.source_slots)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(slot)) {
          p.push(`source_slots.${slot}: slot names must match [A-Za-z_][A-Za-z0-9_]* (a {slot} placeholder can only name such a slot)`);
          continue;
        }
        if (!isDict(raw)) {
          p.push(`source_slots.${slot} must be an object {source, select|count, field?}`);
          continue;
        }
        const src = raw["source"];
        if (typeof src !== "string" || !src) {
          p.push(`source_slots.${slot}.source is required (which source's result fills this slot)`);
          continue;
        }
        if (!declared.has(src)) {
          p.push(`source_slots.${slot}.source ${JSON.stringify(src)} is not one of this pack's sources`
            + ` (declared: ${[...declared].join(", ") || "none"})`);
          continue;
        }
        const sel = raw["select"];
        const cnt = raw["count"];
        if ((sel === undefined) === (cnt === undefined)) {
          p.push(`source_slots.${slot} needs exactly one of .select (a row) or .count (a number)`);
          continue;
        }
        if (raw["field"] !== undefined && typeof raw["field"] !== "string") {
          p.push(`source_slots.${slot}.field must be a string`);
        }
        try {
          const conf = loadSource(src) as unknown as Record<string, unknown>;
          // `selects` / `counts` 在数据源里是**列表**（`[{key, label, sort_by}]`），不是字典。
          const keysOf = (k: string): string[] => {
            const v = conf[k];
            return Array.isArray(v)
              ? v.map((x) => (isDict(x) ? String(x["key"] ?? "") : "")).filter(Boolean)
              : isDict(v) ? Object.keys(v) : [];
          };
          if (sel !== undefined) {
            const keys = keysOf("selects");
            if (!keys.includes(String(sel))) {
              p.push(`source_slots.${slot}.select ${JSON.stringify(String(sel))} is not declared by source `
                + `${JSON.stringify(src)} (declares: ${keys.join(", ") || "none"})`);
            }
          } else {
            const keys = keysOf("counts");
            if (!keys.includes(String(cnt))) {
              p.push(`source_slots.${slot}.count ${JSON.stringify(String(cnt))} is not declared by source `
                + `${JSON.stringify(src)} (declares: ${keys.join(", ") || "none"})`);
            }
          }
        } catch {
          /* 数据源本身找不到：下面"数据腿"那段会点名它，这里不重复报 */
        }
      }
    }
  }

  if (pack.model !== undefined && typeof pack.model !== "string") {
    p.push("model must be a string");
  }

  if (pack.pace !== undefined) {
    if (!isDict(pack.pace)) {
      p.push("pace must be an object {between_steps_ms, between_actions_ms}");
    } else {
      for (const k of Object.keys(pack.pace)) {
        if (k !== "between_steps_ms" && k !== "between_actions_ms") {
          p.push(`pace.${k}: unknown key (known: between_steps_ms, between_actions_ms)`);
        }
      }
      for (const k of ["between_steps_ms", "between_actions_ms"] as const) {
        const v = (pack.pace as Record<string, unknown>)[k];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 60_000) {
          p.push(`pace.${k}: must be an integer 0..60000 (got ${JSON.stringify(v)})`);
        }
      }
    }
  }

  // `hosts` 必须是字符串列表：防泄漏门禁（`tools/apps_matrix.ts`）会逐项遍历它。
  // 写成裸字符串虽然能被 `validateProbeBlock` 的 `asList` 容忍，但门禁会按**字符**建 token
  // （`\bm\b` 之类），既漏掉真主机又刷出一堆假泄漏 —— 所以在加载期就拒绝。
  if (pack.hosts !== undefined && (!Array.isArray(pack.hosts) || pack.hosts.some((h) => typeof h !== "string"))) {
    p.push("hosts must be a list of strings (the leak gate iterates it)");
  }
}

function validateJourneyShape(pack: AppPack, opts: ValidatePackOptions, p: string[]): boolean {
  if (!Array.isArray(pack.journey)) {
    p.push("journey must be a list of steps");
    return false;
  }

  if (pack.journey.length === 0 && pack.probe === undefined && !opts.allowEmptyJourney) {
    // 空旅程只有一个合法理由：这是**测量型应用**（只声明探针集，没有要跑的旅程）。
    // L2 脚本（flow 模式）是第二个理由：步骤在运行期产生（见 allowEmptyJourney）。
    p.push("journey must be a non-empty list of steps (or declare a probe set)");
    return false;
  }

  if (pack.roles !== undefined && !isDict(pack.roles)) p.push("roles must be an object of step templates");

  if (pack.invariants !== undefined && !Array.isArray(pack.invariants)) p.push("invariants must be a list");

  if (pack.required_slots !== undefined && !Array.isArray(pack.required_slots)) {
    p.push("required_slots must be a list of slot names");
  }
  return true;
}

function validateStepDeclarations(pack: AppPack, roles: Record<string, Record<string, unknown>>, p: string[]): void {
  /** 其它适配器的专属键写在当前步上 = "写了没用"：点名谁的类型，加载期红。 */
  const checkForeignKeys = (step: Record<string, unknown>, where: string, adapter: AppAdapter): void => {
    for (const other of listAppAdapterObjects()) {
      if (other.kind === adapter.kind) continue;
      for (const k of other.stepKeys) {
        if (step[k] === undefined) continue;
        if ((adapter.stepKeys as readonly string[]).includes(k)) continue;
        const suffix = adapter.kind === "cli" ? ` (source=${JSON.stringify(String(step["source"]))})` : "";
        p.push(`${where}.${k}: ${other.label}-only key on a ${adapter.label} step${suffix}`);
      }
    }
  };

  const checkStep = (step: Record<string, unknown>, where: string): void => {
    const keys = appStepKeys();
    for (const k of Object.keys(step)) {
      if (!keys.includes(k) || k === "role") {
        p.push(`${where}.${k}: unknown step key (known: ${keys.filter((x) => x !== "role").join(", ")})`);
      }
    }
    const kind = adapterKind(step);
    const adapter = getAppAdapter(kind);
    if (adapter === undefined) {
      p.push(`${where}.adapter: unknown app adapter ${JSON.stringify(kind)} `
        + `(known: ${listAppAdapterObjects().map((a) => a.kind).join(", ")})`);
      return;
    }
    checkForeignKeys(step, where, adapter);
    adapter.validateStep(step, where, p);
  };

  for (const [name, tpl] of Object.entries(roles)) {
    if (!isDict(tpl)) { p.push(`roles.${name} must be an object`); continue; }
    checkStep(tpl as Record<string, unknown>, `roles.${name}`);
    if (stepKind(tpl as Record<string, unknown>) === "browser" && !tpl["desc"]) {
      p.push(`roles.${name} needs desc and signal`);
    }
  }

  pack.journey.forEach((entry, i) => {
    if (!isDict(entry)) { p.push(`journey[${i}] must be an object`); return; }
    const roleName = entry["role"];
    if (roleName !== undefined && !(String(roleName) in roles)) {
      p.push(`journey[${i}]: unknown role ${JSON.stringify(String(roleName))}`);
    }
    if (roleName === undefined) {
      checkStep(entry, `journey[${i}]`);
    } else {
      // 角色模板已经校验过；内联覆盖只允许"补字段"，键集合再查一遍
      for (const k of Object.keys(entry)) {
        if (!appStepKeys().includes(k)) p.push(`journey[${i}].${k}: unknown step key`);
      }
      // 合并后**类型互斥键**仍要查：角色模板走 checkStep，内联覆盖也必须连类型一起查——
      // 只查键名时 `{role: <浏览器角色>, args:[...]}` 会把 args 静默丢掉（"写了没用"）。
      const tpl = roles[String(roleName)];
      if (isDict(tpl)) {
        const merged = { ...tpl, ...entry };
        const adapter = getAppAdapter(adapterKind(merged));
        if (adapter?.kind === "web" && !merged["start_url"]) {
          p.push(`journey[${i}]: a browser step needs start_url (neither the role nor the override has one)`);
        }
        if (adapter !== undefined) {
          for (const other of listAppAdapterObjects()) {
            if (other.kind === adapter.kind) continue;
            for (const k of other.stepKeys) {
              if (merged[k] === undefined) continue;
              if ((adapter.stepKeys as readonly string[]).includes(k)) continue;
              const suffix = adapter.kind === "cli"
                ? ` (source=${JSON.stringify(String(merged["source"]))})` : "";
              p.push(`journey[${i}].${k}: ${other.label}-only key on a ${adapter.label} step${suffix}`);
            }
          }
        }
      }
    }
  });
}

function validateJourneyEdges(pack: AppPack, roles: Record<string, Record<string, unknown>>, p: string[]): void {
  // P4 走向：步 id 必须唯一，`next` 的落点必须在**同一个旅程**里真的存在。
  // 一条指向空气的边如果拖到运行期才发现，"分支"就变成了一步都不走的静默跳过——
  // 与 hint 未命中不赌同一条纪律：加载期红。
  {
    const merged: Array<Record<string, unknown>> = pack.journey.map((e, i) => {
      if (!isDict(e)) return { __bad: i } as Record<string, unknown>;
      const rn = e["role"];
      const tpl = rn !== undefined && isDict(roles[String(rn)]) ? roles[String(rn)]! : {};
      return { ...tpl, ...e };
    });
    const idAt = new Map<string, number>();
    merged.forEach((m, i) => {
      const id = m["id"];
      if (id === undefined || id === null) return;
      if (typeof id !== "string" || !id.trim()) {
        p.push(`journey[${i}].id must be a non-empty string`);
        return;
      }
      if (idAt.has(id)) p.push(`journey[${i}]: duplicate step id '${id}' (next edges need one name per step)`);
      else idAt.set(id, i);
    });
    merged.forEach((m, i) => {
      const next = m["next"];
      if (next === undefined || next === null) return;
      if (!Array.isArray(next) || next.length === 0
          || !next.every((x) => typeof x === "string" && x.trim() !== "")) {
        p.push(`journey[${i}].next must be a non-empty list of step ids`);
        return;
      }
      for (const t of next) {
        if (!idAt.has(String(t))) {
          p.push(`journey[${i}].next: ${JSON.stringify(String(t))} names no step in this journey`
            + ` (declared ids: ${[...idAt.keys()].join(", ") || "none"})`);
        }
      }
    });
    if (pack.max_step_visits !== undefined
        && (typeof pack.max_step_visits !== "number" || !Number.isInteger(pack.max_step_visits)
            || pack.max_step_visits < 1)) {
      p.push("max_step_visits must be a positive integer (the per-path visit bound of `next` edges)");
    }
  }

  // Slice 2（应用支持器）：返回值传递的**加载期对账**——
  //   ① `returns.NAME` 的产者在一个旅程里唯一（同名两产者 = 谁写的说不清，审计也说不清）；
  //   ② `{dataset:NAME}` 的消费者必须真有产者（否则运行期必然 needs_value：那是"写了没用"的静默版）。
  {
    const DATASET_REF = /\{dataset:([A-Za-z_][A-Za-z0-9_]*)\}/g;
    const producers = new Map<string, number>();
    const refs: Array<{ name: string; where: string }> = [];
    const scanRefs = (value: unknown, where: string): void => {
      if (typeof value === "string") {
        for (const m of value.matchAll(DATASET_REF)) refs.push({ name: m[1]!, where });
        return;
      }
      if (Array.isArray(value)) { value.forEach((v, i) => scanRefs(v, `${where}[${i}]`)); return; }
      if (isDict(value)) for (const [k, v] of Object.entries(value)) scanRefs(v, `${where}.${k}`);
    };
    pack.journey.forEach((e, i) => {
      if (!isDict(e)) return;
      const rn = e["role"];
      const tpl = rn !== undefined && isDict(roles[String(rn)]) ? roles[String(rn)]! : {};
      const merged = { ...tpl, ...e };
      const ret = merged["returns"];
      if (isDict(ret)) {
        for (const name of Object.keys(ret)) {
          const prev = producers.get(name);
          if (prev !== undefined) {
            p.push(`journey[${i}].returns.${name}: also produced by journey[${prev}] (returns names must be unique)`
              + ` — the dataset would silently keep whichever wrote last`);
          } else producers.set(name, i);
        }
      }
      scanRefs(merged, `journey[${i}]`);
    });
    scanRefs(pack.invariants ?? [], "invariants");
    for (const ref of refs) {
      if (!producers.has(ref.name)) {
        p.push(`${ref.where}: {dataset:${ref.name}} has no producer — no step declares `
          + `returns.${ref.name} (a value that never gets written is a silent needs_value; declare it)`);
      }
    }
  }
}

function validateDependenciesAndProvenance(pack: AppPack, declaredSlots: Record<string, unknown>, p: string[]): void {
  // 占位符必须指向已声明的槽位（`required_slots` 或 `slots` 里给了值）。
  // `invariants` 与 journey 同规则：结束状态断言里写 `{checkin}` 不替换的话，
  // 那条断言会拿字面量去比对一个永远不会相等的值——**静默假红**，比不写更糟。
  const seen: string[] = [];

  substitute({ roles: pack.roles ?? {}, journey: pack.journey, invariants: pack.invariants ?? [] },
    { ...RUNTIME_PLACEHOLDERS, ...declaredSlots }, seen);

  for (const s of [...new Set(seen)]) p.push(s);

  // 数据腿：引用的数据源必须真的存在（发现制，不维护清单）
  for (const s of Array.isArray(pack.sources) ? pack.sources : []) {
    try {
      loadSource(String(s));
    } catch (e) {
      p.push(`source ${JSON.stringify(String(s))} not found (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  if (pack.device !== undefined) {
    if (!isDict(pack.device)) {
      p.push("device must be an object");
    } else {
      for (const [k, v] of Object.entries(pack.device)) {
        if (!(DEVICE_KEYS as readonly string[]).includes(k)) {
          p.push(`device.${k}: unknown key (known: ${DEVICE_KEYS.join(", ")})`);
        }
        if (k === "viewport" && (!isDict(v) || !Number.isFinite(Number(v["width"])) || !Number.isFinite(Number(v["height"])))) {
          p.push("device.viewport must be {width, height}");
        }
        if (k === "user_agent" && (typeof v !== "string" || !v.trim())) {
          p.push("device.user_agent must be a non-empty string");
        }
      }
    }
  }

  if (pack.generated_from !== undefined) {
    const g = pack.generated_from as Record<string, unknown>;
    if (!isDict(g)) {
      p.push("generated_from must be an object {spec, plan_sha256}");
    } else {
      // 两种上游二选一：spec 文件，或 `<模块>#<导出名>`（导出函数返回一份应用级计划）
      const kind = typeof g["spec"] === "string" ? "spec" : typeof g["source"] === "string" ? "source" : null;
      if (kind === null) {
        p.push("generated_from needs either .spec or .source");
      } else if (kind === "spec" && typeof g["source"] === "string") {
        p.push("generated_from must not carry both .spec and .source");
      } else {
        const raw = String(g[kind]);
        if (!raw.trim()) {
          p.push(`generated_from.${kind} must be a non-empty string`);
        } else if (kind === "spec") {
          if (!fs.existsSync(path.resolve(REPO, raw))) {
            p.push(`generated_from.spec ${JSON.stringify(raw)} does not exist`);
          }
        } else {
          const [file, fn] = raw.split("#");
          if (!file || !fn) {
            p.push(`generated_from.source must look like "<module>#<export>", got ${JSON.stringify(raw)}`);
          } else if (!fs.existsSync(path.resolve(REPO, file))) {
            p.push(`generated_from.source module ${JSON.stringify(file)} does not exist`);
          }
        }
      }
      if (typeof g["plan_sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(String(g["plan_sha256"]))) {
        p.push("generated_from.plan_sha256 must be a sha256 hex string");
      }
      for (const k of Object.keys(g)) {
        if (!["spec", "source", "plan_sha256"].includes(k)) p.push(`generated_from.${k}: unknown key`);
      }
    }
  }

  if (pack.recorded_from !== undefined) {
    const r = pack.recorded_from as Record<string, unknown>;
    if (!isDict(r)) {
      p.push("recorded_from must be an object {url, steps, sha256}");
    } else {
      if (typeof r["url"] !== "string" || !r["url"].trim()) p.push("recorded_from.url must be a non-empty string");
      if (!Number.isInteger(r["steps"]) || Number(r["steps"]) <= 0) p.push("recorded_from.steps must be a positive integer");
      if (typeof r["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(String(r["sha256"]))) {
        p.push("recorded_from.sha256 must be a sha256 hex string (re-run npm run learn)");
      }
      for (const k of Object.keys(r)) {
        if (!["url", "steps", "sha256"].includes(k)) p.push(`recorded_from.${k}: unknown key`);
      }
    }
  }
}

function validateInvariants(pack: AppPack, roles: Record<string, Record<string, unknown>>, opts: ValidatePackOptions, p: string[]): void {
  for (const [i, inv] of (pack.invariants ?? []).entries()) {
    if (!isDict(inv) || !inv["id"] || !isDict(inv["signal"])) {
      p.push(`invariants[${i}] needs {id, signal}`);
      continue;
    }
    const where = `invariants[${i}]`;
    if (typeof inv["id"] !== "string" || !inv["id"].trim()) p.push(`${where}.id must be a non-empty string`);
    if (inv["desc"] !== undefined && typeof inv["desc"] !== "string") p.push(`${where}.desc must be a string`);
    const kind = inv["adapter"] === undefined || inv["adapter"] === null
      ? "web" : String(inv["adapter"]).trim().toLowerCase();
    const adapter = getAppAdapter(kind);
    if (adapter === undefined) {
      p.push(`${where}.adapter: unknown app adapter ${JSON.stringify(kind)} `
        + `(known: ${listAppAdapterObjects().map((a) => a.kind).join(", ")})`);
      continue;
    }
    if (kind === "web") {
      // web 不变量：旧口径（在浏览器结束态上求值），不允许写成"探针"绕过 end-state 语义。
      const allowed = new Set(["id", "desc", "adapter", "signal"]);
      for (const k of Object.keys(inv)) {
        if (!allowed.has(k)) p.push(`${where}.${k}: unknown key on a web invariant (known: id, desc, adapter, signal)`);
      }
      // 信号语法也要在这里查：flow 应用没有 journey，旧路径（TaskPlan 展开）永远不会走，
      // 于是 `signal: { url_containz: ... }` 这种 typo 在 check 期全绿、运行期才炸（实测）。
      p.push(...validateSignalSpec(inv["signal"], `${where}.signal`));
      continue;
    }
    // 进程族探针不变量：声明面 = 该适配器的步键 + {id, desc, adapter, signal}；
    // 但"断言"不许重试、不许是危险动作（证据不能靠重跑/副作用换）。
    const allowed = new Set<string>(["id", "desc", "adapter", "signal", ...adapter.stepKeys]);
    for (const k of Object.keys(inv)) {
      if (!allowed.has(k)) {
        p.push(`${where}.${k}: unknown key on a ${adapter.label} invariant `
          + `(known: id, desc, adapter, signal${adapter.stepKeys.length ? ", " + adapter.stepKeys.join(", ") : ""})`);
      }
    }
    if (inv["retries"] !== undefined) p.push(`${where}.retries: 不变量探针不许重试（断言只能观察一次真实状态）`);
    if (inv["dangerous"] === true) p.push(`${where}.dangerous: 不变量探针必须是只读观察，不许声明危险动作`);
    if (inv["when"] !== undefined) p.push(`${where}.when: 不变量探针在旅程结束后无条件执行，不接受 when`);
    // 借用适配器自己的声明面校验（键语义/信号语言/返回值形状）
    adapter.validateStep({ ...inv, desc: String(inv["desc"] ?? inv["id"]) }, where, p);
  }

  // web 不变量需要浏览器步（它们在浏览器结束态上求值）；进程族探针不需要页面。
  const webInvariants = (pack.invariants ?? []).filter((inv) => isDict(inv)
    && (inv["adapter"] === undefined || inv["adapter"] === null || inv["adapter"] === "web"));

  if (webInvariants.length > 0 && !opts.allowEmptyJourney
    && !pack.journey.some((e) => stepKind((e["role"] ? { ...(roles[String(e["role"])] ?? {}), ...e } : e) as Record<string, unknown>) === "browser")) {
    p.push("web invariants need at least one browser step (they are evaluated on the browser end state); "
      + "process invariants can run without a browser");
  }
}

function validatePlanExpansion(pack: AppPack, roles: Record<string, Record<string, unknown>>, slots: Record<string, unknown>, _opts: ValidatePackOptions, p: string[]): void {
  // 展开成计划后再用计划自己的校验器过一遍（信号/hint/when/retries 一套口径）。
  // 只有**浏览器步**进计划；工具步的信号是进程观察面的，它们已经在上面按 TOOL_SIGNAL_OPS 校验过。
  if (!p.length) {
    try {
      const browserSteps = pack.journey.map((e) => {
        const merged = e["role"] ? { ...(roles[String(e["role"])] ?? {}), ...e } : { ...e };
        delete merged["role"];
        const substituted = substitute(merged, { ...RUNTIME_PLACEHOLDERS, ...slots }, []) as Record<string, unknown>;
        // U2b：`value_binding` 在计划面的视图 = 一项 fill 命令（与 webAdapter.expand 同一份转换）。
        // 这一步不能省：否则计划面看不到值绑定，槽位名写错要等运行期才变成 needs_value。
        return adapterKind(substituted) === "web" ? webStepForPlan(substituted) : substituted;
      }).filter((step) => stepKind(step) === "browser");
      if (browserSteps.length) {
        const plan = new TaskPlan(pack.goal, browserSteps as unknown as Array<Partial<Subgoal>>,
          ":memory:", slots);
        const rules = new PlanningRules(pack.max_subgoals ?? 12, true, false);
        // `next` 的落点按**整个旅程**校验（工具步不进计划，但可以是边的落点）。
        const journeyIds = new Set<string>();
        pack.journey.forEach((e) => {
          if (!isDict(e)) return;
          const rn = e["role"];
          const tpl = rn !== undefined && isDict(roles[String(rn)]) ? roles[String(rn)]! : {};
          const id = { ...tpl, ...e }["id"];
          if (typeof id === "string" && id.trim() !== "") journeyIds.add(id);
        });
        // 已知的数据袋键 = 包声明的槽位 + CLI 覆盖 + **目标文本里的 `k=v`** + 角色/步自带的 slots。
        // 四样缺一样都会把合法的绑定判成"未声明"（假红），所以在这里一次算全。
        const slotKeys = new Set<string>([
          ...Object.keys(slots),
          ...Object.keys(extractSlots(pack.goal ?? "")),
          ...pack.journey.flatMap((e) => (isDict(e) && isDict(e["slots"]) ? Object.keys(e["slots"]) : [])),
          ...Object.values(roles).flatMap((r) => (isDict(r) && isDict(r["slots"]) ? Object.keys(r["slots"]) : [])),
        ]);
        // 声明式 journey 里工具步的 returns/ctx.run 就是数据集产者——`{from:"dataset"}`
        // 在这面合法；计划面（plan run 无注入入口）由 plan.problems 默认 fail closed。
        p.push(...rules.problems(plan, { extraIds: journeyIds, slotKeys, allowDatasetBindings: true })
          .map((x) => `plan: ${x}`));
      }
    } catch (e) {
      p.push(`plan: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export function validatePack(pack: AppPack,
  opts: {
    slots?: Record<string, unknown>; sources?: string[];
    /**
     * L2 脚本（`flow(ctx)`）没有静态旅程：步骤在运行期由脚本产生。
     * 打开它只跳过"空旅程"与"web 不变量需要浏览器步"这两条**结构性**检查，
     * 其余（信号/hint/命令/槽位/数据源/device/policy）照旧——步骤级校验发生在
     * 每次 `ctx.step` 调用（同一套 `PlanningRules`/`validateCommands`）。
     */
    allowEmptyJourney?: boolean;
  } = {}): string[]  {
  const p: string[] = [];
  if (!isDict(pack)) return ["pack must be a JSON object"];
  validatePackHeaderFields(pack, p);
  // 旅程结构不成立时立即返回：后续校验都建立在"journey 是步骤列表"之上。
  if (!validateJourneyShape(pack, opts, p)) return p;
  // 类型不对时用空袋兜住下游遍历：加载期只该报**那一条**真错，不该再刷出一串"逐字符"的伪错误。
  const slotsDict = isDict(pack.slots) ? pack.slots : {};
  const slots = { ...slotsDict, ...(opts.slots ?? {}) };
  /**
   * **占位符的声明集**：数据腿回写的槽位在加载期还没有值（要等数据腿跑完才有），
   * 但它们是**已声明**的槽位——旅程里写 `{top_anime_url}` 不该在加载期就被判未知。
   * 真没填上（数据源没查到、`--no-sources`）时，展开期拿的是**真实值袋**再替一次，
   * 那时它才是真的未知槽位，并且会响亮地炸——不是静默回落到一个空字符串。
   */
  const declaredSlots: Record<string, unknown> = { ...slots };
  if (isDict(pack.source_slots)) {
    for (const k of Object.keys(pack.source_slots)) {
      if (!(k in declaredSlots)) declaredSlots[k] = "";
    }
  }
  for (const s of Array.isArray(pack.required_slots) ? pack.required_slots : []) {
    if (!(String(s) in slots)) p.push(`required slot ${JSON.stringify(String(s))} has no value`);
  }
  const roles: Record<string, Record<string, unknown>> = pack.roles ?? {};
  validateStepDeclarations(pack, roles, p);
  validateJourneyEdges(pack, roles, p);
  validateDependenciesAndProvenance(pack, declaredSlots, p);
  validateInvariants(pack, roles, opts, p);
  validatePlanExpansion(pack, roles, slots, opts, p);
  validatePolicy(pack, p);
  return p;
}

function validatePolicy(pack: AppPack & Record<string, unknown>, p: string[]): void {
  const pol = (pack as Record<string, unknown>)["policy"];
  if (pol !== undefined) {
    if (!isDict(pol)) {
      p.push(`policy: must be an object (keys: ${POLICY_KEYS.join(", ")})`);
    } else {
      for (const k of Object.keys(pol)) {
        if (!(POLICY_KEYS as readonly string[]).includes(k) && !k.startsWith("_")) {
          p.push(`policy.${k}: unknown policy key (known: ${POLICY_KEYS.join(", ")})`);
        }
      }

      if (pol["tiered_hint"] !== undefined && typeof pol["tiered_hint"] !== "boolean") {
        p.push("policy.tiered_hint: must be a boolean");
      }

      if (pol["reobserve"] !== undefined && typeof pol["reobserve"] !== "boolean") {
        p.push("policy.reobserve: must be a boolean");
      }

      if (pol["risk_ask"] !== undefined && !(RISK_ASK_MODES as readonly string[]).includes(String(pol["risk_ask"]))) {
        p.push(`policy.risk_ask: must be one of ${RISK_ASK_MODES.join(" | ")}`);
      }

      const mer = pol["max_effective_repeats"];

      if (mer !== undefined && (typeof mer !== "number" || !Number.isInteger(mer) || mer < 1)) {
        p.push("policy.max_effective_repeats: must be an integer >= 1");
      }

      const cf = pol["conf_floor"];

      if (cf !== undefined && (typeof cf !== "number" || !Number.isFinite(cf) || cf <= 0 || cf > 1)) {
        p.push("policy.conf_floor: must be a number in (0, 1]");
      }

      const cp = pol["candidate_priority"];

      if (cp !== undefined && cp !== "bucketed" && cp !== "main-first") {
        p.push('policy.candidate_priority: must be one of "bucketed" | "main-first"');
      }

      // U3：两个新策略键与 settle 同待遇——dry/apps check 期就校验，写了就要生效。
      const pg = pol["pool_gate"];

      if (pg !== undefined && pg !== "fact" && pg !== "strict") {
        p.push('policy.pool_gate: must be one of "fact" | "strict"');
      }

      const nav = pol["navigation"];

      if (nav !== undefined && !(NAVIGATION_MODES as readonly string[]).includes(String(nav))) {
        p.push(`policy.navigation: unknown value ${JSON.stringify(String(nav))} (config_error; must be one of ${NAVIGATION_MODES.map((x) => JSON.stringify(x)).join(" | ")})`);
      }

      const ah = pol["act_hint"];

      if (ah !== undefined && !(ACT_HINT_MODES as readonly string[]).includes(String(ah))) {
        p.push(`policy.act_hint: unknown value ${JSON.stringify(String(ah))} (config_error; must be one of ${ACT_HINT_MODES.map((x) => JSON.stringify(x)).join(" | ")})`);
      }

      // A3：弱档算不算命中——合法值闭集在加载期响亮拒绝（同 act_hint 先例）。
      const aht = pol["act_hint_tier"];

      if (aht !== undefined && !(ACT_HINT_TIER_MODES as readonly string[]).includes(String(aht))) {
        p.push(`policy.act_hint_tier: unknown value ${JSON.stringify(String(aht))} (config_error; must be one of ${ACT_HINT_TIER_MODES.map((x) => JSON.stringify(x)).join(" | ")})`);
      }

      const tr = pol["target_resolution"];

      if (tr !== undefined && !(TARGET_RESOLUTION_MODES as readonly string[]).includes(String(tr))) {
        p.push(`policy.target_resolution: unknown value ${JSON.stringify(String(tr))} (config_error; must be one of ${TARGET_RESOLUTION_MODES.map((x) => JSON.stringify(x)).join(" | ")})`);
      }

      // F74：DOM 回退跳——布尔键，非法值响亮拒绝（同 act_hint 先例）。
      const ahdf = pol["act_hint_dom_fallback"];

      if (ahdf !== undefined && ahdf !== true && ahdf !== false) {
        p.push(`policy.act_hint_dom_fallback: must be a boolean (got ${JSON.stringify(String(ahdf))}; true = 声明 act hint 解析链全落空后补一次主帧 ADMIT_SEL DOM 回退跳)`);
      }

      // A1：属性值匹配底座——合法值闭集在加载期响亮拒绝（同 navigation/act_hint 先例）。
      const avm = pol["attr_value_match"];

      if (avm !== undefined && !(ATTR_VALUE_MATCH_MODES as readonly string[]).includes(String(avm))) {
        p.push(`policy.attr_value_match: unknown value ${JSON.stringify(String(avm))} (config_error; must be one of ${ATTR_VALUE_MATCH_MODES.map((x) => JSON.stringify(x)).join(" | ")})`);
      }

      // F84 批 3（deny-list 可配化）：hint_token_allow 形状校验——字符串数组、每项非空且
      // 无内部空白、≤40 字符、至多 16 项；比较时小写折叠（consumption 侧）。非法 = config_error
      // （与 F61 信号形态/validateCommands 加载期纪律一致）。评审收口：含 ">" 的项在
      // `suggestHints.tokenOk` 里被结构约束先拒（行锚 token 词法保留字符）——加载期直接拒绝，
      // 不让"写了但永不生效"的放行项存在。
      const hta = pol["hint_token_allow"];

      if (hta !== undefined) {
        if (!Array.isArray(hta)) {
          p.push("policy.hint_token_allow: must be a list of tokens (string[])");
        } else {
          if (hta.length > 16) {
            p.push(`policy.hint_token_allow: ${hta.length} 项超过上限 16（放行表是外科出口不是白名单全集）`);
          }
          for (const [i, tok] of hta.entries()) {
            if (typeof tok !== "string" || tok.trim() === "") {
              p.push(`policy.hint_token_allow[${i}]: must be a non-empty string (got ${JSON.stringify(String(tok))})`);
            } else if (/\s/.test(tok)) {
              p.push(`policy.hint_token_allow[${i}]: 词元不含空白（行词元按空白切分；got ${JSON.stringify(tok)}）`);
            } else if (tok.includes(">")) {
              p.push(`policy.hint_token_allow[${i}]: 词元禁 ">"（行锚 token 词法保留字符；放行表也无法让它生效——got ${JSON.stringify(tok)}）`);
            } else if (tok.length > 40) {
              p.push(`policy.hint_token_allow[${i}]: ${tok.length} 字符超过上限 40`);
            }
          }
        }
      }

      // task-43：浏览器通道——合法值闭集在加载期响亮拒绝（同 navigation/act_hint 先例）。
      const bc = pol["browser"];

      if (bc !== undefined && !(BROWSER_CHANNELS as readonly string[]).includes(String(bc))) {
        p.push(`policy.browser: unknown value ${JSON.stringify(String(bc))} (config_error; must be one of ${BROWSER_CHANNELS.map((x) => JSON.stringify(x)).join(" | ")})`);
      }
      validatePolicyExtras(pol, p);
    }
  }
}

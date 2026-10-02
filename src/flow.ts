/**
 * "The flow is DATA" — TS twin of `transfer/flow.py`.
 *
 * A spec is a LIST of phases (`{phase, stage, repeat, steps}`) expanded in order;
 * `repeat` is one of once/per_date/per_checkin and `stage` says whether the phase
 * runs before the departure date is known (flight) or after it (hotel). Opening a
 * second `per_date` phase IS a two-page search wizard — the loader has no idea
 * what a wizard is. The loader only validates and expands; the site's inventory
 * generator and the independent judge deliberately stay in code.
 *
 * PORT FIX: the Python `migration_metrics` dict literal defines `collect_roles`
 * twice, so the count-based first definition is silently dead (audit finding).
 * The port emits the surviving spec-based `collect_roles` plus the count-based
 * `collect_steps` — observably identical, but no dead key.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIGNAL_OPS, signalArgs, type SignalSpec } from "./signals.ts";
import type { Subgoal } from "./plan.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..");
export const SPECS = path.join(REPO, "transfer", "specs");

export const REPEATS = ["once", "per_date", "per_checkin"] as const;
export const STAGES = ["flight", "hotel"] as const;

export interface FlowStep {
  desc: string;
  path: string;
  query?: Record<string, string>;
  hint?: string;
  hints?: string[];
  signal: SignalSpec;
  when?: SignalSpec;
  slots?: Record<string, string>;
  retries?: number;
  role?: string;
}
export interface FlowPhase {
  phase: string;
  stage?: "flight" | "hotel";
  repeat?: "once" | "per_date" | "per_checkin";
  steps: FlowStep[];
}
export interface FlowSpec {
  name: string;
  site_dir: string;
  site_label?: string;
  language?: string;
  params?: Record<string, unknown>;
  phases: FlowPhase[];
  slots?: Record<string, unknown>;
  collect_roles?: string[];
  ledger_js?: string;
  data_module?: string;
  _path?: string;
  [k: string]: unknown;
}

export const phases = (spec: FlowSpec): FlowPhase[] => [...(spec.phases ?? [])];
export const stagePhases = (spec: FlowSpec, stage: string): FlowPhase[] =>
  phases(spec).filter((ph) => (ph.stage ?? "flight") === stage);

/** Expanded role sequence (phase order × repeat count). Migration metrics align by it, not by position. */
export function specRoles(spec: FlowSpec, dates?: string[] | null): string[] {
  const n = dates ? dates.length : 1;
  const out: string[] = [];
  for (const ph of phases(spec)) {
    const times = { once: 1, per_date: n, per_checkin: 1 }[ph.repeat ?? "once"];
    for (let i = 0; i < times; i++) out.push(...(ph.steps ?? []).map((st) => st.role ?? "?"));
  }
  return out;
}

/* ------------------------------------------------------------------ validate */

/** Structure + signal-language validation: fail at load, not at step 9. */
export function validateSpec(spec: FlowSpec): string[] {
  const problems: string[] = [];
  for (const key of ["name", "site_dir", "phases"] as const) {
    if (!spec[key]) problems.push(`missing '${key}'`);
  }
  const plist = spec.phases;
  if (!Array.isArray(plist) || plist.length === 0) {
    problems.push("phases must be a non-empty LIST of {phase, stage, repeat, steps}");
    return problems;
  }
  if (!plist.some((ph) => (ph.stage ?? "flight") === "flight")) problems.push("no phase with stage 'flight'");
  if (!plist.some((ph) => (ph.stage ?? "flight") === "hotel")) problems.push("no phase with stage 'hotel'");
  if (!fs.existsSync(path.join(REPO, String(spec.site_dir ?? "")))) {
    problems.push(`site_dir does not exist: '${spec.site_dir}'`);
  }
  for (const ph of plist) {
    const name = ph.phase;
    const repeat = ph.repeat ?? "once";
    if (!name) problems.push("a phase is missing 'phase'");
    if (!(REPEATS as readonly string[]).includes(repeat)) {
      problems.push(`phase '${name}': repeat must be one of ${JSON.stringify(REPEATS)}`);
    }
    if (!(STAGES as readonly string[]).includes(ph.stage ?? "flight")) {
      problems.push(`phase '${name}': stage must be one of ${JSON.stringify(STAGES)}`);
    }
    if (!ph.steps?.length) problems.push(`phase '${name}': no steps`);
    (ph.steps ?? []).forEach((step, i) => {
      const tag = `${name}[${i}]`;
      if (!step.desc) problems.push(`${tag}: missing desc`);
      if (!step.path) problems.push(`${tag}: missing path`);
      const hints = step.hints;
      if (!step.hint && !hints) problems.push(`${tag}: missing hint/hints`);
      if (hints !== undefined && (!Array.isArray(hints) || hints.length === 0
          || !hints.every((h) => typeof h === "string" && h.trim() !== ""))) {
        problems.push(`${tag}: hints must be a non-empty list of strings`);
      }
      if (hints && step.hint) problems.push(`${tag}: use hint OR hints, not both`);
      const retries = step.retries;
      if (retries !== undefined
          && (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0)) {
        problems.push(`${tag}: retries must be a non-negative integer`);
      }
      for (const [label, sig] of [["signal", step.signal ?? {}], ["when", step.when ?? {}]] as const) {
        if (label === "signal" && Object.keys(sig).length === 0) problems.push(`${tag}: missing signal`);
        for (const [op, args] of Object.entries(sig)) {
          if (!(op in SIGNAL_OPS)) problems.push(`${tag}: unknown ${label} op '${op}'`);
          else if (signalArgs(args).length !== SIGNAL_OPS[op]) {
            problems.push(`${tag}: ${label} ${op} needs ${SIGNAL_OPS[op]} argument(s)`);
          }
        }
      }
    });
  }
  return problems;
}

export function loadSpec(pathOrName: string): FlowSpec {
  let p = path.resolve(pathOrName);
  const asGiven = pathOrName;
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {   // note: "ctrip" is a directory at the repo root
    const base = path.basename(pathOrName);
    p = path.join(SPECS, base.endsWith(".json") ? base : `${base}.json`);
  }
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
    throw new Error(`no flow spec at '${asGiven}' nor ${p}`);
  }
  const spec = JSON.parse(fs.readFileSync(p, "utf-8")) as FlowSpec;
  const problems = validateSpec(spec);
  if (problems.length) throw new Error(`flow spec ${p} is invalid:\n  ${problems.join("\n  ")}`);
  spec._path = p;
  return spec;
}

/* ------------------------------------------------------------------ expand */

/** Placeholders = site params + this step's context (date/wd/checkin). */
function fmt(text: string, spec: FlowSpec, ctx: Record<string, unknown>): string {
  const values: Record<string, unknown> = { ...(spec.params ?? {}), site_label: spec.site_label ?? "", ...ctx };
  return String(text).replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (!(name in values)) {
      throw new Error(`unknown placeholder '{${name}}' in '${text}' (known: ${JSON.stringify(Object.keys(values).sort())})`);
    }
    return String(values[name]);
  });
}

/** `path` + `query` -> file:// URL; the query is always urlencoded (CJK city names). */
export function stepUrl(spec: FlowSpec, step: FlowStep, ctx: Record<string, unknown>): string {
  const base = path.resolve(REPO, spec.site_dir);
  const p = fmt(step.path, spec, ctx);
  const query = Object.fromEntries(Object.entries(step.query ?? {}).map(([k, v]) => [k, fmt(v, spec, ctx)]));
  const url = new URL(`file://${path.join(base, p)}`).href;
  const qs = new URLSearchParams(query).toString();
  return url + (qs ? `?${qs}` : "");
}

/** Build a URL for one path (None params omitted) — for tests and manual runs. */
export function urlFor(spec: FlowSpec, p: string, params: Record<string, unknown> = {}): string {
  const base = path.resolve(REPO, spec.site_dir);
  const q = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => [k, String(v)]));
  const url = new URL(`file://${path.join(base, p)}`).href;
  const qs = new URLSearchParams(q).toString();
  return url + (qs ? `?${qs}` : "");
}

/**
 * One step -> one subgoal. `hint` yields a `target_hint` (authoritative for the
 * whole subgoal); `hints` yields `target_hints` (one hint per action, for
 * "fill → select → submit"); `slots` is the subgoal's own data bag.
 */
function expandPhase(spec: FlowSpec, phase: FlowPhase, ctx: Record<string, unknown>): Subgoal[] {
  const out: Subgoal[] = [];
  for (const step of phase.steps ?? []) {
    const sg: Subgoal = {
      desc: fmt(step.desc, spec, ctx),
      signal: step.signal,
      start_url: stepUrl(spec, step, ctx),
    };
    if (step.hints) sg.target_hints = step.hints.map((h) => fmt(h, spec, ctx));
    else sg.target_hint = fmt(step.hint!, spec, ctx);
    if (step.slots) sg.slots = Object.fromEntries(Object.entries(step.slots).map(([k, v]) => [k, fmt(v, spec, ctx)]));
    if (step.when) sg.when = step.when;               // conditional: skipped when it does not apply
    if (step.retries) sg.retries = Math.trunc(step.retries);   // transient: whole-step retry
    out.push(sg);
  }
  return out;
}

function expandStage(
  spec: FlowSpec, stage: string, dates: string[], checkin: string | null,
  weekdayCn: (d: string) => string,
): Subgoal[] {
  const out: Subgoal[] = [];
  for (const ph of stagePhases(spec, stage)) {
    const repeat = ph.repeat ?? "once";
    if (repeat === "once") out.push(...expandPhase(spec, ph, { checkin: checkin ?? "" }));
    else if (repeat === "per_date") {
      for (const d of dates) {
        out.push(...expandPhase(spec, ph, { date: d, wd: weekdayCn(d), checkin: checkin ?? "" }));
      }
    } else out.push(...expandPhase(spec, ph, { checkin: checkin ?? "" }));   // per_checkin
  }
  return out;
}

export const deriveFlightSubgoals = (spec: FlowSpec, dates: string[], weekdayCn: (d: string) => string): Subgoal[] =>
  expandStage(spec, "flight", dates, null, weekdayCn);
export const deriveHotelSubgoals = (spec: FlowSpec, checkin: string): Subgoal[] =>
  expandStage(spec, "hotel", [], checkin, (d) => d);
export const deriveSubgoals = (spec: FlowSpec, dates: string[], checkin: string,
                               weekdayCn: (d: string) => string): Subgoal[] =>
  [...deriveFlightSubgoals(spec, dates, weekdayCn), ...deriveHotelSubgoals(spec, checkin)];

export const slots = (spec: FlowSpec): Record<string, unknown> => ({ ...(spec.slots ?? {}) });
export const roles = (spec: FlowSpec, dates?: string[] | null): string[] => specRoles(spec, dates);

/* ------------------------------------------------------------------ metrics */

export interface MigrationMetrics {
  shared_roles: number;
  actions: { baseline: number; other: number };
  desc_identical_raw: string;
  desc_identical_normalized: string;
  normalized_away: string[];
  fields_changed: { target_hint: number; signal: number; start_url: number };
  extra_roles: Record<string, number>;
  extra_subgoals: number;
  collect_steps: { baseline: number; other: number };
  collect_roles: { baseline: string[]; other: string[] };
  subgoals: { baseline: number; other: number };
  shape: { baseline: string[]; other: string[] };
}

/**
 * Shared roles compared field by field: is the description template the same,
 * how many of the triple changed, how many extra steps the collect phase has.
 * Roles align by ROLE, not position, so sites with a different shape do not
 * shift the whole comparison; the site-specific collect tail is counted apart.
 */
export function migrationMetrics(
  baselineSgs: Subgoal[], otherSgs: Subgoal[],
  opts: {
    baselineSpec?: FlowSpec | null; otherSpec?: FlowSpec | null;
    siteLabels?: [string, string]; dates?: string[] | null;
    roleLists?: [string[], string[]] | null;
  } = {},
): MigrationMetrics {
  let { siteLabels = ["携程", "SkyBook"] as [string, string] } = opts;
  const { baselineSpec = null, otherSpec = null, dates = null } = opts;
  let roleLists = opts.roleLists ?? null;
  if (!roleLists && dates && baselineSpec && otherSpec) {
    roleLists = [specRoles(baselineSpec, dates), specRoles(otherSpec, dates)];
  }
  if (!roleLists) {   // no roles given: degrade to positional (legacy call shape)
    roleLists = [baselineSgs.map((_s, i) => `#${i}`), otherSgs.map((_s, i) => `#${i}`)];
  }
  if (baselineSpec && otherSpec) {
    siteLabels = [baselineSpec.site_label ?? siteLabels[0], otherSpec.site_label ?? siteLabels[1]];
  }
  const [baseRoles, otherRoles] = roleLists;
  const baseCollect = new Set(baselineSpec?.collect_roles ?? []);
  const otherCollect = new Set(otherSpec?.collect_roles ?? []);
  const tail = new Set([...baseCollect, ...otherCollect]);

  const byRoleB = new Map<string, Subgoal[]>();
  otherSgs.forEach((sg, i) => {
    const r = otherRoles[i] ?? "?";
    if (!byRoleB.has(r)) byRoleB.set(r, []);
    byRoleB.get(r)!.push(sg);
  });
  const pairs: Array<[Subgoal, Subgoal]> = [];
  const extra: Record<string, number> = {};
  baselineSgs.forEach((sg, i) => {
    const r = baseRoles[i] ?? "?";
    if (tail.has(r)) return;
    const pool = byRoleB.get(r);
    if (pool?.length) pairs.push([sg, pool.shift()!]);
    else extra[r] = (extra[r] ?? 0) + 1;
  });
  for (const [r, rows] of byRoleB) if (!tail.has(r)) extra[r] = (extra[r] ?? 0) + rows.length;
  const extraRoles = Object.fromEntries(Object.entries(extra).filter(([, v]) => v));
  const shared = pairs.length;
  const a = pairs.map(([x]) => x);
  const b = pairs.map(([, y]) => y);

  // normalise the three slot families: dates/weekdays, the site's own name, the cap phrasing
  const norm = (s: string): string => {
    let out = s.replace(/\d{4}-\d{2}-\d{2}|周[一二三四五]/g, "<slot>").replace(/¥300以下/g, "¥300");
    for (const lbl of siteLabels) out = out.split(lbl).join("<site>");
    return out;
  };
  const hintOf = (sg: Subgoal): string[] =>
    sg.target_hints ?? (sg.target_hint ? [sg.target_hint] : []);

  const raw = a.filter((x, i) => x.desc === b[i]!.desc).length;
  const same = a.filter((x, i) => norm(x.desc) === norm(b[i]!.desc)).length;
  return {
    shared_roles: shared,
    actions: {
      baseline: a.reduce((n, x) => n + hintOf(x).length, 0),
      other: b.reduce((n, y) => n + hintOf(y).length, 0),
    },
    desc_identical_raw: `${raw}/${shared}`,
    desc_identical_normalized: `${same}/${shared}`,
    normalized_away: ["日期/星期", "站点名", "价格上限说法(¥300以下/¥300)"],
    fields_changed: {
      target_hint: a.filter((x, i) => JSON.stringify(hintOf(x)) !== JSON.stringify(hintOf(b[i]!))).length,
      signal: a.filter((x, i) => JSON.stringify(x.signal) !== JSON.stringify(b[i]!.signal)).length,
      start_url: a.filter((x, i) => x.start_url !== b[i]!.start_url).length,
    },
    extra_roles: extraRoles,
    extra_subgoals: Object.values(extraRoles).reduce((n, v) => n + v, 0),
    collect_steps: {
      baseline: baseRoles.filter((r) => tail.has(r)).length,
      other: otherRoles.filter((r) => tail.has(r)).length,
    },
    collect_roles: {
      baseline: [...baseCollect].sort(),
      other: [...otherCollect].sort(),
    },
    subgoals: { baseline: baselineSgs.length, other: otherSgs.length },
    shape: { baseline: shape(baselineSpec), other: shape(otherSpec) },
  };
}

/** Readable skeleton summary: phase(repeat) × step count — shape differences at a glance. */
export function shape(spec: FlowSpec | null | undefined): string[] {
  if (!spec) return [];
  return phases(spec).map((ph) => `${ph.phase}[${ph.repeat ?? "once"}]×${(ph.steps ?? []).length}`);
}

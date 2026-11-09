/**
 * task-15（D2，评审 #7）：SITE_FACTS 数据管道——host 匹配事实注入（只读辅助数据）。
 *
 * 数据来源两层：仓库层 `site-facts/*.json`（curated）+ 用户层 `$AMBERFLOW_HOME/site-facts/*.json`
 * （可扩展）。合并：同 (site, fact.id) 冲突时 **as_of 新者优先**、同 as_of 仓库层权威（curated
 * 源权威）；失效事实不自动删除/隐藏（漂移靠人工维护 + inspect 复核，docs 既有纪律）。
 *
 * 纪律（红线自证）：本模块只被 CLI/runner 边缘层 import——`src/engine/*`、`grammar-prompt.ts`、
 * 工具描述文本一律不 import（共享层不认识具体站点）；事实不进模型请求面（A/B 留项）。
 *
 * 描述性不处方式是 **schema 结构性保证**：事实只有 `statement` 字段、没有 action 格子——
 * 处方式内容无处可写；冷却/降频/分批等合法处置只允许以"观察记录"口吻出现在 statement 内。
 *
 * fail-soft：坏 JSON / 缺必填键 / schema_version 不识别 → 该文件跳过 + 警告回调；目录不存在
 * → 空集零成本。事实是辅助数据，坏文件不炸主流程。
 */
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../support/paths.ts";
import { amberflowHome } from "./amberflow-home.ts";

export interface SiteFact {
  id: string;
  as_of: string;
  evidence: string[];
  statement: string;
}

export interface SiteFactFile {
  site: string;
  hosts: string[];
  facts: SiteFact[];
}

export interface MatchedSiteFact extends SiteFact {
  site: string;
  /** 来源文件（相对标识：repo/用户层 + 文件名）。 */
  source: string;
}

/** host 后缀匹配：metaHost === factHost 或 metaHost 是 factHost 的子域（父域覆盖子域）。 */
export function factHostMatches(factHost: string, metaHost: string): boolean {
  const f = factHost.trim().toLowerCase();
  const m = metaHost.trim().toLowerCase();
  return m === f || m.endsWith(`.${f}`);
}

/** 单文件加载与形状校验（fail-soft：不合形状返回 null，原因给回调）。 */
function loadFactFile(file: string, warn: (msg: string) => void): SiteFactFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    warn(`site-facts 文件跳过（不是合法 JSON）：${file}（${e instanceof Error ? e.message : String(e)}）`);
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warn(`site-facts 文件跳过（顶层必须是对象）：${file}`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (o["schema_version"] !== 1) {
    warn(`site-facts 文件跳过（schema_version 不识别）：${file}（期望 1，收到 ${JSON.stringify(o["schema_version"])}）`);
    return null;
  }
  const site = o["site"];
  const hosts = o["hosts"];
  const facts = o["facts"];
  if (typeof site !== "string" || site.trim() === ""
    || !Array.isArray(hosts) || hosts.length === 0 || hosts.some((h) => typeof h !== "string" || h.trim() === "")
    || !Array.isArray(facts)) {
    warn(`site-facts 文件跳过（形状不符）：${file}（需要 { schema_version:1, site, hosts:[..], facts:[..] }）`);
    return null;
  }
  const okFacts: SiteFact[] = [];
  for (const f of facts) {
    if (typeof f !== "object" || f === null) continue;
    const rec = f as Record<string, unknown>;
    if (typeof rec["id"] !== "string" || rec["id"].trim() === ""
      || typeof rec["as_of"] !== "string" || rec["as_of"].trim() === ""
      || typeof rec["statement"] !== "string" || rec["statement"].trim() === ""
      || !Array.isArray(rec["evidence"])) continue;
    okFacts.push({
      id: rec["id"],
      as_of: rec["as_of"],
      evidence: (rec["evidence"] as unknown[]).map(String),
      statement: rec["statement"],
    });
  }
  return { site, hosts: hosts.map(String), facts: okFacts };
}

/** 读两层目录（仓库层在前、用户层在后）并逐文件解析；layer 随行（合并裁决用）。 */
export function loadSiteFacts(warn: (msg: string) => void = () => {}): Array<SiteFactFile & { layer: "repo" | "user" }> {
  const dirs: Array<{ dir: string; layer: "repo" | "user" }> = [
    { dir: path.join(REPO, "site-facts"), layer: "repo" },
    { dir: path.join(amberflowHome(), "site-facts"), layer: "user" },
  ];
  const out: Array<SiteFactFile & { layer: "repo" | "user" }> = [];
  for (const { dir, layer } of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    } catch { /* 目录不存在 = 空集（默认等价） */ continue; }
    for (const n of names) {
      const f = loadFactFile(path.join(dir, n), warn);
      if (f !== null) out.push({ ...f, layer });
    }
  }
  return out;
}

/** 按 meta.hosts 匹配并按 (site, fact.id) 去重：as_of 新者优先；同 as_of 仓库层（repo）权威。 */
export function matchSiteFacts(
  files: Array<SiteFactFile & { layer: "repo" | "user" }>,
  metaHosts: ReadonlyArray<string>,
): MatchedSiteFact[] {
  const byKey = new Map<string, MatchedSiteFact & { layer: "repo" | "user" }>();
  for (const file of files) {
    const hit = metaHosts.some((mh) => file.hosts.some((fh) => factHostMatches(fh, mh)));
    if (!hit) continue;
    for (const fact of file.facts) {
      const key = `${file.site}\u0000${fact.id}`;
      const prev = byKey.get(key);
      if (prev === undefined) {
        byKey.set(key, { ...fact, site: file.site, source: `${file.layer}:${file.site}`, layer: file.layer });
        continue;
      }
      // as_of 新者优先（ISO 日期字典序可比）；同 as_of → 仓库层权威。
      const newer = fact.as_of > prev.as_of;
      const sameButRepo = fact.as_of === prev.as_of && file.layer === "repo" && prev.layer === "user";
      if (newer || sameButRepo) {
        byKey.set(key, { ...fact, site: file.site, source: `${file.layer}:${file.site}`, layer: file.layer });
      }
    }
  }
  return [...byKey.values()].map(({ layer: _layer, ...rest }) => rest);
}

/** 渲染 stderr 提示行（有界：每应用 ≤6 条 + 截断计数）。 */
export function renderSiteFactLines(facts: MatchedSiteFact[]): string[] {
  const lines = facts.slice(0, 6)
    .map((f) => `[site-facts] ${f.site} as_of=${f.as_of}: ${f.statement}（证据：${f.evidence.join("；")}）`);
  if (facts.length > 6) lines.push(`[site-facts] 另有 ${facts.length - 6} 条事实略（site-facts/*.json）`);
  return lines;
}

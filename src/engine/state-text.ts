/**
 * 决策请求的页面正文取文（从 `extraction.ts` 纯搬移 + L1 取文范围 opt-in）。
 *
 * 边界：只读页面文本、不做池抽取/裁决；`stateText` 的关键词压缩口径与预算不变。
 * L1 取文范围：`firstOf("main, body")` 在 DOM 顺序上先命中 `body`，主文档外的内容（iframe
 * 子帧）不在父 body 的 innerText 里——显式 `AMBERFLOW_STATE_TEXT_SCOPE=wide` 才追加最多
 * 2 个未 detach 子帧的 body 文本；默认路径（env 未设）取文与既有行为逐字节一致。
 */
import { STATE_TEXT_BUDGET_CHARS } from "../support/tuning.ts";
import type { FrameLike, PageLike } from "../support/page-like.ts";
import { firstOf, framesOf } from "./page-shapes.ts";

/** 正文首 300 + 末 150（决策 `pageText` 展示面）。 */
export async function pageText(page: PageLike, head = 300, tail = 150): Promise<string> {
  const text = (await firstOf(page.locator!("main, body")).innerText()).trim();
  if (text.length <= head + tail) return text;
  return text.slice(0, head) + "\n...\n" + text.slice(-tail);
}

/**
 * State compressor: rank page lines by keyword overlap with the query and pack
 * only the hits into the budget. Deterministic on purpose — laya's domain-tuned
 * encoder is measurably unreliable as a general text-similarity ranker.
 */
export async function stateText(page: PageLike, query: string, _embedFn: unknown = null, budget = STATE_TEXT_BUDGET_CHARS): Promise<string> {
  const parts: string[] = [(await firstOf(page.locator!("main, body")).innerText()).trim()];
  if (process.env.AMBERFLOW_STATE_TEXT_SCOPE === "wide") {
    for (const frame of framesOf(page, 3)) {
      if (frame === (page as unknown as FrameLike)) continue;   // 主帧已读
      try {
        if (frame.isDetached?.() === true) continue;
        const extra = (await firstOf(frame.locator("body")).innerText()).trim();
        if (extra !== "") parts.push(extra);
      } catch { /* 无 body/死帧：跳过，不是错误 */ }
    }
  }
  const text = parts.join("\n").trim();
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const ln of text.split("\n").map((l) => l.trim())) {
    if (ln.length >= 4 && !seen.has(ln.toLowerCase())) {
      seen.add(ln.toLowerCase());
      lines.push(ln);
    }
  }
  if (!lines.length) return "";
  if (lines.join("\n").length <= budget) return lines.join("\n");
  const tok = new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
  const scored = lines.map((ln, i) => {
    const ws = new Set(ln.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
    let score = 0;
    for (const t of tok) if (ws.has(t)) score += 1;
    return { score, i };
  }).sort((a, b) => b.score - a.score || a.i - b.i);
  const out: number[] = [];
  let used = 0;
  for (const { score, i } of scored) {
    if (score <= 0) break;
    if (used + lines[i]!.length + 1 > budget) continue;
    out.push(i);
    used += lines[i]!.length + 1;
    if (used >= budget * 0.9) break;
  }
  if (!out.length) return pageText(page);   // query matches nothing -> head+tail
  return out.sort((a, b) => a - b).map((i) => lines[i]).join("\n");
}

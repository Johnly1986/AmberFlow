/**
 * `amber inspect` —— 只读页面观察。给 Agent 在写 `target_hint` 前看真实元素。
 *
 * 纪律：
 *   - 只接受 http(s)；不点击、不填值、不调用决策模型；
 *   - 复用 `extractElements` 与 `suggestHints`（后者用 `hintMatch` 自证）；
 *   - 输出有界：元素默认 60 条，正文摘要固定截断；不返回整页 HTML；
 *   - 会话无论成功失败都关闭。
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CliContext } from "../context.ts";
import { emitJson, say } from "../context.ts";
import { usageError } from "../errors.ts";
import { successEnvelope } from "../json.ts";
import { browserSession } from "../../engine/executor.ts";
import { extractElements } from "../../engine/extraction.ts";
import { poolView } from "../../engine/pool-view.ts";
import { parseCliArgs } from "../../support/cli-args.ts";

const USAGE = `usage: inspect --url <http(s) URL> [--max-elements N] [--text] [--pool] [--screenshot FILE]
               [--timeout MS] [--headed] [--json]

只看页面，不点击、不填值、不调用模型。输出有界元素与可验证的 hint 候选；
--pool 输出引擎实际看到的 pool 视图（action_family/frame_origin/hint_candidates）。`;

type InspectElement = {
  ref: string;
  tag: string;
  label: string;
  hint_candidates: string[];
} & Record<string, unknown>;

function num(v: string | boolean | string[] | undefined): number | undefined {
  const raw = typeof v === "string" ? v : undefined;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function runInspect(args: string[], ctx: CliContext): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        url: { type: "string" },
        "max-elements": { type: "string" },
        text: { type: "boolean" },
        pool: { type: "boolean" },
        screenshot: { type: "string" },
        timeout: { type: "string" },
        headed: { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw usageError(`inspect 参数不对：${msg}`, { next: ["amber inspect --url https://example.com --json"] });
  }
  const v = parsed.values;
  if (v.help) { say(ctx, USAGE); return 0; }
  const url = typeof v.url === "string" ? v.url.trim() : "";
  if (!url) throw usageError("inspect 需要 --url <http(s) URL>", { next: ['amber inspect --url https://example.com --json'] });
  let u: URL;
  try { u = new URL(url); } catch { throw usageError(`--url 不是合法 URL：${JSON.stringify(url)}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw usageError(`inspect 只接受 http(s)，拒绝 ${JSON.stringify(url)}`);
  }
  const max = Math.min(200, Math.max(1, Math.floor(num(v["max-elements"]) ?? 60)));
  const timeout = Math.min(120_000, Math.max(1_000, Math.floor(num(v.timeout) ?? 30_000)));
  const wantJson = ctx.globals.json || v.json === true;
  const wantPool = v.pool === true;

  let session;
  try {
    session = await browserSession(v.headed !== true);
  } catch (err) {
    throw usageError(`浏览器启动失败：${err instanceof Error ? err.message : String(err)}`, {
      next: ["npm run doctor"],
    });
  }
  try {
    const page = session.page as unknown as {
      goto(url: string, opts?: unknown): Promise<unknown>;
      title(): Promise<string>;
      url(): string;
      evaluate(script: string): Promise<unknown>;
      screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
    };
    await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    await new Promise((r) => setTimeout(r, 500));
    const pool = await extractElements(page as never, true, max);
    const view = poolView(pool, page as never, max);
    const frameOrigins = view.frame_origins;
    const elements: InspectElement[] = view.elements.map((e) => ({
      ref: e.ref,
      tag: e.tag,
      label: e.label,
      hint_candidates: e.hint_candidates,
      action_family: e.action_family,
      action_capabilities: e.action_capabilities,
      frame_origin: e.frame_origin,
      ...e.extras,
    }));
    const text = v.text === true
      ? String(await page.evaluate("document.body ? document.body.innerText : ''")).slice(0, 800)
      : "";
    let screenshotPath: string | undefined;
    if (typeof v.screenshot === "string" && v.screenshot !== "") {
      screenshotPath = v.screenshot;
      fs.mkdirSync(path.dirname(path.resolve(screenshotPath)), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }
    const data = {
      url: page.url(),
      requested_url: url,
      title: String(await page.title()),
      elements,
      element_count: view.count,
      truncated: view.truncated,
      ...(wantPool ? { frame_origins: view.frame_origins } : {}),
      ...(wantPool ? { pool: view } : {}),
      ...(text ? { text } : {}),
      ...(screenshotPath ? { screenshot_path: screenshotPath } : {}),
    };
    if (wantJson) {
      emitJson(ctx, successEnvelope("inspect", data, {
        next: [`amber run --goal "<目标>" --url ${url}`, "amber doctor"],
      }));
      return 0;
    }
    say(ctx, `${data.title} — ${data.url}`);
    say(ctx, `元素 ${data.element_count} 个${data.truncated ? `（只显示前 ${max}）` : ""}`);
    for (const e of elements) {
      say(ctx, `  ${e.ref.padEnd(6)} ${e.tag.padEnd(8)} ${e.label.slice(0, 60)}`
        + `${e.hint_candidates.length ? `  hints: ${e.hint_candidates.join(" | ")}` : ""}`);
    }
    if (text) say(ctx, `\n文本摘要：${text}`);
    return 0;
  } finally {
    await session.close();
  }
}

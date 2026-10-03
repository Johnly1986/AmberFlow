/**
 * qunar reachability probe — TS twin of `qunar/probe.py`.
 *
 * The ctrip case was blocked at the EXIT-IP gate (432 to every client); qunar is
 * the control: is a Chinese OTA's H5 flight page reachable from curl / httpx /
 * a real chromium, and does the data leg survive? Measured 2026-10-03: the page
 * itself is captured by all three clients, while the list API refuses automated
 * browsers (see qunar-task.ts for the run that records that boundary).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import * as browserEnv from "./browser-env.ts";
import type { AnyPage } from "./path-a.ts";
import { loadProbeSet, markerList } from "./probe-set.ts";

/**
 * 站点知识（目标 URL、被挡特征、登录跳转特征、结果目录）全在 `apps/qunar-live/pack.json`；
 * 本文件只剩三种客户端 + 判决顺序。
 */
export const SET = loadProbeSet("qunar-live");

export const TARGET = SET.http[0]?.url ?? "";
export const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
  + "AppleWebKit/605.1.15 (Version/17.0 Mobile/15E148 Safari/604.1)";

export const RESULTS = SET.resultsDir;

export interface ProbeResult {
  code: number;
  bytes: number;
  verdict: Verdict;
  [k: string]: unknown;
}

export type Verdict = "unreachable" | "blocked" | "login_required" | "captured";

/** curl with a chosen UA (`curl_get` in the Python probe). */
export function curlGet(url: string, ua: string | null = null, timeout = 25): [number, string] {
  const args = ["-sS", "-o", "-", "-w", "\n%{http_code}", "-L", "--max-time", String(timeout)];
  if (ua) args.push("-A", ua);
  args.push(url);
  try {
    const out = execFileSync("curl", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    const idx = out.lastIndexOf("\n");
    return [Number(out.slice(idx + 1).trim() || 0), out.slice(0, idx)];
  } catch {
    return [0, ""];
  }
}

/** Plain HTTP GET (`httpx_get`), with the repo's browser-UA default. */
export async function httpxGet(url: string, ua: string | null = null, timeoutMs = 25_000): Promise<[number, string]> {
  try {
    const ctl = AbortSignal.timeout(timeoutMs);
    const res = await fetch(url, { headers: ua ? { "user-agent": ua } : {}, signal: ctl });
    return [res.status, await res.text()];
  } catch {
    return [0, ""];
  }
}

export function looksBlocked(body: string): boolean {
  const low = body.toLowerCase();
  return markerList(SET, "block_text").some((m) => low.includes(m.toLowerCase()));
}

export function looksLoginRedirect(url: string, _body: string): boolean {
  const low = url.toLowerCase();
  return SET.login.paths.some((p) => low.includes(p.toLowerCase()));
}

/** Verdict order matters: blocked beats login_required, 0 is unreachable. */
export function verdict(url: string, code: number, body: string): Verdict {
  if (code === 0) return "unreachable";
  if (code !== 200 || looksBlocked(body)) return "blocked";
  if (looksLoginRedirect(url, body)) return "login_required";
  return "captured";
}

export async function main(): Promise<number> {
  const probes: Record<string, Record<string, unknown>> = {};
  const [c1, b1] = curlGet(TARGET);
  probes["curl-default-ua"] = { code: c1, bytes: b1.length, verdict: verdict(TARGET, c1, b1) };
  const [c2, b2] = curlGet(TARGET, IPHONE_UA);
  probes["curl-iphone-ua"] = { code: c2, bytes: b2.length, verdict: verdict(TARGET, c2, b2) };
  const [c3, b3] = await httpxGet(TARGET);
  probes["httpx"] = { code: c3, bytes: b3.length, verdict: verdict(TARGET, c3, b3) };

  const browser = (await browserEnv.launch({ chromium } as never, true)) as unknown as {
    newPage(): Promise<unknown>; close(): Promise<void>;
  };
  const page = (await browser.newPage()) as unknown as AnyPage & {
    content(): Promise<string>; waitForTimeout(ms: number): Promise<void>;
  };
  try {
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(2500);
    const html = await page.content();
    probes.chromium = {
      final_url: page.url(), title: await page.title(), bytes: html.length,
      has_search: html.includes("搜索"),
      verdict: verdict(page.url(), 200, html),
    };
  } catch (e) {
    probes.chromium = { verdict: "unreachable", error: String(e) };
  } finally {
    await browser.close();
  }

  for (const [k, v] of Object.entries(probes)) {
    console.log(`${k.padEnd(18)} ${String(v.verdict ?? "?").padEnd(14)} ${JSON.stringify(v)}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}

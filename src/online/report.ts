/**
 * **线上运行证据**：每次运行写一份可复算的目录，但永远不提交进仓库。
 *
 * 目录形状（`$AMBERFLOW_HOME/online-runs/<run-id>/`）：
 *   summary.json
 *   report.md
 *   cases/<id>.json
 *   cases/<id>-failure.png / -failure.html（仅失败）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { amberflowHome } from "../app/amberflow-home.ts";
import type { CaseOutcome, SuiteOutcome } from "./types.ts";

export interface RunPaths {
  runId: string;
  dir: string;
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

export function createRun(out?: string): RunPaths {
  const runId = stamp();
  const dir = path.resolve(out ?? path.join(amberflowHome(), "online-runs", runId));
  fs.mkdirSync(path.join(dir, "cases"), { recursive: true });
  return { runId, dir };
}

export function gitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8", timeout: 2000 }).trim();
  } catch {
    return "unknown";
  }
}

export async function writeCaseEvidence(
  run: RunPaths, outcome: CaseOutcome, page?: { screenshot(o: unknown): Promise<unknown>; content(): Promise<string> },
): Promise<void> {
  const file = path.join(run.dir, "cases", `${outcome.id}.json`);
  fs.writeFileSync(file, JSON.stringify(outcome, null, 2), "utf-8");
  if (outcome.status === "failed" && page) {
    const base = path.join(run.dir, "cases", outcome.id);
    try { await page.screenshot({ path: `${base}-failure.png`, fullPage: true }); } catch { /* 证据尽力而为 */ }
    try { fs.writeFileSync(`${base}-failure.html`, await page.content(), "utf-8"); } catch { /* 同上 */ }
  }
}

export function writeSummary(run: RunPaths, suite: SuiteOutcome): void {
  fs.writeFileSync(path.join(run.dir, "summary.json"), JSON.stringify({
    ...suite,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cwd: process.cwd(),
    git_sha: gitSha(),
  }, null, 2), "utf-8");
  const lines: string[] = [
    `# Online run ${suite.run_id}`,
    "",
    `- tier: \`${suite.tier}\``,
    `- cases: ${suite.passed} passed / ${suite.failed} failed / ${suite.skipped} skipped`,
    `- duration: ${(suite.duration_ms / 1000).toFixed(1)}s`,
    "",
    "| case | site | tier | status | subgoals | invariants | oracle |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const c of suite.cases) {
    const sg = c.subgoals.filter((s) => s.done).length;
    const inv = c.invariants.filter((i) => i.held).length;
    lines.push(`| \`${c.id}\` | ${c.site} | ${c.tier} | **${c.status}** | ${sg}/${c.subgoals.length} | ${inv}/${c.invariants.length} | ${c.oracle ? (c.oracle.ok ? "ok" : "FAIL") : "—"} |`);
    if (c.reason) lines.push(`|  |  |  | ${c.reason.replace(/\|/g, "\\|")} |  |  |  |`);
  }
  lines.push("", "证据是本轮原始观察；不要把它提交回仓库，也不要把它当成下一次运行的期望值。", "");
  fs.writeFileSync(path.join(run.dir, "report.md"), lines.join("\n"), "utf-8");
}
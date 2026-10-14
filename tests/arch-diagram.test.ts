/**
 * 架构图是**生成物**，就该像 `apps:gen --check` 一样可复算。
 *
 * 出处：三张图由 `tools/arch-diagram.mjs`（六层数据流）、`tools/arch-diagram-v2.mjs`
 * （目标架构三段化）与 `tools/arch-diagram-system.mjs`（系统总览：七层 + 外部边界 + 信任链）
 * 生成，文件头都写着"手画的图会随代码漂移"——但在纪律落地之前**没有任何门禁**
 * 检查过这件事：改完模块不重跑生成器，图会静静地停在旧版本上，而文档还在引用它。
 *
 * 这个测试把那条纪律变成有牙的：三个生成器都支持 `--check`（生成结果与仓库里那份逐字节比），
 * 不一致就非零退出。生成器的布局检查（文字出框 / 盒子重叠 / 越出画布）在生成时一并跑，
 * 所以"图能生成"与"图不过时"在这里是同一条命令。
 *
 * 要改图：改生成器里的 box()/band() 调用 → `node tools/arch-diagram.mjs [--png]` →
 * 顺手 `node tools/arch-diagram-v2.mjs [--png]` 与 `node tools/arch-diagram-system.mjs [--png]`。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");

/** 跑一次 `--check`，返回退出码与输出（不抛：断言里要看到原因）。 */
function check(tool: string): { code: number; output: string } {
  try {
    const out = execFileSync("node", [tool, "--check"], { cwd: REPO, encoding: "utf-8", stdio: "pipe" });
    return { code: 0, output: out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("架构图：仓库里那份必须等于生成结果（漂移即红）", () => {
  it("六层总览 docs/architecture.svg 不漂移", () => {
    const r = check("tools/arch-diagram.mjs");
    expect({ code: r.code, output: r.output.trim() }).toEqual({
      code: 0, output: `图与生成结果一致：${path.join(REPO, "docs", "architecture.svg")}`,
    });
  }, 60_000);

  it("目标架构 docs/architecture-target.svg 不漂移", () => {
    const r = check("tools/arch-diagram-v2.mjs");
    expect({ code: r.code, output: r.output.trim() }).toEqual({
      code: 0, output: `图与生成结果一致：${path.join(REPO, "docs", "architecture-target.svg")}`,
    });
  }, 60_000);

  it("系统总览 docs/architecture-system.svg 不漂移（七层 + 外部边界 + 红线）", () => {
    const r = check("tools/arch-diagram-system.mjs");
    expect({ code: r.code, output: r.output.trim() }).toEqual({
      code: 0, output: `图与生成结果一致：${path.join(REPO, "docs", "architecture-system.svg")}`,
    });
  }, 60_000);
});

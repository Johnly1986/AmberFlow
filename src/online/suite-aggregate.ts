/**
 * S3 套件聚合器原语（P2-2.2-3）：`online/runner.ts` 里「退出码分类 / probe 期望映射」
 * 两个纯策略从编排中抽出为单点，供套件聚合器与后续 `runExecution` 组合根复用。
 *
 * 契约（行为冻结，逐字节从 runner 搬移）：
 *   - `suiteExitCode`：failed>0 → 1；skipped>0 → requireAll ? 1 : 3；否则 0。
 *   - `applyProbeExpectations`：probe tier 的观测结果映射为 skipped；`expect_zero_actions`
 *     违约是真失败，不能被 probe 的观测映射吞掉（已知漏洞：点错行 + done 失败也记 skipped）。
 * 本模块不读写文件、不起浏览器、不调模型。
 */
import type { CaseOutcome, CaseStatus, OnlineCase } from "./types.ts";

/** 套件退出码：0 全过 / 1 真失败（或 requireAll 下有跳过）/ 3 存在未执行（跳过 ≠ 通过）。 */
export function suiteExitCode(failed: number, skipped: number, requireAll?: boolean): 0 | 1 | 3 {
  return failed > 0 ? 1 : skipped > 0 ? (requireAll ? 1 : 3) : 0;
}

/**
 * probe tier 的「结果」是环境观测，不是产品通过/失败：预期集合内记 skipped，集合外也记
 * skipped 但 reason 点明「未在预期集合内」，并让套件退出码 3，避免把跳过伪装成绿。
 * `expect_zero_actions` 违约（`zero_action_violation`）是**真失败**，原样返回。
 */
export function applyProbeExpectations(c: OnlineCase, base: CaseOutcome): CaseOutcome {
  if (base.zero_action_violation === true) return base;
  const expected = c.expect ?? [];
  const observed = base.status;
  const inExpected = observed === "passed"
    ? expected.includes("captured")
    : expected.includes(observed as Exclude<CaseStatus, "passed" | "skipped">);
  return {
    ...base,
    status: "skipped",
    reason: `probe observed=${observed} expected=${expected.join("|")}${inExpected ? "" : " (UNEXPECTED)"}`,
  };
}

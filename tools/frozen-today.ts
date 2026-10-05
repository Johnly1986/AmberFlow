/**
 * **冻结展开日期**（单一出处）。凡是"与冻结语料对拍"的地方都用它钉住展开用的"今天"。
 *
 * 为什么必须有这一个常量：`transfer/specs/*.json` 的 `per_date` 阶段按**下周**展开，所以
 * "今天是哪天"会改变展开结果——2026-10-04（周日）算出的一周是 10-05..09，跨到 10-05（周一）
 * 就变成 10-12..16。于是**同一个提交**在周日绿、周一红：本轮实测到三处同时发作
 * （`apps:gen --check` 7 个漂移、`tests/transfer.test.ts` 15 条、`tools/transfer-parity.ts` 41 项、
 * smoke 的 transfer oracle 用例）。冻结语料不依赖时钟 —— 这条规则在 ctrip 对拍上早就有了
 * （`tools/ctrip-parity.ts` 从语料里解析出那一天），这里是把它推广成一处共享常量。
 *
 * 想要别的周：显式 `--today YYYY-MM-DD`（生成器）或自己设 `process.env.LAYA_TODAY`。
 */
export const FROZEN_TODAY = "2026-10-02";

/** 钉住展开日期（覆盖环境里的值；调用方自己设过就尊重调用方）。 */
export function pinFrozenToday(today: string = FROZEN_TODAY): string {
  if (process.env.LAYA_TODAY === undefined) process.env.LAYA_TODAY = today;
  return process.env.LAYA_TODAY;
}

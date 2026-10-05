/**
 * **冻结展开日期**（与 `tools/spec-to-pack.ts` 的 `FROZEN_TODAY` 同一口径）。
 *
 * spec 的 `per_date` 阶段按"下周"算，所以"今天是哪天"会改变展开结果：周日算下一周是 10-05..09，
 * 一旦跨到周一就变成 10-12..16。凡是**与冻结语料对拍**的测试（提交进仓库的 Python 生成物、
 * 迁移度量、端到端判分、生成的包）都必须在这一天展开，否则整个文件会跟着星期集体变红
 * （本轮实测：跨过周日→周一边界后 `tests/transfer.test.ts` 红 15 条、`tests/ctrip.test.ts` 红 3 条）。
 *
 * 用法：在文件顶部 import 一次即可（`import "./frozen-today.ts";`）。
 * 想要别的日期的测试请自己显式赋值 `process.env.LAYA_TODAY`（这里只在没设时兜底）。
 */
export { FROZEN_TODAY } from "../tools/frozen-today.ts";

// 与 tools/frozen-today.ts 同一常量、同一理由（那里有完整的实测经过）。
if (process.env.LAYA_TODAY === undefined) process.env.LAYA_TODAY = "2026-10-02";

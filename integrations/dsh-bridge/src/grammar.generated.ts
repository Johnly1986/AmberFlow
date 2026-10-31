/**
 * 生成物（勿手改）：由 `src/engine/grammar-prompt.ts` 与 `src/engine/planning-playbook.ts`
 * 经 `npm run prompt-hit` 生成与校验。桥纪律 "called, not embedded"：不 import 引擎代码，
 * 语法与规划引导以**字符串**分发到这里。先改引擎模块，再跑 `npm run prompt-hit`
 * （本文件漂移会让 `npm run check` 红）。
 */

export const HINT_SHAPE_TOKENS: readonly string[] = [
  "#id",
  "tag[attr~substr]",
  "tag~token",
  "tag[attr=value]",
  "tag (button|link|input|textarea|select)",
  "bare-token"
];

export const HINT_LEARN_NOTE = "A hint is a STABLE-HANDLE CLOSED SET of 6 shapes (#id | tag[attr~substr] | tag~token | tag[attr=value] | tag (button|link|input|textarea|select) | bare-token; only test=data-test and type attribute names take part in matching), NOT arbitrary CSS - container/descendant selectors (e.g. \"#outer input\") parse but can never match (target_not_found).";

export const PLAN_PLAYBOOK_SHORT = "高效规划五步法：① inspect 先看（验证过的 hint_candidates 可照抄）→ ② 单步探针先行（1 步 arrive+read 验证：页面可达 / 登录与验证可处理 / 无风控拦截 / 数据在 DOM）→ ③ 正式应用参数化（slots + 早停守卫 + meta.policy 声明 done_timeout_ms）→ ④ apps check <id> --slot k=v 离线分支校验 → ⑤ run --trace 真跑，失败看 stopCode/reason。";

/**
 * 生成物（勿手改）：由 `src/engine/grammar-prompt.ts`、`src/engine/planning-playbook.ts`
 * 与 `src/support/help-map.ts` 经 `npm run prompt-hit` 生成与校验。桥纪律
 * "called, not embedded"：不 import 引擎代码，语法、规划引导与概述层以**字符串**
 * 分发到这里。先改引擎模块，再跑 `npm run prompt-hit`（本文件漂移会让
 * `npm run check` 红）。
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

export const STOP_ESCALATION_TEXT = "同一停因按 next 修正后重跑仍出现 2 次以上 → 停手：如实上报 stopCode / reason / 已试过的修正，等待人或上游决策；不要再自行迭代脚本或重试。";

export const OVERVIEW_TEXT = "AmberFlow 是冻结计划的浏览器自动化引擎：计划由人给出（app.mjs 的 flow(ctx) 脚本），引擎逐步选元素、执行动作、验证完成信号；模型只做选择/风险/完成票（完成票仅 advisory），不生成动作，完成只认 DOM/工具信号。什么时候用：要在真实网站上自动化一条可验证的流程（采集、下单、巡检、回归），且希望每一步有结构化证据与完成裁决时。从哪开始：已安装 → amber doctor 体检；checkout 内 → node --experimental-strip-types src/cli/main.ts doctor（裸 amber 不在 PATH，npx amber 会挂住）。";

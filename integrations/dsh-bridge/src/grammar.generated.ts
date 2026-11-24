/**
 * 生成物（勿手改）：由 `src/engine/grammar-prompt.ts`、`src/engine/planning-playbook.ts`、
 * `src/support/help-map.ts` 与 `src/support/intervention-texts.ts` 经 `npm run prompt-hit`
 * 生成与校验。桥纪律 "called, not embedded"：不 import 引擎代码，语法、规划引导、概述层
 * 与求援 agent_hint 以**字符串**分发到这里。先改引擎模块，再跑 `npm run prompt-hit`
 * （本文件漂移会让 `npm run check` 红）。
 */

export const HINT_SHAPE_TOKENS: readonly string[] = [
  "#id",
  "tag[attr~substr]",
  "tag~token",
  "tag[attr=value]",
  "one role word (button OR link OR input OR textarea OR select)",
  "bare-token"
];

export const HINT_LEARN_NOTE = "A hint is a STABLE-HANDLE CLOSED SET of 6 shapes (#id | tag[attr~substr] | tag~token | tag[attr=value] | one role word (button OR link OR input OR textarea OR select) | bare-token; only test=data-test, type and aria-label attribute names take part in matching), NOT arbitrary CSS - container/descendant selectors (e.g. \"#outer input\") parse but can never match (target_not_found).";

export const PLAN_PLAYBOOK_SHORT = "高效规划六步法 v2.1（走查先行）。\n① inspect 先看：`amber inspect --url <页> --json`，hint_candidates 有候选就照抄，并核对 op 能力面与词面在池。\n② 全流程走查：按真实步序走通，带出能力墙/产品事实/提槽清单/done 素材/绕行决策。\n③ 规划应用：slots + done 正向锚、否定配 exists、多动作后判、状态前进自检。\n④ `amber apps check <id> --slot k=v` 离线验分支，改掉裸 not / any 含 not(exists) 两条 lint。\n⑤ `amber run <id> --trace` 真跑，失败先看 stopCode/reason。\n⑥ 失败取证：分清引擎缺陷/产品事实/任务口径（A/B、对照、双腿），判别不了就上报。";

export const STOP_ESCALATION_TEXT = "同一停因按 next 修正后重跑仍出现 2 次以上 → 停手：如实上报 stopCode / reason / 已试过的修正，等待人或上游决策；不要再自行迭代脚本或重试。";

export const OVERVIEW_TEXT = "AmberFlow 是浏览器自动化引擎：你把流程写成 app.mjs 的 flow(ctx) 脚本，引擎逐步选元素、执行动作、验证完成信号；模型只投票（选择/风险/完成），不生成动作，完成只认页面/工具信号。\n什么时候用：在真实网站上跑可验证的流程（采集、下单、巡检、回归），并要求每步有结构化证据与完成裁决。\n从哪开始：amber doctor 体检；checkout 内用 node --experimental-strip-types src/cli/main.ts doctor（裸 amber 不在 PATH，npx amber 会挂住）。";

export const RESCUE_AGENT_HINTS: Readonly<Record<string, { fact: string; recommended_action: string; stop_condition: string }>> = {
  "action": {
    "fact": "STOP needs_human: 2FA required; engine won't fake a human",
    "recommended_action": "ask the user ONCE to run `amber run <id> --headful`",
    "stop_condition": "retry the same run at most once, then report and stop"
  },
  "value": {
    "fact": "STOP needs_value: a declared slot has no value; engine never invents values",
    "recommended_action": "report the missing slot to the caller and ask for the real value",
    "stop_condition": "do not retry with a guessed or empty value"
  },
  "authorization": {
    "fact": "STOP needs_human: irreversible action requires explicit human authorization",
    "recommended_action": "report the blocked action to the user and wait for explicit consent",
    "stop_condition": "never retry the destructive action without explicit consent"
  }
};

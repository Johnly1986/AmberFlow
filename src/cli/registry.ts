/**
 * 命令表是唯一的帮助来源。
 *
 * 目标不是把设计文档抄一遍，而是让 `amber --help` / `amber help <cmd>` 与实际
 * 分发表同源：新增命令时只改这里和 main.ts 的 switch，不会出现"帮助里有、入口没有"。
 *
 * 三层提示词系统（docs/PROMPT_SYSTEM.md）中的工具层（层 2）：
 *   `when` = 何时用（与 src/support/help-map.ts 的 WHEN_TO_USE 同源互证）；
 *   `flow` = 实践流程（只写正向流程，≤4 行；失败回流由层 3 STOP_NEXT 承载）。
 * 两字段均进 `commandHelp()` 人类文本与 `amber help <cmd> --json` 结构化输出。
 */

import { OVERVIEW_TEXT, WHEN_TO_USE } from "../support/help-map.ts";

export interface CommandSpec {
  name: string;
  summary: string;
  /** 何时用（层 2；与 help-map 的 WHEN_TO_USE 同一条，双向校验）。 */
  when?: string;
  /** 实践流程（层 2；正向流程按序，失败回流见层 3）。 */
  flow?: string[];
  usage: string;
  examples: string[];
  flags: string[];
  related: string[];
}

export const GLOBAL_USAGE = `AmberFlow — 冻结计划的浏览器自动化

${OVERVIEW_TEXT}

用法：
  amber <命令> [选项]
  在源码 checkout 里就地跑：node --experimental-strip-types src/cli/main.ts <命令> [选项]
  （npx amber 需要先把 bin 链进 node_modules，如 npm link；否则会挂在远端同名包上）

日常命令（何时用）：
  run       运行应用、计划或一次性目标${whenFor("run")}
  record    演示一次，生成应用${whenFor("record")}
  plan      创建 / 编辑 / 校验计划${whenFor("plan")}
  apps      列出 / 查看 / 校验应用${whenFor("apps")}
  inspect   只读观察页面元素与候选 hint${whenFor("inspect")}
  doctor    环境、配置、决策源体检${whenFor("doctor")}
  config    查看 / 修改机器配置${whenFor("config")}
  model     本地决策模型状态与安装${whenFor("model")}
  test      真实站点测试套件（校验 / smoke / core / deep / probe）${whenFor("test")}

全局选项：
  -h, --help       显示帮助
  -V, --version    显示版本
  --json           机器可读输出
  -q, --quiet      只输出结论
  --verbose        输出逐步骤细节
  --no-color       禁用颜色
  --yes            非交互确认（不隐含 --allow-dangerous）
  --config FILE    指定配置文件
  --timeout SEC    覆盖单步 / 整体超时（按命令定义）

示例：
  amber test --tier smoke
  amber run --goal "把商品加入购物车" --url https://shop.example.com/p/1
  amber record https://shop.example.com --name add-to-cart
  amber doctor

引擎语义契约（facts/signals/hints/commands/budget/…）：amber schema ctx --json
退出码：0=成功 1=未完成 2=用法/配置错误 3=未执行/被挡住 130=中断`;

/** 从 help-map 取某命令的 when，拼进日常命令行（缺省等价于不显示）。 */
function whenFor(cmd: string): string {
  const hit = WHEN_TO_USE.find((w) => w.cmd === cmd);
  return hit ? ` —— ${hit.when}` : "";
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "run",
    summary: "运行应用、计划或一次性目标",
    when: whenOf("run"),
    flow: [
      "先 --dry-run 验调用序列（不启浏览器）",
      "再 --max-steps 3 --trace 预算试跑，拿结构化反馈",
      "最后完整运行；失败看停因 next——失败输出自带回流建议与停手规则",
    ],
    usage: `amber run [应用] [选项]
amber run --plan [文件] [选项]
amber run --goal "<目标>" --url <页面> [--save-plan <文件>] [选项]`,
    examples: [
      'amber run --goal "把无线鼠标加入购物车" --url https://shop.example.com/p/1',
    ],
    flags: [
      "--headful / --headless    显示 / 不显示浏览器窗口（run 默认 headless）",
      "--dry-run                 只做 dry 调用序列/展开校验，不执行",
      "--plan [文件]             输入的计划文件；默认 ./.amberflow/plan.json",
      "--save-plan <文件>        生成计划的保存位置；默认 ./.amberflow/plan.json",
      "--out <目录>              结果 JSON / Markdown 的落点",
      "--slot k=v                覆盖应用声明的参数；可重复（敏感值用 --slot-file）",
      "--slot-file FILE          从 JSON 对象读槽位：敏感值不进 argv/进程列表",
      "--today YYYY-MM-DD        把今天钉成指定日期（数据腿相对日期表达式 / ctx.runtime.today）",
      "--provider <名字>         仅本次实验/消融覆盖；默认三件套或本地模型",
      "--skip-data               跳过数据腿（旧 --no-sources）",
      "--allow-dangerous         放行危险工具步；不带则结构化拒绝并 exit 3",
      "--confirm-safe            危险动作逐次按干跑证据确认（M0 起默认已开启）",
      "--confirm-unsafe          恢复旧行为：破坏性浏览器动作放行（默认按干跑证据拒绝）",
      "--manual-fail-fast        非交互遇到人工步直接 needs_human，不拉有头浏览器",
      "--max-steps N             ctx.step/arrive 执行预算（调试用；用满后 partial）",
      "--trace                   结果 JSON 带每步执行证据（step_traces）",
      "--emit-trace <文件>       脚本应用：把本次执行轨迹（script/inputs 两个 sha + 逐次 ctx 调用）写成文件",
      "--replay <文件>           脚本应用：按已记录轨迹重放（版本/槽位不一致直接拒跑）",
      "--remember                开启学习环 sidecar（旧 --learn-hints）",
      "--memory <文件>           指定 sidecar 落点",
      "--reset / --replan        仅 --plan 模式：重置步骤状态 / 重新规划",
      "--confirm allow|ask|deny  仅 --plan 模式：人工确认策略",
      "--json / --quiet / --verbose  输出契约",
    ],
    related: ["apps", "plan", "record"],
  },
  {
    name: "record",
    summary: "演示一次，生成应用",
    when: whenOf("record"),
    flow: [
      "准备好入口页与目标，交互终端里现场演示（或 --script 回放录好的动作）",
      "引擎归纳完成信号与结束态不变量，回放门通过才落盘 app.mjs",
      "落盘后按 apps check → run --max-steps 调试回路走",
    ],
    usage: "amber record [页面] [选项]",
    examples: [
      "amber record https://shop.example.com --name add-to-cart",
      'amber record --cdp ws://127.0.0.1:9222 --goal "把商品加入购物车"',
      "amber record https://shop.example.com --script ./demo-actions.json --yes --json",
    ],
    flags: [
      "--name <id>               应用 id；默认从域名 + 目标生成 slug",
      "--id <id>                 兼容旧名；等价 --name",
      '--goal "<一句话>"         目标；默认用页面标题',
      "--out <目录>              录制 / 回放中间产物的落点",
      "--apps-dir <目录>        应用落点；默认 $AMBERFLOW_HOME/apps",
      "--script <文件>           用录好的动作回放，不做现场演示",
      "--headless                无窗口录制；默认 record 是 headful",
      "--yes                     不再逐条确认",
      "--json                    输出结构化结果",
    ],
    related: ["run", "apps"],
  },
  {
    name: "plan",
    summary: "创建 / 编辑 / 校验计划",
    when: whenOf("plan"),
    flow: [
      "plan new 建计划，逐条 plan add（每条带 --signal 完成信号）",
      "plan check 离线校验后再 plan run（或 amber run --plan）",
    ],
    usage: `amber plan new "<目标>" [--url <页面>] [--save-plan <文件>]
amber plan show [--plan <文件>]
amber plan add "<描述>" (--signal <op=value> | --signal-file <json>) [--url <页面>] [--target <hint>] [--at <编号|id>] [--plan <文件>]
amber plan edit <编号|id> [--desc ...] [--signal ... | --signal-file <json>] [--url ...] [--target ...] [--plan <文件>]
amber plan rm <编号|id> [--plan <文件>]
amber plan move <编号|id> --to <位置> [--plan <文件>]
amber plan check [--plan <文件>]
amber plan reset [--plan <文件>]
amber plan run [--plan <文件>] [--reset] [--replan] [--confirm allow|ask|deny]`,
    examples: [
      'amber plan new "把商品加入购物车" --url https://shop.example.com/p/1',
      'amber plan add "打开购物车" --signal url_contains=cart.html --target "#cart-link"',
      "amber plan check",
    ],
    flags: [
      "--plan <文件>             输入的计划文件；默认 ./.amberflow/plan.json",
      "--save-plan <文件>        plan new 的输出位置",
      "--signal <op=value>       完成信号；与 --signal-file 二选一",
      "--signal-file <json>      复杂信号的 JSON 文件",
      "--target <hint>           目标提示（旧 --hint）",
      "--at <编号|id>            插入位置；编号统一 1-based",
      "--to <位置>               move 的目标位置；1-based",
      "--reset / --replan        plan run 的重置 / 重新规划",
      "--confirm allow|ask|deny  plan run 的人工确认策略",
    ],
    related: ["run", "apps"],
  },
  {
    name: "apps",
    summary: "列出 / 查看 / 校验应用",
    when: whenOf("apps"),
    flow: [
      "apps new <id> 生成骨架 → 编辑 app.mjs",
      "apps check [--slot k=v] 离线校验各分支调用序列（逐分支给 --slot）",
      "apps explain 看 dry 调用序列，再进 run 的调试回路",
    ],
    usage: `amber apps list [--json]
amber apps show <应用|脚本> [--code] [--json]
amber apps new <id> [--goal <目标>] [--host HOST] [--url <入口页>] [--dir <目录>] [--force] [--print] [--json]
amber apps check [<应用|脚本>] [--slot k=v]... [--json]
amber apps explain <应用|脚本> [--slot k=v]... [--json]
amber apps path <应用> [--json]
amber apps remove <应用> [--yes] [--force]`,
    examples: ["amber apps list", "amber apps check $AMBERFLOW_HOME/apps/my-app/app.mjs",
      "amber apps explain $AMBERFLOW_HOME/apps/my-app/app.mjs",
      "amber apps new my-app --url https://shop.example.com/ --goal \"把商品加入购物车\""],
    flags: [
      "--goal <一句话>            apps new 的目标",
      "--host HOST                apps new 的允许主机；可重复（缺省从 --url 推断）",
      "--url <http(s) URL>        apps new 的入口页",
      "--dir <目录>               apps new 的落点（默认 $AMBERFLOW_HOME/apps/<id>）",
      "--code                     apps show 返回完整源码（供 Agent 直接看/编辑）",
      "--slot k=v                apps check/explain 的 dry 槽位（可重复）；分支校验不启浏览器。加载期必填槽仍需 meta 声明默认（可空串）",
      "--force                    apps new 覆盖已存在文件 / apps remove 允许删内置应用",
      "--print                    apps new 只打印源码、不落盘",
      "--json                    机器可读输出",
      "--yes                     确认删除（非 TTY 必须给）",
    ],
    related: ["run", "record"],
  },
  {
    name: "inspect",
    summary: "只读观察页面元素与候选 hint",
    when: whenOf("inspect"),
    flow: [
      "写任何 hint/信号前先 inspect --json 拿验证过的 hint_candidates",
      "exists/text 类信号先 --probe <selector> 实证命中数",
      "空池时 --wide --pool 宽扫取证（建议会自动出现在 next 里）",
    ],
    usage: 'amber inspect --url <http(s) URL> [--max-elements N] [--wide] [--text] [--pool] [--probe SEL]... [--screenshot FILE] [--headed] [--json]',
    examples: [
      "amber inspect --url https://books.toscrape.com/ --json",
      'amber inspect --url https://quotes.toscrape.com/login --text',
      'amber inspect --url https://books.toscrape.com/ --probe h1 --probe .price_color --json',
    ],
    flags: [
      "--url <URL>               必填；只接受 http(s)",
      "--max-elements N          默认 60，最多 200",
      "--wide                    宽扫参数抽池（120 上限 + R2 启发式伪按钮，heuristic 标记；主池语义不变）",
      "--text                    附带截断后的正文摘要",
      "--pool                    输出引擎视角的完整 pool 视图",
      "--probe SEL               可重复（≤10）：对任意 CSS selector（含非交互元素）只读探测存在数与文本摘录，--json 落 probes[]",
      "--screenshot FILE         写一张当前视口截图（路径，不内联）",
      "--timeout MS              导航超时，默认 30000",
      "--headed                  显示浏览器窗口",
      "--json                    输出 JSON envelope",
    ],
    related: ["run", "apps", "doctor"],
  },
  {
    name: "schema",
    summary: "引擎语义契约（Agent 无源码自描述面：facts/signals/hints/commands/budget/…）",
    when: whenOf("schema"),
    flow: [
      "amber schema ctx --json 看完整契约（九节 + overview）",
      "不确定某算子/hint/停因语义时 --topic <节> 只查那一节",
    ],
    usage: "amber schema ctx [--topic <节>] [--out <文件>] [--check] [--json]",
    examples: [
      "amber schema ctx --json",
      "amber schema ctx --topic signals",
      "amber schema ctx --out dist/schema/ctx.json && amber schema ctx --check",
    ],
    flags: [
      "--topic <节>             只输出一节：facts / signals / hints / commands / budget / navigation / flow_control / dry / stopcodes",
      "--out <文件>              把契约写成 JSON 快照（构建/发布物；缺省落点 dist/schema/ctx.json）",
      "--check                   与快照比对，漂移 exit 2（CI 新鲜度）",
      "--json                    输出 JSON envelope",
    ],
    related: ["inspect", "apps"],
  },
  {
    name: "doctor",
    summary: "环境、配置、决策源体检",
    when: whenOf("doctor"),
    flow: [
      "先 doctor 看点名清单：缺什么给什么命令",
      "配置问题接 amber config show 看层叠来源",
    ],
    usage: "amber doctor [--json] [--fix] [--verbose]",
    examples: ["amber doctor", "amber doctor --json", "amber doctor --fix"],
    flags: [
      "--json                    机器可读输出",
      "--fix                     只做安全、可逆的修复",
      "--verbose                 输出配置来源与调试信息",
    ],
    related: ["config", "model"],
  },
  {
    name: "config",
    summary: "查看 / 修改机器配置",
    when: whenOf("config"),
    flow: [
      "config show 看层叠与来源；改键用 config set KEY VALUE（--project 只进本项目）",
    ],
    usage: `amber config path [--project]
amber config show [--json]
amber config get <KEY>
amber config set <KEY> <VALUE> [--project]
amber config unset <KEY> [--project]
amber config init [--project]
amber config edit [--project]`,
    examples: [
      "amber config path",
      "amber config set AMBERFLOW_DECISION_BASE_URL https://<服务地址>",
      "amber config set AMBERFLOW_DECISION_MODEL jev-latest",
      "amber config set AMBERFLOW_DECISION_API_KEY sk-... --project",
      "amber config set AMBERFLOW_HEADFUL 1 --project   # 项目配置：仅这个 checkout 生效",
      "amber config set AMBERFLOW_CONF_FLOOR 0.3        # 全局配置：所有项目默认",
    ],
    flags: [
      "--project                 读写项目配置 ./.amberflow/config.json",
      "--json                    机器可读输出",
      "--config <文件>           显式配置（全局选项；替换用户/项目两层）",
    ],
    related: ["doctor", "model"],
  },
  {
    name: "model",
    summary: "本地决策模型状态与安装",
    when: whenOf("model"),
    flow: [
      "model status 看产物是否齐；缺图/权重用 model fetch --from <url|路径> 安装",
    ],
    usage: `amber model status [--json]
amber model fetch --from <url|路径> [--to <onnx>] [--sha256-onnx <hex>] [--sha256-data <hex>] [--tokenizer <路径|url>] [--sha256-tokenizer <hex>] [--force] [--json]
amber model path [--json]`,
    examples: [
      "amber model status",
      "amber model path",
      "amber model fetch --from D:/models/laya_dec.onnx",
    ],
    flags: [
      "--from <url|路径>         图文件本身，或包含图/权重的目录",
      "--to <onnx>               ONNX 文件落点（不是目录）",
      "--sha256-onnx <hex>      图校验；不符不安装",
      "--sha256-data <hex>      权重校验；不符不安装",
      "--tokenizer <路径|url>   tokenizer.json",
      "--sha256-tokenizer <hex> tokenizer 校验",
      "--force                   覆盖已有产物",
      "--json                    机器可读输出（进度仍写 stderr）",
    ],
    related: ["doctor", "config"],
  },
  {
    name: "test",
    summary: "真实站点测试套件",
    when: whenOf("test"),
    flow: [
      "--validate 离线校验全部声明（PR 门禁，不联网）",
      "--tier smoke 先跑可达性，core/deep 有网络与模型时再跑",
      "失败看退出码分层：1 真失败 / 3 blocked/unreachable（探针事实，非门禁）",
    ],
    usage: `amber test --validate
amber test --list [--tier smoke|core|deep|probe|all|default]
amber test [--tier smoke|core|deep|probe|all|default] [--case ID] [--site SITE]
           [--headful | --headless] [--out DIR] [--json] [--provider NAME]
           [--require-all] [--max-steps N] [--timeout SEC]`,
    examples: [
      "amber test --validate",
      "amber test --tier smoke",
      "amber test --tier probe --require-all",
    ],
    flags: [
      "--validate                离线校验全部 site/case（PR 门禁）",
      "--list                    列出选中的 case",
      "--dry-run                 只展开选中的 case，不执行",
      "--tier                    缺省 default = smoke+core；all = smoke+core+deep",
      "--case / --site           只跑一个 case / 站点",
      "--headful / --headless    显示 / 不显示浏览器窗口（test 默认 headless）",
      "--out DIR                 证据目录（默认 $AMBERFLOW_HOME/online-runs）",
      "--max-steps N             每个 case 内子目标预算（缺省 8）",
      "--timeout SEC             覆盖 site/case 超时",
      "--require-all             blocked/unreachable 也按失败处理",
      "--json                    stdout 只输出 summary JSON",
      "--provider NAME           本次决策源覆盖",
    ],
    related: ["run", "doctor"],
  },
];

export function commandSpec(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name);
}

/** `amber help --json`（无命令名）的命令清单：层 2 的索引面（结构化，不再给人类文本）。 */
export function helpCommandsPayload(): Array<Record<string, unknown>> {
  return COMMANDS.map((c) => ({
    name: c.name,
    summary: c.summary,
    when: c.when ?? null,
    flow: c.flow ?? [],
  }));
}

export function globalHelp(includeAdvanced = false): string {
  if (!includeAdvanced) return GLOBAL_USAGE;
  return `${GLOBAL_USAGE}

高级选项（默认隐藏）：
  --ablate --tiered-hint --min-confidence
  这些选项主要给实验/消融使用；日常命令只在确有必要时暴露。`;
}

export function commandHelp(name: string): string {
  const spec = commandSpec(name);
  if (!spec) return globalHelp();
  const lines = [
    `${name} — ${spec.summary}`,
    "",
    "语法：",
    ...spec.usage.split("\n").map((l) => `  ${l}`),
    "",
    "何时用：",
    `  ${spec.when ?? whenFallback(name)}`,
  ];
  if (spec.flow?.length) {
    lines.push("", "实践流程：", ...spec.flow.map((f) => `  ${f}`));
  }
  lines.push(
    "",
    "示例：",
    ...spec.examples.map((e) => `  ${e}`),
    "",
    "常用选项：",
    ...spec.flags.map((f) => `  ${f}`),
    "",
    "引擎语义契约：amber schema ctx --json",
    "退出码：0=成功 1=未完成 2=用法/配置错误 3=未执行/被挡住 130=中断",
  );
  if (spec.related.length) lines.push(`相关命令：${spec.related.join(" · ")}`);
  return lines.join("\n");
}

/** help-map 是 when 的唯一出处：registry 只投影（prompt-hit overview 组双向校验）。 */
function whenOf(cmd: string): string | undefined {
  return WHEN_TO_USE.find((w) => w.cmd === cmd)?.when;
}

/** registry 没写 when 时从 help-map 兜底（双向一致的校验会让这行防御极少触发）。 */
function whenFallback(name: string): string {
  const hit = WHEN_TO_USE.find((w) => w.cmd === name);
  return hit ? hit.when : "见 amber --help 的日常命令一节";
}

/** 编辑距离，只用于“你是不是想用 …”的短名单。 */
export function suggestion(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const score = lev(input, c);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best === null) return null;
  const threshold = Math.max(2, Math.floor(input.length / 3));
  return bestScore <= threshold ? best : null;
}

function lev(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

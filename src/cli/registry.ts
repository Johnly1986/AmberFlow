/**
 * 命令表是唯一的帮助来源。
 *
 * 目标不是把设计文档抄一遍，而是让 `amber --help` / `amber help <cmd>` 与实际
 * 分发表同源：新增命令时只改这里和 main.ts 的 switch，不会出现"帮助里有、入口没有"。
 */

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  examples: string[];
  flags: string[];
  related: string[];
}

export const GLOBAL_USAGE = `AmberFlow — 冻结计划的浏览器自动化

用法：
  amber <命令> [选项]

日常命令：
  run       运行应用、计划或一次性目标
  record    演示一次，生成应用
  plan      创建 / 编辑 / 校验计划
  apps      列出 / 查看 / 校验应用
  inspect   只读观察页面元素与候选 hint
  doctor    环境、配置、决策源体检
  config    查看 / 修改机器配置
  model     本地决策模型状态与安装
  test      真实站点测试套件（校验 / smoke / core / deep / probe）

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

退出码：0=成功 1=未完成 2=用法/配置错误 3=未执行/被挡住 130=中断`;

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "run",
    summary: "运行应用、计划或一次性目标",
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
      "--slot k=v                覆盖应用声明的参数；可重复",
      "--today YYYY-MM-DD        把今天钉成指定日期（数据腿相对日期表达式 / ctx.runtime.today）",
      "--provider <名字>         仅本次实验/消融覆盖；默认三件套或本地模型",
      "--skip-data               跳过数据腿（旧 --no-sources）",
      "--allow-dangerous         放行危险工具步；不带则结构化拒绝并 exit 3",
      "--confirm-safe            危险动作仍逐次按干跑证据确认",
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
    usage: `amber plan new "<目标>" [--url <页面>] [--llm] [--max <N>] [--save-plan <文件>]
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
      "--llm                     用外层 LLM 生成骨架",
      "--max <N>                 LLM 生成步数上限，默认 8",
      "--reset / --replan        plan run 的重置 / 重新规划",
      "--confirm allow|ask|deny  plan run 的人工确认策略",
    ],
    related: ["run", "apps"],
  },
  {
    name: "apps",
    summary: "列出 / 查看 / 校验应用",
    usage: `amber apps list [--json]
amber apps show <应用|脚本> [--code] [--json]
amber apps new <id> [--goal <目标>] [--host HOST] [--url <入口页>] [--dir <目录>] [--force] [--print] [--json]
amber apps check [<应用|脚本>] [--json]
amber apps explain <应用|脚本> [--json]
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
    usage: 'amber inspect --url <http(s) URL> [--max-elements N] [--text] [--screenshot FILE] [--headed] [--json]',
    examples: [
      "amber inspect --url https://books.toscrape.com/ --json",
      'amber inspect --url https://quotes.toscrape.com/login --text',
    ],
    flags: [
      "--url <URL>               必填；只接受 http(s)",
      "--max-elements N          默认 60，最多 200",
      "--text                    附带截断后的正文摘要",
      "--screenshot FILE         写一张当前视口截图（路径，不内联）",
      "--timeout MS              导航超时，默认 30000",
      "--headed                  显示浏览器窗口",
      "--json                    输出 JSON envelope",
    ],
    related: ["run", "apps", "doctor"],
  },
  {
    name: "doctor",
    summary: "环境、配置、决策源体检",
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
    "示例：",
    ...spec.examples.map((e) => `  ${e}`),
    "",
    "常用选项：",
    ...spec.flags.map((f) => `  ${f}`),
    "",
    "退出码：0=成功 1=未完成 2=用法/配置错误 3=未执行/被挡住 130=中断",
  ];
  if (spec.related.length) lines.push(`相关命令：${spec.related.join(" · ")}`);
  return lines.join("\n");
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

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { APPS_DIR, listAppDirs, type AppDirEntry } from "../../app/app-pack.ts";
import { validateApp } from "../../app/cross-ref.ts";
import { dryRunFlow, loadScriptApp, scriptDisplayPath } from "../../app/app-script.ts";
import { PLAN_PLAYBOOK_TEXT } from "../../engine/planning-playbook.ts";
import { userAppsDir } from "../../app/amberflow-home.ts";
import type { CliContext } from "../context.ts";
import { say, emitJson } from "../context.ts";
import { blockedError, usageError, usageFromParseError } from "../errors.ts";
import { successEnvelope } from "../json.ts";

interface AppInfo {
  id: string;
  label: string;
  goal: string;
  path: string;
  source: "user" | "built-in";
  kind: "flow";
  invariants: number;
  hosts: string[];
  error: string | null;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sourceOf(p: string, ctx: CliContext): "user" | "built-in" {
  return inside(path.resolve(p), path.resolve(userAppsDir(ctx.env))) ? "user" : "built-in";
}

/** 读一个应用的脚本并按 meta 汇总；坏脚本仍出现在列表里，但带 `error`。 */
async function infoOf(entry: AppDirEntry, ctx: CliContext): Promise<AppInfo> {
  try {
    const loaded = await loadScriptApp(entry.script);
    const pack = loaded.pack;
    return {
      id: pack.id,
      label: pack.label,
      goal: pack.goal,
      path: entry.script,
      source: sourceOf(entry.script, ctx),
      kind: "flow",
      invariants: (pack.invariants ?? []).length,
      hosts: (pack.hosts ?? []).filter((h): h is string => typeof h === "string"),
      error: null,
    };
  } catch (e) {
    return {
      id: entry.id,
      label: entry.id,
      goal: "",
      path: entry.script,
      source: sourceOf(entry.script, ctx),
      kind: "flow",
      invariants: 0,
      hosts: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function listAppInfos(ctx: CliContext): Promise<AppInfo[]> {
  const rows = await Promise.all(listAppDirs().map((entry) => infoOf(entry, ctx)));
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function printList(ctx: CliContext, apps: AppInfo[]): void {
  const user = apps.filter((a) => a.source === "user").length;
  say(ctx, `应用（${user} 个用户 / ${apps.length - user} 个内置）`);
  if (!apps.length) {
    say(ctx, "  （没有发现应用；用 amber apps new <id> 创建 flow 脚本）");
    return;
  }
  const idWidth = Math.max(10, ...apps.map((a) => a.id.length));
  const labelWidth = Math.max(16, ...apps.map((a) => a.label.length));
  for (const a of apps) {
    const status = a.error ? "  ✗ 加载失败" : "";
    say(ctx,
      `  ${a.id.padEnd(idWidth)}  ${a.label.padEnd(labelWidth)}  `
      + `${String(a.invariants).padStart(2)} 不变量 · ${a.source === "user" ? "用户" : "内置"}  ${a.path}${status}`);
    if (a.error) say(ctx, `      ${a.error.split("\n")[0]}`);
  }
}

/** flow 骨架：普通 JS，循环/条件/重试直接写。`placeholder` = 入口页仍是占位 example.com。 */
function flowScriptTemplate(id: string, goal: string, hosts: string[], startUrl: string, placeholder: boolean): string {
  const host = hosts[0] ?? "example.com";
  // 规划引导（唯一出处 planning-playbook.ts）：骨架注释是 Agent 建应用的第一眼——
  // 工具结果直接带源码，这里的六步法（v2.1，走查先行）在"要写应用的那个瞬间"被读到。
  const playbook = PLAN_PLAYBOOK_TEXT.split("\n").map((l) => (l ? ` * ${l}` : " *")).join("\n");
  return `/**
 * ${id} —— flow 应用：流程优先由决策语句组成（ctx.step(goal, { done })）。
 *
 * 分工：脚本只写“要达成什么 + 怎么算完成”；点哪里由引擎的规则/决策层决定。
 * 控制流（if/for/while）只用于真实分支/循环；脚本拿不到模型文本或分数，完成只认 done 信号。
 *
${playbook}
 *
 * done 不许猜（这条最容易踩）：写信号之前先看这一页真的长什么样——
 *   amber inspect --url <入口页> --json
 * inspect 只列“可行动”元素；h1/文本类 done 信号另需实证（原始 HTML 或运行 trace）。
 * 扫描面（B2）含 div[role=menuitem/menuitemradio/menuitemcheckbox/option/tab]（click 族）：
 * 弹层菜单项/下拉选项/页签自绘控件可直接 act；候选构成因此可能变化、同名候选可能变多
 * （如 tab 与按钮同 label），hint 按 label 匹配不受影响。
 * 任何选择器——包括文档与上游示例给的——落笔前都要对目标页核实一次。
 * 能用的 done 必须「动作前不成立、动作后成立」。凭想象写的文案可能把一次真的成功
 * 判成 no_progress（曾有单次实测：连点四次同一按钮每次都算 inert，最后停在预算上
 * ——历史个例，非普适结论）。
 * 反面陷阱同样致命（pre-held done）：done 引用了动作前就已存在的元素 → 引擎判定
 * 完成已成立、跳过实际动作（trace 记 done_preheld / skipped_actions，executed=false），
 * 步骤「零执行通过」，后续步骤连锁失败。exists 类 done 尤其容易踩——落笔前先自问：
 * 这个信号在动作之前是不是已经成立了？是就换成动作后才出现的证据（菜单打开后的
 * 菜单项、跳转后的 URL、弹出面板里才有的元素）。注意 done_preheld 只覆盖命令步
 * （有 act 命令闭集才在动作前预评估 done）；决策步不付这项成本、不会标记。
 *
 * judge 与 act 的选择器语义不同（互不通用，别把一面的写法抄到另一面）：
 *   judge.* 的 selector 是【任意 CSS】（css_exists/text/value，跨主 frame 与可达的子 frame——同源/跨源均可定位）；
 *   裸词会当 CSS 标签解析（judge.exists("Maps") 是在找 <Maps> 元素，不是找 label 文本）；
 *   act/ctx.hint 是【六形状闭集 + 池 label 匹配】（裸词按 label 四档匹配；
 *   a[aria-label~x] 是 label 别名——DOM 的 aria-label 提取期已并进 label，可正常命中）。
 *
 * ctx 只有这些面（没有 pageUrl()：入口页角色写在 meta.site.pages，用 openPage 取）：
 *   openPage(role) / open(url) / arrive(url, {done}) / step(desc, {id, act, done, url, slots, when, timeoutMs})
 *   / tabs() / switchTab({index|urlContains|titleContains})
 *   / manual(desc, {done}) / url() / read.text|value|count|attr / extract / collect / holds / waitFor
 *   / source（数据腿注册表，不是读槽位的口）/ run / done() / fail(code, reason) / hint / hints / command
 *   / slots（冻结 Record：脚本层读槽位值写 ctx.slots["键"]，键须在 meta.slots 声明）
 *   / runtime（只读投影：outDir/runId/today/epoch；epoch 是状态游标，dry 恒 0）
 *   / judge.url|exists|existsText|text|equals|value|all|any|not|manual
 *     ——all/any 是【变参】all(s1, s2, …)，不收数组；not 单参
 *   （when 守卫跳过的步返回 ok:false + stopCode=precondition_skipped，同样消耗预算。）
 *   url() 首次导航前是 "about:blank"——别拿它当入口页判断；入口页写在 meta.site.pages。
 *   judge.existsText(sel, "Traffic") = 存在文本含 Traffic 的元素；judge.exists(sel, {visible:true})
 *   = 存在且可见（池/离线面判不出可见性，诱导期不据此下结论）。
 *
 * 执行韧性（S4，两项都是步级 opt-in，缺省不写 = 行为不变）：
 *   force:true       动作走 Playwright force 语义（跳过 actionability，仍要求可定位）；
 *                    只用于作者已确认的瞬态弹层/动画控件——可能点到被遮挡目标（坐标上的顶层元素收事件）。
 *   staleRetry:true  动作失败且疑似 stale（stale_ref / action_failed / not-actionable 且节点已卸载）时，
 *                    重抽池→重解析同一声明目标→重试，最多 2 次（每次进 trace 行事件 stale_retry:[{attempt,reason,ref}]；结果汇总字段 stale_retries）。
 *   hover：命令闭集的指针原语——ctx.command("hover", sel) 只把指针移上去（:hover 菜单/图层面板），
 *     done 仍要写成动作后才成立的证据（例如 judge.exists("#panel-item", {visible:true})）。
 *   upload：命令闭集的上传原语——ctx.command("upload", "#file", ctx.value.slot("path")) 只对
 *     input[type=file] 成立；单文件 string / 多文件 string[]；路径必须存在（缺失=config_error），
 *     证据只记 basename。非 file 目标=action_unsupported；dry 不检查本机文件。
 *   clickAt：命令闭集的坐标点击原语——ctx.command("clickAt", "#cv", ctx.value.slot("coords"))
 *     在元素相对坐标上点击（canvas 这类只能点中心的自绘控件）；值是声明绑定的字符串 "x,y"
 *     （非负整数/有限小数，元素 padding box 左上角为原点）；只对 click 族成立，坏格式/越界=config_error。
 *     证据 executed_actions 记 {op:"clickAt", position:{x,y}}；dry 只校声明形状，不解析坐标。
 *   新标签页（A5，不会自动跟随）：window.open/target=_blank 动作后引擎仍停在原页——先 ctx.tabs()
 *     （免费只读：列出当前 context 未关闭的页，返回 [{index,url,title,active}]，index 0-based）
 *     再 ctx.switchTab({index|urlContains|titleContains})（子串大小写不敏感、多条件 AND）。
 *     必须恰好匹配 1 个：0/多 = 结构化 config_error（reason 列出当前 tabs，不回退随便选）；
 *     目标 URL 在 meta.hosts 信封外 = host_not_allowed 且不切换。切换计 1 个 flow step；
 *     dry 面：switchTab 只验声明形状（未知键/空 match/非法值仍红），对合法 match 恒返回合成
 *     成功 {ok:true,index:0,url:"(dry)",...}——match 是观察事实，dry 不据此判红，故不需要 dry 守卫。
 *
 * 值绑定写法（fill/select/drag/upload/clickAt 的值只认声明绑定，绝不猜）：对象字面量
 *   ctx.command("fill", "#username", { from: "slot", key: "username" })
 *   ——key 必须在 meta.slots 声明；缺值 = 结构化 needs_value。没有 ctx.value.fromSlot 之类的函数面。
 *   extract 有两种写法（二选一，都返回行对象数组）：
 *     ctx.extract("name")            // 具名：行/字段选择器声明在 meta.site.listExtract[name]
 *     ctx.extract({ rows: "li.item", fields: { title: ".title", price: ".price" } })  // inline：无需声明
 *   extract 到的数据要落盘：app.mjs 是 Node ESM 脚本，直接 import node:fs 写
 *   $AMBERFLOW_HOME/apps/<id>/outputs/（详见 amber schema ctx --topic data_out）。
 *   动态加载的长列表用 collect（整体计 1 步；内部滚动不占预算）：
 *     const feed = await ctx.collect({
 *       row: "#feed li.item", fields: { title: ".title", price: ".price" },
 *       until: { stableRounds: 2 },       // 或 { maxRows: 200 }
 *     });
 *     // feed = { rows, coverage:{rounds,rowsSeen,addedLastRound}, stopReason }
 *     // stopReason: stable | maxRows | budget | not_scrollable——诚实口径，不假装穷尽。
 *
 * 预算一图流（完整口径：amber schema ctx --topic budget）：
 *   免费不占预算：read.* / extract / holds / waitFor / log / url / tabs
 *   各计 1：ctx.step / ctx.arrive / ctx.run / 批准执行的人工步 / ctx.scrollList / ctx.expand / ctx.setRange / ctx.collect / ctx.switchTab
 *   step 内的 command 闭集不单独计步：一个 step 的动作循环上限 8（子目标动作预算）
 *   用满：budget_exceeded（status=partial、verified=false、exit 0）
 *
 * 稳定门（S2）：meta.policy.settle 缺省开启（{quiet_ms:400, timeout_ms:5000}）——引擎每次抽池前
 *   只在页面有 DOM 突变时等到静默（已静默 0 等待），等待进 step_traces[i].state.settleMs；
 *   写 "off" 关闭。
 *
 * 运行节奏（B1）：meta.pace.between_steps_ms 是**最小步间距**（start-to-start ≥ gap）——
 *   相邻两次引擎单元开始时刻至少隔 gap 毫秒，上一步耗时长则本步不补等，首个单元之前不等；
 *   between_actions_ms 是同一子目标内两次动作之间的等待。优先级 explicit > meta.pace > env
 *   （AMBERFLOW_STEP_DELAY_MS / AMBERFLOW_ACTION_DELAY_MS）> 0；非默认时结果带 pace.sources。
 *
 * 决策状态（S5，实验档，两项缺省都 off = 行为不变）：
 *   meta.policy.decision_state: { gate: "stable_only", context: "delta" }
 *   - gate="stable_only"：模型 ask 之前先等页面静默；池指纹（ask 池结构 hash）与该池结构下
 *     上一次真 ask 相同时不再敲模型——题面一字不差直接复用答复；仅结构相同则上次选择仍可行动
 *     （在池且未 forbidden）才复用；复用后低置信/reobserve 裁决照旧。指标进
 *     decisions 的 asks_saved / gate_waits（顶层平铺），行尾 state asks_saved N, gate_waits M, digest K。
 *   - context="delta"：决策请求带 ≤200B 结构化 state_digest（导航代数差/最近 effect/是否静默/
 *     池是否变化/flags）。provider 不支持（本地 laya-onnx 等）时整段跳过并记 context_skipped。
 *
 * act 省略 = 决策语句：引擎的规则/决策层按 goal 文本与 done 证据选目标。命中与否
 * 取决于 goal 与页面候选的可分辨度；歧义大时会升级模型裁决——规则命中和模型裁决
 * 都是正常路径，不必预设哪条一定稳。需要钉死某个目标、或页面有稳定句柄
 * （data-test / id / name / 唯一 label）时，写 act: ctx.hint(...) 收窄候选即可。
 * 跑得不稳先查 trace 的 stopCode/reason 与 decisions 行，再决定要不要加锚点。
 *
 * 学习捷径：现有应用就是最好的范例——amber apps list 看有哪些，
 * amber apps show <id> --code 直接读完整源码（extract/守卫/落盘的现成写法）。
 */
export const meta = (kit) => ({
  id: ${JSON.stringify(id)},
  label: ${JSON.stringify(id)},
  goal: ${JSON.stringify(goal)},
  hosts: ${JSON.stringify(hosts)},       // 允许访问的主机（导航信封 + 防泄漏门禁）
  site: { pages: { home: ${JSON.stringify(startUrl)} } },${placeholder ? " // TODO: 占位入口页，换成真实 URL" : " // 页面角色：流程里不重复硬编码 URL"}
  slots: {},                              // 数据槽：值只能来自声明/观察（不写进 goal 文本）
  invariants: [                           // 结束态断言：用 ctx.done() 验收
    { id: "on-target", desc: "结束时确实到了目标页", signal: kit.judge.url(${JSON.stringify(host)}) },
  ],
});

export async function flow(ctx) {
  await ctx.openPage("home");   // ← 入口页在 meta.site.pages 里声明

  // 决策语句：目标 + 完成证据。done 写成 inspect 看到的事实；有稳定锚点就点名 act。
  // const r = await ctx.step("把商品加入购物车", {
  //   id: "add-to-cart",
  //   act: ctx.hint("[data-test=add-to-cart]"),   // 省略 act = 完全交给决策层（见顶部说明）
  //   done: ctx.judge.url("cart"),               // ← 换成这一页动作后真的会成立的信号
  // });
  // if (!r.ok) ctx.fail(r.stopCode ?? "step_failed", r.reason);

  // 完成信号按可见文本断言（innerText-only 的按钮/面板，r8 Traffic 场景）：
  // const t = await ctx.step("打开 Traffic 视图", {
  //   act: ctx.hint("Traffic"),
  //   done: ctx.judge.existsText("#traffic-panel", "Traffic"),   // 存在文本含 Traffic 的元素
  // });
  // if (!t.ok) ctx.fail(t.stopCode ?? "step_failed", t.reason);

  // hover 原语（S4）：只把指针移到目标上，展开 :hover 菜单/图层面板（不点击、不导航）。
  // const layer = await ctx.step("展开图层面板", {
  //   act: [ctx.command("hover", "[data-test=layers]")],
  //   done: ctx.judge.exists("#layer-panel", { visible: true }),   // 动作后才可见的证据
  // });
  // if (!layer.ok) ctx.fail(layer.stopCode ?? "step_failed", layer.reason);
  //
  // 瞬态弹层/SPA 重渲染（S4，opt-in）：staleRetry 在点前节点被替换时重抽池→重解析同一目标→重试（≤2 次）；
  // force 跳过 actionability（只用于已确认的动画/瞬态遮挡，可能点到被遮挡目标）。
  // const sort = await ctx.step("按价格排序", {
  //   act: [ctx.command("click", "[data-test=sort-price]")],
  //   staleRetry: true,
  //   done: ctx.judge.url("sort=price"),   // ← 换成动作后真的会成立的证据
  // });
  // if (!sort.ok) ctx.fail(sort.stopCode ?? "step_failed", sort.reason);

  // 步级 slots：只覆盖这一步的槽位绑定值（不需要提前写进 meta.slots 的默认值）。
  // const search = await ctx.step("搜索酒店", {
  //   slots: { query: "北京 酒店" },   // ← 值来自任务输入；slot 缺值 = needs_value，绝不猜
  //   done: ctx.judge.url("search"),  // ← 换成动作后才会成立的信号
  // });

  await ctx.done();   // 结束态不变量在这里验收；失败会抛 invariant_failed
}
`;
}

function hostFromUrl(raw: string): string | null {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostsOf(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  return [...new Set(list.map((h) => h.trim().toLowerCase()).filter(Boolean))];
}

/** `amber apps new <id>`：生成一个可跑的 flow 应用骨架。 */
async function appsNew(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, {
    json: { type: "boolean" }, help: { type: "boolean" },
    goal: { type: "string" }, dir: { type: "string" },
    host: { type: "string", multiple: true }, url: { type: "string" },
    force: { type: "boolean" }, print: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps new <id> [--goal <目标>] [--host HOST] [--url <入口页>] [--dir <目录>] [--force] [--print] [--json]");
    return 0;
  }
  const id = parsed.positionals[0];
  if (!id) throw usageError("apps new 需要一个应用 id", { next: ["amber apps new my-app"] });
  if (parsed.positionals.length > 1) throw usageError("apps new 只接受一个 id");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw usageError(`应用 id ${JSON.stringify(id)} 不合法`, {
      hint: "小写字母开头，只含小写字母 / 数字 / 连字符（它同时是目录名与 amber run 的参数）。",
    });
  }
  // B4a（01 轮）：只有显式给了 --url 才补入口页主机；占位 example.com 绝不进 hosts 信封——
  // 作者只声明了真实主机时，导航门禁里就该只有那个主机，别“悄悄放宽一半还无人报错”。
  const givenUrl = typeof parsed.values.url === "string" && parsed.values.url ? parsed.values.url : "";
  if (givenUrl && !/^https?:\/\//i.test(givenUrl)) {
    throw usageError(`--url 需要真实 http(s):// 页面（收到 ${JSON.stringify(givenUrl)}）`);
  }
  const hosts = hostsOf(parsed.values.host);
  const startUrl = givenUrl !== ""
    ? givenUrl
    : hosts.length ? `https://${hosts[0]}/` : "https://example.com/";
  const placeholder = givenUrl === "" && hosts.length === 0;
  const inferred = givenUrl !== "" ? hostFromUrl(givenUrl) : null;
  // 显式入口页必须在 hosts 信封内：补上入口页主机，避免骨架一跑就 host_not_allowed。
  if (inferred !== null && !hosts.includes(inferred)) hosts.unshift(inferred);
  const finalHosts = hosts.length ? [...new Set(hosts)] : ["example.com"];
  const goal = typeof parsed.values.goal === "string" && parsed.values.goal
    ? parsed.values.goal
    : "把这条流程要达成的结果写清楚（一句话）";
  const dir = typeof parsed.values.dir === "string" && parsed.values.dir
    ? path.resolve(ctx.cwd, parsed.values.dir)
    : path.join(userAppsDir(ctx.env), id);
  const file = path.join(dir, "app.mjs");
  const source = flowScriptTemplate(id, goal, finalHosts, startUrl, placeholder);
  const next = [`amber apps check ${id}`, `amber apps explain ${id}`, `amber run ${id}`];
  if (parsed.values.print) {
    if (jsonWanted(ctx, parsed.values)) {
      emitJson(ctx, successEnvelope("apps new", { app: id, goal, hosts: finalHosts, path: file, source }, { next }));
    } else {
      say(ctx, source);
    }
    return 0;
  }
  if (fs.existsSync(file) && !parsed.values.force) {
    throw usageError(`已存在 ${file}`, {
      hint: "换一个 id，或加 --force 覆盖（旧的 app.mjs 会被替换）。",
      next: ["amber apps list"],
    });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, source, "utf-8");
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps new", { app: id, goal, hosts: finalHosts, path: file }, { next }));
  } else {
    say(ctx, `✓ 已生成 ${file}（flow 脚本）`);
    say(ctx, "  这是**可跑**的骨架（把入口页/目标/完成条件换成你的真实页面），先验证再改：");
    for (const n of next) say(ctx, `    ${n}`);
    say(ctx, "  改流程就是改这个 app.mjs；没有 JSON 步骤文件，也没有 set-step。");
  }
  return 0;
}

function printShow(ctx: CliContext, loaded: Awaited<ReturnType<typeof loadScriptApp>>, codeRequested: boolean): void {
  const pack = loaded.pack;
  say(ctx, `${pack.id} — ${pack.label}`);
  say(ctx, `  目标：${pack.goal}`);
  say(ctx, `  形态：flow 脚本（步骤在运行期产生） · ${sourceLabel(sourceOf(loaded.scriptPath, ctx))}`);
  say(ctx, `  路径：${scriptDisplayPath(loaded.scriptPath)}`);
  say(ctx, `  script_sha256：${loaded.scriptSha256.slice(0, 16)}…  plan_sha256：${loaded.planSha256.slice(0, 16)}…`);
  if (pack.hosts?.length) say(ctx, `  hosts：${pack.hosts.join(", ")}`);
  if (pack.slots && Object.keys(pack.slots).length) {
    say(ctx, `  参数：${Object.keys(pack.slots).join(", ")}`);
  }
  if (pack.required_slots?.length) say(ctx, `  必填参数：${pack.required_slots.join(", ")}`);
  if (pack.invariants?.length) {
    say(ctx, `  验收条件（${pack.invariants.length}）：`);
    for (const inv of pack.invariants) {
      say(ctx, `    - ${inv.id}: ${inv.desc ?? ""} ${JSON.stringify(inv.signal)}`);
    }
  }
  say(ctx, "  步骤：运行期产生——用 `amber apps explain` 看 dry 调用序列");
  if (codeRequested) say(ctx, `  源码：${codeOf(loaded.scriptPath).code}`);
  say(ctx, `  下一步：amber apps check ${pack.id}`);
}

function sourceLabel(source: "user" | "built-in"): string {
  return source === "user" ? "用户" : "内置";
}

const CODE_LIMIT = 64 * 1024;
function codeOf(file: string): { code: string; truncated: boolean } {
  const raw = fs.readFileSync(file, "utf-8");
  return raw.length > CODE_LIMIT
    ? { code: raw.slice(0, CODE_LIMIT), truncated: true }
    : { code: raw, truncated: false };
}

async function appsShow(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, {
    json: { type: "boolean" }, help: { type: "boolean" }, code: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps show <应用|脚本路径> [--code] [--json]");
    return 0;
  }
  const target = parsed.positionals[0];
  if (!target) throw usageError("apps show 需要一个应用 id 或脚本路径", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps show 只接受一个应用");
  let loaded: Awaited<ReturnType<typeof loadScriptApp>>;
  try {
    loaded = await loadScriptApp(target);
  } catch (err) {
    throw usageError(`找不到应用 '${target}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list"],
    });
  }
  const pack = loaded.pack;
  const codeRequested = parsed.values.code === true;
  if (jsonWanted(ctx, parsed.values)) {
    const code = codeRequested ? codeOf(loaded.scriptPath) : null;
    emitJson(ctx, successEnvelope("apps show", {
      app: pack.id,
      label: pack.label,
      goal: pack.goal,
      path: loaded.scriptPath,
      source: sourceOf(loaded.scriptPath, ctx),
      script_sha256: loaded.scriptSha256,
      plan_sha256: loaded.planSha256,
      hosts: pack.hosts ?? [],
      slots: pack.slots ?? {},
      required_slots: pack.required_slots ?? [],
      sources: pack.sources ?? [],
      invariants: pack.invariants ?? [],
      ...(pack.policy === undefined ? {} : { policy: pack.policy }),
      ...(pack.pace === undefined ? {} : { pace: pack.pace }),
      ...(code === null ? {} : { code: code.code, code_truncated: code.truncated }),
    }, { next: [`amber apps check ${pack.id}`, `amber apps explain ${pack.id}`, `amber run ${pack.id}`] }));
    return 0;
  }
  printShow(ctx, loaded, codeRequested);
  return 0;
}

async function appsCheck(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" }, slot: { type: "string", multiple: true } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps check [<应用|脚本>] [--slot k=v]... [--json]");
    return 0;
  }
  const slots = parseSlotArgs(parsed.values.slot);
  if (parsed.positionals.length > 1) throw usageError("apps check 最多接受一个应用");
  const requested = parsed.positionals[0];
  const targets = requested
    ? [{ id: requested, script: requested }]
    : listAppDirs().map((e) => ({ id: e.id, script: e.script }));
  if (!targets.length) {
    if (jsonWanted(ctx, parsed.values)) {
      emitJson(ctx, successEnvelope("apps check", { checked: 0, ok: true, results: [] }, {
        next: ["amber apps new <id>"],
      }));
    } else {
      say(ctx, "没有发现可校验的应用。");
    }
    return 0;
  }
  const results: Array<{ app: string; path: string; problems: string[] }> = [];
  for (const t of targets) {
    try {
      const loaded = await loadScriptApp(t.script);
      const problems = validateApp(loaded.pack, { allowEmptyJourney: true });
      const dry = await dryRunFlow(loaded, { slots });
      problems.push(...dry.problems);
      results.push({ app: loaded.pack.id, path: loaded.scriptPath, problems });
    } catch (err) {
      results.push({ app: t.id, path: t.script, problems: [err instanceof Error ? err.message : String(err)] });
    }
  }
  const bad = results.filter((r) => r.problems.length);
  const exitCode = bad.length ? 2 : 0;
  if (jsonWanted(ctx, parsed.values)) {
    const envelope = successEnvelope("apps check", {
      checked: results.length, ok: bad.length === 0, results,
    }, { exitCode, next: bad.length ? ["amber apps show <id>"] : ["amber run <id>"] });
    if (bad.length) {
      envelope.ok = false;
      envelope.error = {
        code: "USAGE",
        message: `${bad.length}/${results.length} 个应用未通过校验`,
        hint: "看 results[].problems；apps check 不启动浏览器。",
        next: ["amber apps show <id>"],
      };
    }
    emitJson(ctx, envelope);
    return exitCode;
  }
  for (const r of results) {
    if (!r.problems.length) {
      say(ctx, `✓ ${r.app}  ${r.path}`);
    } else {
      say(ctx, `✗ ${r.app}  ${r.path}`);
      for (const p of r.problems) say(ctx, `    - ${p}`);
    }
  }
  say(ctx, "");
  say(ctx, bad.length
    ? `${bad.length}/${results.length} 个应用未通过校验。`
    : `${results.length} 个应用全部通过校验。`);
  return exitCode;
}

/** 把信号渲染成人话（explain 用；未识别算子原样 JSON，绝不假装理解）。 */
function renderSignal(spec: unknown): string {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return JSON.stringify(spec);
  const parts: string[] = [];
  for (const [op, arg] of Object.entries(spec as Record<string, unknown>)) {
    if (op === "all_of" || op === "any_of") {
      const kids = Array.isArray(arg) ? arg.map(renderSignal) : [renderSignal(arg)];
      parts.push(`${op === "all_of" ? "全部" : "任一"}（${kids.join("；")}）`);
    } else if (op === "not") {
      parts.push(`非（${renderSignal(arg)}）`);
    } else if (op === "manual") {
      parts.push(`人工确认：${String(arg)}`);
    } else if (op === "url_contains") {
      parts.push(`URL 含「${String(arg)}」`);
    } else if (op === "css_exists") {
      parts.push(`存在 ${String(arg)}`);
    } else if (op === "css_exists_text") {
      const [sel, want] = arg as unknown[];
      parts.push(`存在 ${String(sel)} 且文本含「${String(want)}」`);
    } else if (op === "css_visible_exists") {
      parts.push(`存在且可见 ${String(arg)}`);
    } else if (op === "css_text_contains") {
      const [sel, want] = arg as unknown[];
      parts.push(`${String(sel)} 含「${String(want)}」`);
    } else if (op === "css_text_equals") {
      const [sel, want] = arg as unknown[];
      parts.push(`${String(sel)} 等于「${String(want)}」`);
    } else if (op === "css_value_equals") {
      const [sel, want] = arg as unknown[];
      parts.push(`${String(sel)} 的值等于「${String(want)}」`);
    } else if (op === "exit_ok") {
      parts.push("退出码在成功白名单里");
    } else if (op === "exit_code_equals") {
      parts.push(`退出码 = ${String(arg)}`);
    } else if (op === "stdout_contains") {
      parts.push(`stdout 含「${String(arg)}」`);
    } else if (op === "stdout_matches") {
      parts.push(`stdout 匹配 /${String(arg)}/`);
    } else if (op === "stderr_contains") {
      parts.push(`stderr 含「${String(arg)}」`);
    } else if (op === "json_path_equals") {
      const [p, want] = arg as unknown[];
      parts.push(`JSON ${String(p)} = ${String(want)}`);
    } else if (op === "file_exists") {
      parts.push(`文件存在 ${String(arg)}`);
    } else if (op === "file_absent") {
      parts.push(`文件不存在 ${String(arg)}`);
    } else {
      parts.push(`${op}=${JSON.stringify(arg)}`);
    }
  }
  return parts.join(" 且 ");
}

/** `amber apps explain <脚本>`：dry 跑一遍 flow，把调用序列渲染成人话。 */
async function appsExplain(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" }, slot: { type: "string", multiple: true } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps explain <脚本路径|应用 id> [--slot k=v]... [--json]");
    return 0;
  }
  const slots = parseSlotArgs(parsed.values.slot);
  const target = parsed.positionals[0];
  if (!target) throw usageError("apps explain 需要一个脚本路径或应用 id", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps explain 只接受一个应用");
  let loaded: Awaited<ReturnType<typeof loadScriptApp>>;
  try {
    loaded = await loadScriptApp(target);
  } catch (err) {
    throw usageError(`无法加载应用 '${target}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list", "amber apps new <id>"],
    });
  }
  const pack = loaded.pack;
  const dry = await dryRunFlow(loaded, { slots });
  const invs = pack.invariants ?? [];
  const rows = dry.trace.events.map((ev) => ({
    i: ev.i, call: ev.call, id: ev.id, desc: ev.desc, url: ev.url,
    ok: ev.ok === undefined ? null : ev.ok,
    ...(ev.stop_code === undefined ? {} : { stop_code: ev.stop_code }),
  }));
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps explain", {
      app: pack.id,
      label: pack.label,
      goal: pack.goal,
      path: loaded.scriptPath,
      script_sha256: loaded.scriptSha256,
      plan_sha256: loaded.planSha256,
      problems: dry.problems,
      events: rows,
      invariants: invs.map((inv) => ({ id: inv.id, desc: inv.desc, signal: inv.signal, done: renderSignal(inv.signal) })),
    }, { exitCode: dry.problems.length ? 2 : 0, next: dry.problems.length ? ["amber apps check <id>"] : [`amber run ${pack.id}`] }));
    return dry.problems.length ? 2 : 0;
  }
  say(ctx, `${pack.id} — ${pack.goal}（flow 脚本：dry 调用序列）`);
  say(ctx, "");
  for (const ev of rows) {
    const head = `${String(ev.i).padStart(2, " ")}. [${ev.call}]${ev.id ? ` (${ev.id})` : ""} ${ev.desc ?? ""}`;
    const where = ev.url === undefined || ev.url === "about:blank" ? "（当前页）" : ev.url;
    say(ctx, `${head} → ${where}${ev.ok === false ? `  ✗ ${ev.stop_code ?? "failed"}` : ""}`);
  }
  if (invs.length) {
    say(ctx, "");
    say(ctx, "结束态不变量：");
    for (const inv of invs) say(ctx, `  - ${inv.id}${inv.desc ? `：${inv.desc}` : ""}`);
  }
  if (dry.problems.length) {
    say(ctx, "");
    for (const p of dry.problems) say(ctx, `✗ ${p}`);
  }
  say(ctx, "");
  say(ctx, `脚本：${scriptDisplayPath(loaded.scriptPath)}  plan_sha256=${loaded.planSha256.slice(0, 16)}…`);
  return dry.problems.length ? 2 : 0;
}

async function appsPath(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps path <应用>");
    return 0;
  }
  const id = parsed.positionals[0];
  if (!id) throw usageError("apps path 需要一个应用 id", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps path 只接受一个应用");
  let loaded: Awaited<ReturnType<typeof loadScriptApp>>;
  try {
    loaded = await loadScriptApp(id);
  } catch (err) {
    throw usageError(`找不到应用 '${id}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list"],
    });
  }
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps path", { app: loaded.pack.id, path: loaded.scriptPath }));
  } else {
    say(ctx, loaded.scriptPath);
  }
  return 0;
}

async function appsRemove(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, {
    json: { type: "boolean" }, help: { type: "boolean" },
    yes: { type: "boolean" }, force: { type: "boolean" },
  });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps remove <应用> [--yes] [--force]");
    return 0;
  }
  const id = parsed.positionals[0];
  if (!id) throw usageError("apps remove 需要一个应用 id", { next: ["amber apps list"] });
  if (parsed.positionals.length > 1) throw usageError("apps remove 只接受一个应用");
  let loaded: Awaited<ReturnType<typeof loadScriptApp>>;
  try {
    loaded = await loadScriptApp(id);
  } catch (err) {
    throw usageError(`找不到应用 '${id}'`, {
      hint: err instanceof Error ? err.message : String(err),
      next: ["amber apps list"],
    });
  }
  const pack = loaded.pack;
  const scriptPath = path.resolve(loaded.scriptPath);
  const dir = path.dirname(scriptPath);
  const userRoot = path.resolve(userAppsDir(ctx.env));
  const builtinRoot = path.resolve(APPS_DIR);
  const inUser = inside(scriptPath, userRoot);
  const inBuiltin = inside(scriptPath, builtinRoot);
  if (!inUser && !inBuiltin) {
    throw usageError(`拒绝删除 ${scriptPath}：只允许删除用户作用域或内置 apps/ 下的应用`, {
      hint: "手工移动过的应用请直接用文件管理器处理。",
    });
  }
  if (inBuiltin && !parsed.values.force) {
    throw blockedError(`拒绝删除内置应用 '${pack.id}'`, {
      hint: "内置应用属于仓库夹具；确实要删加 --force（删错可从仓库历史恢复）。",
      next: ["amber apps remove <id> --force"],
    });
  }
  const yes = ctx.globals.yes || Boolean(parsed.values.yes);
  if (!yes) {
    if (!ctx.isTTY) {
      throw blockedError(`删除 '${pack.id}' 需要确认`, {
        hint: "非 TTY 请加 --yes；--yes 不隐含 --allow-dangerous。",
        next: [`amber apps remove ${pack.id} --yes`],
      });
    }
    const rl = (await import("node:readline/promises")).createInterface({
      input: ctx.stdin,
      output: process.stdout,
    });
    let ok = false;
    try {
      const answer = (await rl.question(`删除 ${pack.id}（${dir}）？[y/N] `)).trim().toLowerCase();
      ok = answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
    if (!ok) {
      say(ctx, "已取消。");
      return 0;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps remove", { app: pack.id, removed: dir }));
  } else {
    say(ctx, `✓ 已删除 ${pack.id}：${dir}`);
  }
  return 0;
}

export async function runApps(args: string[], ctx: CliContext): Promise<number> {
  let sub = args[0];
  let rest = args.slice(1);
  if (sub === undefined || sub === "--list" || sub === "--help" || sub === "-h") {
    if (sub === "--help" || sub === "-h") {
      const { commandHelp } = await import("../registry.ts");
      say(ctx, commandHelp("apps"));
      return 0;
    }
    sub = "list";
    rest = args[0] === "--list" ? args.slice(1) : args;
  }

  switch (sub) {
    case "list":
      return appsList(rest, ctx);
    case "new":
      return appsNew(rest, ctx);
    case "show":
      return appsShow(rest, ctx);
    case "check":
      return appsCheck(rest, ctx);
    case "explain":
      return appsExplain(rest, ctx);
    case "path":
      return appsPath(rest, ctx);
    case "remove":
    case "rm":
      return appsRemove(rest, ctx);
    default:
      throw usageError(`未知的 apps 子命令 '${sub}'`, {
        hint: "可用：list / new / show / check / explain / path / remove",
        next: ["amber apps --help"],
      });
  }
}

function parseSimple(args: string[], options: Record<string, { type: "boolean" | "string"; multiple?: boolean }>) {
  try {
    return parseArgs({ args, allowPositionals: true, options });
  } catch (err) {
    throw usageFromParseError(err);
  }
}

/** `--slot k=v`（可重复）→ Record；重复键 / 缺 `=` 都在用法层红（对齐桥的同名防重复逻辑）。 */
function parseSlotArgs(entries: unknown): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const raw of Array.isArray(entries) ? entries : []) {
    const s = String(raw);
    const at = s.indexOf("=");
    if (at <= 0) throw usageError(`--slot 需要 k=v 形式，收到 ${JSON.stringify(s)}`);
    const key = s.slice(0, at);
    if (key in slots) throw usageError(`--slot 重复键 ${JSON.stringify(key)}`);
    slots[key] = s.slice(at + 1);
  }
  return slots;
}

function jsonWanted(ctx: CliContext, v: { json?: boolean }): boolean {
  return ctx.globals.json || Boolean(v.json);
}

async function appsList(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseSimple(args, { json: { type: "boolean" }, help: { type: "boolean" }, verbose: { type: "boolean" } });
  if (parsed.values.help) {
    say(ctx, "用法：amber apps list [--json]");
    return 0;
  }
  const apps = await listAppInfos(ctx);
  if (jsonWanted(ctx, parsed.values)) {
    emitJson(ctx, successEnvelope("apps list", {
      apps,
      counts: {
        total: apps.length,
        user: apps.filter((a) => a.source === "user").length,
        builtin: apps.filter((a) => a.source === "built-in").length,
      },
    }, { next: ["amber apps show <id>", "amber run <id>", "amber apps new <id>"] }));
    return 0;
  }
  printList(ctx, apps);
  return 0;
}
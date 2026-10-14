> **状态（2026-10）**：本仓库现在是 **TypeScript 单一技术栈**。
> 下文描述的 Python 实现已整体移出、并经审查后彻底删除（见 [BACKUP.md](BACKUP.md)）；
> 文中的 `python xxx.py` / `pytest` 命令指向**已彻底移除**的参考实现（见 [BACKUP.md](BACKUP.md)）；
> 对应的 TS 入口见 [README.md](README.md)。
> 设计规范、实测结论与用例记录照旧有效——TS 代码的注释大量引用它们。

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-automation middleware built on top of the **pip-installed `laya` package** (v0.3.5, a non-autoregressive decision engine — each question is one forward pass ≈35 ms on the local CUDA GPU). The laya *source* is not in this repo; it lives in `C:\Python314\Lib\site-packages\laya\` (`common.py` has the model architecture, `build_sequence` serialization, `proper_reward` scoring rule). Nothing here trains laya — fine-tuning exists only in `_laya_finetune_ref.ipynb` (official Kaggle notebook, saved from NandhaKishorM/laya).

Environment: the author's box is Windows (bash shell), Python 3.14, CUDA (≈35 ms per laya forward pass); this Linux checkout runs the same suite CPU-only (≈0.5–1 s per forward pass, Python 3.12) and resolves chromium through `browser_env.py`. Model checkpoints are cached in `~/.cache/huggingface` (`convaiinnovations/laya` plus the `multilingual/` subfolder); everything runs offline unless an LLM endpoint is configured.

## Commands

一条命令开始一项工作（README 的首选入口）：

```bash
npm start                                        # 开箱任务：自带页面上跑一份真实计划（离线、零配置）
npm start -- --goal "把商品加入购物车" --url <页面>   # 演示一次 → 归纳完成信号 + 点名目标 → 执行
npm run doctor                                   # 环境体检：Node / chromium / 决策模型 / LLM（缺件点名 + 补齐命令）
npm run model:fetch -- --from <url|本地路径>       # 决策模型产物通道：图+权重(+tokenizer)，SHA256 先验后换
```


```bash
npm ci                                   # Node ≥ 22.6；工具脚本跑在 `node --experimental-strip-types` 下
npm run verify                           # 一键门禁：typecheck + 全部测试 + 六层跨实现对拍
bash bench/smoke.sh                      # CI 调用的唯一"绿色"定义（离线部分无条件；模型侧缺产物时打印 SKIP）
npm test                                 # 1132 个测试：仓库不变量 / 执行器 / 提取 / 计划 / 用例 / 对拍语料（条数单一出处 docs/arch-metrics.json（口径：`npx vitest list | grep -cE "^(tests|integrations)/"`））
npm run test:parity                      # 六层跨实现对拍：rules/extraction/executor/datasource/ctrip/transfer

npm run bench:fixtures                   # 冻结计划跑分矩阵的离线夹具用例（需 ONNX 产物，走生产执行器循环）
npm run bench -- --force-model router    # 同一批用例，按页面选择 checkpoint（laya.Router 语义）
bash bench/ablate.sh [tag]               # 消融矩阵：english|multilingual × rules on|off

node --experimental-strip-types src/ctrip-task.ts                  # ctrip 用例：19 冻结子目标 + 独立判分 7/7
node --experimental-strip-types src/ctrip-task.ts --no-hints       # 消融：去掉 hint → 0/7（置信度 0.13）
node --experimental-strip-types src/transfer-task.ts --site skybook
node --experimental-strip-types src/transfer-task.ts --site farehaven --no-when    # 去掉条件守卫 → 1/7
node --experimental-strip-types src/transfer-task.ts --site slowjet --no-retries   # 去掉重试 → 0/7
node --experimental-strip-types src/transfer-task.ts --metrics-only                # 不装模型、不开浏览器
node --experimental-strip-types src/datasource.ts --source ctrip-flights-h5        # 真实票价，config 驱动
node --experimental-strip-types src/datasource.ts --source ctrip-hotels-pc --dates 2026-10-09
node --experimental-strip-types src/datasource.ts --list                           # 应用包也是配置目录：<repo>/*/sources 与 apps/*/sources
node --experimental-strip-types src/datasource.ts --source git-log                 # CLI 通道：git 子进程 + lines_regex
node --experimental-strip-types src/datasource.ts --source bench-cases-shape       # CLI 通道：jq + json_stdout
node --experimental-strip-types src/qunar-task.ts                                  # qunar 迁移测试（边界已实测）
node --experimental-strip-types src/ip-config.ts                                   # Excel IP 规划表 → 设备网络页
node --experimental-strip-types src/camera-entry.ts                                # Excel 类型列路由两套表单
node --experimental-strip-types src/long-task.ts                                   # 全链路 demo：plan → execute → audit
node --experimental-strip-types src/path-a.ts [--confirm-safe]                     # Path A：Playwright + 固定动作拾取器
node --experimental-strip-types src/picker-server.ts                               # Path B：扩展用的本地模型服务
node --experimental-strip-types src/tune-guard.ts                                  # 注入闸门分离度实测
node --experimental-strip-types src/live-probe.ts                                  # 携程可达性矩阵（真实站点）
npm run plan-cli -- --help                                                         # 计划 CLI：new/add/edit/check/run
node --experimental-strip-types tools/learn.ts                                     # 演示一次就录成应用（零参数）
node --experimental-strip-types tools/learn.ts --json --yes --goal … --url …      # 外层 Agent 的一次调用
node --experimental-strip-types tools/spec-to-pack.ts --check                      # 生成的包 == 上游的展开
npm run shortlist                                                                  # 真 ONNX 的 shortlist demo
npm run semantic -- --app flight-cheapest --site site-a [--laya scripted|unsure|onnx]   # 语义流：模板跨站迁移 + 三级解析回填环
npm run plan:flow -- --goal "订5月18日昆明到北京最低价机票" --seed <页面> --app <id> --yes   # plan 端到端：看页面→归纳信号→模板+档案→门控落盘
```

语义流（SemanticFlow，2026-10）：`apps/<id>/flow.json`（spec_version 2，语义模板：页面角色 + 语义目标
+ **页面角色契约信号**，零站点选择器）+ `apps/<id>/sites/<site>.profile.json`（authored 站点知识：
pages 覆盖 / fill_keys 值绑定 / list_extract / frozen_signals）+ `sites/<site>.profile.json`（运行时
**学到的** hint，`replays_ok` 重放计数）。三级解析全接在既有缝上（执行循环零改动）：
①`SiteProfileMemory`（实现 `HintMemoryLike`，按（站点, 语义步 id）键控、人可读）回退取回已学 hint →
②desc 进元素池 Laya 现场选 → ③`escalateFn` 老师点名，**提名让 DOM/URL 信号成立才回填**（执行器
既有的 record 路径就是门）。"判断最低价"是 `list_step` 数据规则（extract → `select: min(price)` →
act_on），模型不产出"选哪行"——而且与数据引擎**共用同一实现** `datasource.selectIndex`（`order: min|max`），
所以浏览器侧与数据侧的"选哪行"不会各写一套。实测与边界见 [docs/SEMANTIC_FLOW_M1_REPORT.md](docs/SEMANTIC_FLOW_M1_REPORT.md)。
**红线 2 有牙**：回填的 hint 先只进内存（staged），**同一次运行内**再整跑一遍零模型重放，只有真的以规则
命中并完成的条目才落盘（`replays_ok` 从 1 起算），其余按原值撤回、报告记 `unverified`；`--no-verify-backfill`
是显式消融口（按现状落盘、`replays_ok: 0`、报告记 `skipped`）。已学 hint 连续 N 次（默认 2）没让信号成立
→ 报 `drift` 并撤下条目、下次重新学。**红线 3 有牙**：`dangerous` 步先走执行器 `dryRun`（三级解析 + 只读
`isVisible/isEnabled/中心 hit-test`，不点不填不滚动）拿到"会点到什么"的证据，再由
`--allow-dangerous`/`confirmDangerous(step, evidence)` 点头；干跑不成立 = 直接拒绝。站的文字系统结论
（`<html lang>` 优先，否则 CJK 占比 → `locale`/`checkpoint`）由 plan 首访写进档案、运行期据此选 checkpoint。
`npm run plan:flow`（M3）把"一句话 + 种子页"变成上面这套：逐步看页面 → 每步真执行 → 判据从**两次独立演示**
归纳（判别 + 稳定句柄 + 跨演示可复现，选不出来就 manual 停止，绝不猜），页面角色文件名 / 查询参数名 /
值绑定 / 行抽取全部观察进站点档案；**重放门控（runFlow 整跑）不过 = 一个文件都不落盘**（learn 的纪律）。
红线：plan **不写 hint**（档案 `steps` 恒空，hint 归运行期回填环）；dangerous 由 goal 里的"订/购买/pay"
自动标注。实测（含中文城市提取、`{slot}` 泛化、查询差分候选三处坑）见 [docs/SEMANTIC_FLOW_M3_REPORT.md](docs/SEMANTIC_FLOW_M3_REPORT.md)；
每条验收指标钉在哪个测试见方案文档 §8。

线上平台用例：`node --experimental-strip-types src/bench.ts --cases bench/cases-live.json --mode-tag live`（8 个真实站点，见 README 的实测一节）。

线上复测（2026-10-03，含四个可达性探针的逐项原始观测）：[bench/live-retest/REPORT.md](bench/live-retest/REPORT.md)。
复测时所有写文件的命令都带 `--out`，**不覆盖已提交的冻结语料**；探针的 URL/特征/结果目录全在
`apps/{ctrip,ota,qunar}-live/pack.json` 里声明（见 `src/probe-set.ts`）。

长流程线上用例：`node --experimental-strip-types src/bench.ts --cases bench/cases-live-long.json --mode-tag live-long`
（3 个真实站点 / 34 个子目标，一条命令跑完三条完整旅程；不进 CI，外部站点慢且会波动。
设计、逐子目标信号证据与它暴露的四个真实缺陷见 [bench/LONG_FLOW_REPORT.md](bench/LONG_FLOW_REPORT.md)）。

应用包（应用层）：`npm run apps -- --list` / `npm run apps -- --app demo-app`（离线整跑：
数据腿 → 混合旅程（工具步 + 浏览器步）→ 结束状态不变量）/ `npm run apps -- --app demo-app --dry`（只展开计划）。
真实应用：`--app ctrip-case --no-sources`（19 个冻结子目标跑本地复刻站，与 `src/ctrip-task.ts`
的计划**逐字段全等**）、`--app ip-config`（Excel IP 规划表 → 设备网络页，含"表格写错的那行由设备页
自己拒绝"）、`--app camera-entry`（Excel 类型列路由两套表单：空类型行按**行内证据**显式选页、
坏序列号那行显式成步）、`--app transfer-voyagio --no-sources`（第二个复刻站：**两页向导** 24 步）、
`--app transfer-slowjet --no-sources`（第三个复刻站：**冷启动重试** 19 步）、
`--app transfer-trekly --no-sources`（第四个复刻站：价格上限是**滑块**，19 步）、
`--app transfer-farehaven --no-sources`（第五个复刻站：**条件浮层 `when`**，24 步 = 20 done + 4 skipped）、
`--app transfer-skybook --no-sources`（第六个：23 步、唯一带**分页**的骨架）、
`--app transfer-flyquest --no-sources`（第七个：结果页**只能靠提交搜索表单**到达）。
线上应用：`--app qunar-live --out /tmp/qunar`（真网络 + 真模型，**包里声明了 iPhone 设备面**；见下条规则）。清单与"完成一个应用"的五条定义：[apps/INVENTORY.md](apps/INVENTORY.md)；独立复核（题 → 命令 →
原始观测 → 结论，含 11 处缺陷与 3 处共享层修补）：[bench/APP_VERIFY_REPORT.md](bench/APP_VERIFY_REPORT.md)。
新增一个应用 = 新目录 `apps/<id>/`（`pack.json` + 可选 `sources/*.json`），**共享层零改动**；
**也可以"演示一次"就录出来**：`npm run learn`（人：连他正开着的浏览器 `--cdp`——**挂载模式也认 `--url`**，
给了就导航那一页，退出**只断开不关闭**；实测过不给 `--url` 会停在 about:blank 然后拿用户的选择器点不到东西。
或给 `--url`；他做一遍，
信号与不变量由引擎归纳，他只回 y/n）／`npm run agent -- --goal … --url …`（外层 Agent 的一次调用，同引擎 `--json --yes`）。
两条硬规矩：① **不变量从"回放形状的那次运行"归纳**，不是从人演示的那次（演示是连续会话、会累积页面状态，
回放是每个子目标重新导航——实测过角标在演示里到 2、回放只到 1）；② **落盘门槛 = 规则模式零模型调用回放通过**，
回放不过就不写文件，复跑里不成立的候选会被明确剔除并写进 notes（不静默改绿）。包里带 `recorded_from` 血统。
**不变量也不必猜**：`npm run apps:induce -- --app <id> [--write]` 跑通一次，从"旅程少做最后一步"与
"结束后"两个状态提出候选（区分性 + 稳定句柄 + 复跑一致三关），`--write` 只追加并在写回后**立刻重跑**，
重跑不成立的候选自动撤掉。
**流程不必手写**：`npm run apps:gen -- --write --id <app> --spec <key>`（或 `--source <模块>#<导出名>`
从代码里的应用级计划）生成整个包
（旅程逐字段 = `emitPlan(spec)` 的展开结果，`generated_from.plan_sha256` 是展开内容的指纹；
`--check` 已进 `bench/smoke.sh`）。**展开日期是钉住的**（单一出处 `tools/frozen-today.ts` 的 `FROZEN_TODAY = 2026-10-02`）：spec 的
`per_date` 阶段按"下周"算，所以"当天是哪天"会改变展开结果——2026-10-04（周日）算出的那一周是 10-05..09，
跨到 10-05（周一）就变成 10-12..16，**同一个提交周日绿、周一红**。本轮实测到它同时打红四处：
`apps:gen --check`（7 个包漂移）、`tests/transfer.test.ts`（15 条）、`tools/transfer-parity.ts`（41 项不一致）、
`bench/smoke.sh` 的 3b/3c oracle 用例（各 0/7）。现在四处共用同一个常量：生成器/检查器（环境变量不算，只有显式
`--today` 能换周）、对拍工具、`tests/frozen-today.ts`（测试夹具）、smoke 的第 3b/3c 步。要换周就同时改这一处。当前 8 个应用是生成的（`apps:matrix` 的"来源"列标出）。
生成器**沿用种子包的角色结构、只把值换成展开结果**，并且**不发明判断**——`invariants`/`notes`/探针
这些判断与测量仍然是人的，缺 `invariants` 时它会明说。
度量与防泄漏门禁：`npm run apps:matrix`。**"所有应用都完成了吗"的答案**：`npm run apps:suite`
（跑完每个旅程型应用的验收，一行一个应用：步骤/跳过/不变量/用时/结论；线上应用与测量型应用自动被识别为
"要真网络"并**明着跳过**——跳过不等于通过；危险步未放行记成**未执行（危险步未放行）**，既不算绿也不算红，
因为绿色的前提是真的执行过）。**它的退出码是分层的**：`0`=全部真执行且通过、`1`=有未通过（含"加载失败"，
逐应用 try/catch，坏包只影响它自己那一行）、`2`=用法错误（`--only` 未命中会列出已知应用名）、`3`=有未执行。
一轮真实用户体验评审（三个子代理扮演使用者，见 [bench/UX_REVIEW.md](bench/UX_REVIEW.md)）揪出的问题都已在
同一轮修掉：`--slot` 的键必须声明过（以前打错名字是**静默假绿**）、`--only` 打错字不再"0/0 通过"、
缺目标时的报错改成 `step N names no target: …`（以前是 `picked ref 'undefined' is not in the element pool`，
使用者完全看不懂）、`npm start` 会把**写进仓库的检查点路径**打印出来、危险步在 CLI/报告/套件三处只有一套说法
（`REFUSAL_LABELS`，含"怎么补救"与"有没有落盘"）。怎么加见 [apps/README.md](apps/README.md)。

工具步（命令行当动作腿）：`npm run apps -- --app cli-report --allow-dangerous`（桩工具：
退出码 / JSON 路径 / stderr / 幂等重试 / 干跑+确认+落盘）、`--app repo-report`（真实 git + jq）。
不带 `--allow-dangerous` 时危险步会被**拒绝**且不落盘。

探针基线：`npm run probes:baseline -- --check` 把包里 `probe.baseline.verdicts`（上一次真实探测的判决）
与已入库的探测记录比——站点变了、或有人手改了包，都会红；`--write` 刷新（只存标量观察，不存 `*_reason`）。

探针集（测量型应用）：`apps/ctrip-live` / `apps/ota-live` / `apps/qunar-live` 声明了全部 URL、站点特征、
结果目录与判决角色；驱动只剩"怎么测"（`src/live-probe.ts` / `live-capture.ts` / `ota-probe.ts` /
`qunar-probe.ts` / `qunar-task.ts`，它们现在都在共享层**核心**名单里）。`npm run apps:matrix` 的债计数：
**0 处**（含"非核心文件里写死的 http 主机"这一独立的扫描口径）。复测用 `--out`：
`src/live-probe.ts --out /tmp/x.json` / `src/live-capture.ts --out /tmp/dir` /
`src/ota-probe.ts --out /tmp/x.json`。

**Python 参考命令**（`pytest`、`python3 xxx.py`、`pip install -r requirements.txt`）属于**已彻底移除**的参考实现：
工作树与 git 历史都已删除，磁盘上不再有 Python 文件（见 `BACKUP.md`）。
本仓库不包含 Python，也不再需要 Python 环境；六层对拍改为对**已入库的冻结语料**运行。

CI：`.github/workflows/checks.yml` 只做一件事——装 Node 依赖 + chromium，然后跑 `bench/smoke.sh`。
保持 `bench/smoke.sh` 是"绿色"的唯一定义。

Playwright 需要浏览器：`src/browser-env.ts` 按平台解析 chromium（Playwright 管理的版本，或 `PLAYWRIGHT_BROWSERS_PATH`
下已安装的 `chromium-*`），MV3 扩展必须走 `launchPersistentContext`。Mock 页面在 `testpages/`，bench 夹具在 `bench/fixtures/`。

LLM planner/auditor 在 `OPENAI_BASE_URL` + `OPENAI_API_KEY`（可加 `PLANNER_MODEL` / `AUDIT_MODEL`）齐备时自动启用；
否则用 `MockAuditor` / `ScriptedPlanner`，全流程照常运行。模型运行时（ONNX）缺产物时，所有离线测试用
`installLayaRuntime(scriptedRuntime(...))` 注入脚本模型，**不会**去碰 1.7GB 的权重。

## Architecture

**Python 参考 → TS 模块对照**（实现已全部迁移；Python 侧已移除，对拍改为对冻结语料）：

| Python（备份中） | TypeScript |
|---|---|
| `layaapp/planner.py` | `src/plan.ts`（TaskPlan/PlanningRules）+ `src/planner.ts`（runPlan/LLMPlanner） |
| `layaapp/executor.py` | `src/executor.ts`（BrowserMiddleware，唯一执行器循环） |
| `layaapp/extraction.py` / `rules.py` / `signals.py` / `audit.py` / `picker.py` | `src/extraction.ts` / `src/rules.ts` / `src/signals.ts` / `src/audit.ts` / `src/picker.ts` |
| `layaapp/__init__.py` | `src/index.ts` |
| `browser_env.py` | `src/browser-env.ts` |
| `bench/run_bench.py` | `src/bench.ts`（BenchMiddleware 子类化生产循环） |
| `browser_picker_playwright.py` / `picker_server.py` | `src/path-a.ts` / `src/picker-server.ts` |
| `datasource.py` / `ctrip/*.py` / `transfer/*.py` / `qunar/*.py` | `src/datasource.ts` / `src/ctrip-*.ts`·`h5-flights`·`live-*` / `src/transfer-*.ts`·`flow`·`ota-probe`·`profiles` / `src/qunar-*.ts` |

Layered, one direction of dependency:

```
layaapp/planner.py PlanningRules (validate LLM output AND manual edits), TaskPlan (JSON
                  checkpoint + resume semantics, preserves target_hint), run_plan
                  (wraps the whole plan in ONE browser_session: subgoals share the
                  page/playwright, cookies and JS state survive)
        ↓
layaapp/executor.py BrowserMiddleware: THE executor loop (single implementation). Per step:
                  discover interactive elements (no per-site selectors) → deterministic
                  rule / plan-named target_hint → else laya pick → confidence floor →
                  risk gate → actionability probe → execute → inert snapshot → DOM
                  done-signal check. Pluggable auditor via auditor.py.
                  bench/run_bench.py's BenchMiddleware SUBCLASSES this loop and only
                  chooses the checkpoint / flips ablation switches — do not fork it again.
        ↓
layaapp/picker.py QuickActionPicker: fixed-action-set picker + guards (injection noul,
                  irreversible noul, confidence gate). Used by Path A/B
        ↓
laya (pip)        Agent.predict(...) choice/score/noul · Router.route/predict for the
                  checkpoint choice (english vs multilingual)
```

**Application layer**: drivers import `from layaapp import ...` (the surface above). The top-level
`browser_agent.py` / `task_planner.py` / `browser_picker.py` / `auditor.py` are compatibility shims
re-exporting the package; `layaapp/extraction.py` (page view) and `layaapp/rules.py` (literal
mappings) sit under the executor.

Separate entry points that reuse the core: `browser_picker_playwright.py` (Path A: Playwright automation, exports `PAGES` and `extract_state` reused elsewhere), `picker_server.py` + `extension/` (Path B: FastAPI + MV3 extension; `test_extension_load.py` drives the extension via the `laya-trigger` DOM-event hook in content.js because Playwright cannot evaluate inside an MV3 service worker on this chromium), `plan_cli.py` (plan CRUD + run), `camera_entry.py` (two-form entry; the sheet's 类型 column picks the page via `TYPE_TO_FORM`, blank/unknown 类型 falls through to `laya.Router` + the routing question, values filled verbatim from Excel; `CAMERA_ROUTE=type|model` switches the precedence), `ctrip/` (the 携程 test case: replica site + 19-subgoal frozen plan + independent oracle -- read `ctrip/CTRIP_TESTCASE_REPORT.md`), `transfer/` (the same flow as a JSON spec, replayed on a deliberately different replica; read `transfer/TRANSFER_REPORT.md`).

## Rules the code encodes (measured, not stylistic)

These are empirical findings from this codebase's own experiments — preserve them when refactoring:

- **Navigation on real sites waits for `domcontentloaded`, never the default `load`.** Production pages keep fetching images/trackers: on zh.wikipedia `load` blew the 30 s budget outright. `goto_timeout` is configurable.
- **The signal language is `url_contains` / `css_exists` / `css_text_equals` / `css_text_contains` / `css_value_equals`.** Prefer `css_text_contains` on real pages: zh.wikipedia's article `<h1>` reads "艾伦·图灵编辑" (the edit link sits inside the heading), so exact equality can never fire.
- **DOM signals are the only completion truth.** laya's noul "done" judgment false-positives on unchanged pages; it is logged as advisory and never grants `done` (see the `is_done` comment in browser_agent.py).
- **Risk = deterministic keyword rules OR model vote ≥ 0.6.** The base checkpoint's risk head flips with goal phrasing (a real checkout click scored 0.18 under a "navigate" goal; cart navigation scored 0.81 under "open cart page"). `DESTRUCTIVE_PATTERNS` catches the high-stakes verbs; the gate asks for confirmation rather than blocking.
- **Literal mappings go to rules, semantics to laya.** `_nav_rule` (href match, gated on navigation verbs) and `_affordance_rule` (unique data-test/label token match) run before laya. Both need their guards: "shopping cart" must not href-match cart.html; ambiguity falls through to laya.
- **Two implementations of the hint grammar must stay in sync.** POOL-side, the 6 forms are now SINGLE-SOURCED in `rules.hintMatchImpl` (P1): `hintMatch` (collapsing view) and `hintCandidates` (tiered set) are two eyes of one walk, `hintMatch ≡ firstIfSame(hintCandidates)` pinned by 20 differential cases (`tests/rules-tiered.test.ts`). The DOM-side half (`hint_lookup`) still re-queries live pages for targets the MAX_ELEMENTS budget evicted — it must be changed IN PAIRS with the parser (it drifted twice: `#id` added to one side only; `=` missed case-folding — the next bullet). `hint_lookup` also **stamps** its matches (`data-hintref`) in the same pass that matches them: re-resolving scan indices against a later `page.locator(...).all()` returned a *different* element on python.org because the DOM mutated in between. Multi-word labels additionally need real `\s` escapes inside the raw JS string. For the 2026-10 execution-layer hardening (single forbid egress, structured `stop_code`, secret masking, the `hosts` navigation envelope, config-error preflight, `$AMBERFLOW_HOME/apps`, the gated `tieredHint` narrower ask) see the section at the end of this file + ARCHITECTURE.md §四.11.
- **Hint attribute values are case-FOLDED, not `==`.** The `=` branch lower-cases the hint on entry, so comparing it against the raw attribute silently missed upper-case ids (`data-test="net-CAM-1001"`, the normal shape for device ids) and the plan-named target fell back to laya (~0.03 conf, whole batch BLOCKED). `~` and `#id` already case-folded; `=` was the odd one out -- the same two-implementation drift as before. Pinned by a unit test.
- **Language routing is opt-in AT THE EXECUTOR.** `BrowserMiddleware(route_models=True)` (bench: `model="router"` / `--force-model router`) asks `laya.Router` which checkpoint suits each page's state -- script detection is the primary signal -- so a plan needs no hand-written `model` field. Two details are load-bearing: the default checkpoint built in `__init__` is **attached** to the router (`Router.attach`), never duplicated; and on a swap the executor must drop **its own** reference and `gc.collect()` BEFORE `Router.load`, because the old Agent (~0.7-1.7 GB) would otherwise stay alive while the new one is built -- that co-residency window is what OOMs a 3 GB box. Any router failure degrades to the resident agent. Measured: router mode holds **9/9 cases, 25/25 subgoals**, and the CJK cases log `checkpoint -> multilingual`; but the run took **410.9 s vs 58.1 s** fixed-english, i.e. routing buys language coverage, not speed (checkpoint reload per language switch, `max_loaded=1` on this box).
- **Indistinguishable duplicate targets are decidable.** `_first_if_same()` takes the first match in scan order when every hit shares (tag,label,href,data-test) -- bbc.com ships two identical `/news` links -- and still returns None for genuinely different candidates.
- **The planner must see the page, or it cannot write a hint.** `LLMPlanner.build_messages` embeds `snapshot_text(elems)` -- a rendering that REUSES `criteria_view`, i.e. exactly the element space the executor will see -- and `SYSTEM`/`PlanningRules.prompt_text()` ask for `target_hint`. `plan_cli new --llm --url <page>` takes the snapshot with Playwright first. Passing a different rendering would produce hints that can never match extraction.
- **Replan is wired, not a stub.** `run_plan(..., planner=..., max_replans=2)`: a blocked subgoal keeps its obstacle for the record, the amended subgoals are appended as pending, an amendment that adds nothing ends the loop (a planner echoing its input can never spin), and a replan EXCEPTION is always printed -- a swallowed planner error is indistinguishable from "nothing to add". `plan_cli run --replan` turns it on.
- **The data bag belongs to the plan (`TaskPlan.slots`).** Values must not be smuggled through goal text: `extract_slots("shop: coupon=SAVE10")` reads key `shop`. `run_plan` merges `{**extract_slots(goal), **plan.slots}`.
- **A frozen plan may NAME its target (`target_hint`).** The planner sees the DOM snapshot, so a one-line hint (`input[type=submit]`, `button[near~onesie]`, `data-test=coupon`) resolves the pick by rule at zero model cost; when a hint exists it is authoritative even if it matches nothing (the caller then falls through to laya rather than gambling on a token). `TaskPlan` must preserve the field through every disk round-trip, `plan_cli add/edit --hint` authors it, and `hint_lookup()` re-retrieves a plan-named element that MAX_ELEMENTS evicted — the model-view budget must never eat the element the plan already named.
- **Extraction is ONE JS pass, over the main frame AND same-origin child frames, with a shadow-aware collector.** `extract_elements` returns tag/label/attrs/visibility/main-flag/order in a single `page.evaluate` per frame and stamps the winners with `data-dshref` in that same pass; the per-element path survives only as a fallback. Measured on en.wikipedia (677 matches): 4.5-5.2 s per step -> 0.02 s. `_COLLECT_JS` descends into open shadow roots because `document.querySelectorAll` does not pierce them while Playwright's CSS engine does -- the mismatch is why the JS-side passes saw 0 elements on shadow apps.
- **Frames are first-class.** Child-frame elements are namespaced (`f1:e3`) and carry `frame`; every `_locator_for` lookup -- and everything that resolves a signal (`locator_any_frame`) -- is scoped to that frame, because `page.locator` only ever searches the main frame. `snapshot()` includes frame text/values so inert detection still works when the action happened inside an iframe. Frame count is capped (6) so ad iframes cannot eat the MAX_ELEMENTS budget. Covered offline by `frames-entry-zh` (a form inside an iframe).
- **Executor robustness lives in the one production loop.** `BrowserMiddleware.run` is the only executor; `BenchMiddleware` subclasses it and only picks the checkpoint / flips ablation switches. Forbiddances are keyed by element *signature* (refs are positional and re-indexed on every scan), clicks are actionability-probed before execution, overlay-blocked refs are re-admitted once the page changes, an action that leaves url+text+input-values identical is `inert` and forbidden, submit-type inputs are clicked never filled, and empty fields the plan can supply are pre-filled before any click. Never fork this loop.
- **Feed laya only the current subgoal**, never the whole long goal — long goal text halves pick confidence (0.42 → 0.16 measured).
- **State text is compressed by keyword overlap** (`state_text`), not embeddings: the laya encoder is domain-tuned and fails as a general text-similarity ranker. `build_sequence` keeps the head of the state and truncates the tail at max_len=512; content beyond ~720 chars is invisible, so `page_text` ships first 300 + last 150 chars. CJK costs ~1 token/char — for Chinese content use `laya.load(..., subfolder="multilingual")` (max_len 1024).
- **Checkpoint routing is script-based, never confidence-based.** `laya.Router` routes on the detected script because the English checkpoint *collapses* off-English (0.100 on Hindi vs 0.050 for random guessing) while still reporting high confidence (ECE 0.855). Size the cache from real RAM (`camera_entry.max_loaded()` probes `os.sysconf`, ≥4 GB → 2, else 1) and free the resident checkpoint before a language switch: `Router.load` builds the new Agent *before* evicting the victim, so both are briefly resident. Beware that a row mixing ASCII identifiers with CJK prose is detected as Latin (camera_entry rows 0/2/3: non_latin 0.33–0.40) — routing on the raw record is what keeps those rows correct, and forcing multilingual on them is measurably worse (2/4).
- **English checkpoint on CJK-heavy states yields very low confidence** (0.03–0.09; argmax still often correct) — that is expected, not a bug: routing is the fix (see the Router bullet above), not a confidence floor. The old `ROUTE_CONF_FLOOR` fallback is gone; instead the 类型 column is a FIRST-CLASS rule (`TYPE_TO_FORM`, camera_entry) that decides the page whenever it is recognised, with the model answer kept as a logged audit for disagreement.
- **The injection guard on the base checkpoint is both over-sensitive on benign DOM text and phrase-dependent on real attacks** (benign shop pages score 0.79–0.90; weak-worded attacks score ~0.2). Threshold 0.95 is the measured split in `QuickActionPicker`; see `tune_guard.py`.
- `predict_shortlist` passes through unchanged when labels ≤ k (then `scores` is None); it is only active above ~8 labels.
- **Fetching a site is CONFIG, not a script -- and "the engine knows no site" is a unit test.** `datasource.ts` is a
  generic engine: transports (`curl` subprocess / `httpx` global fetch / `cli` arbitrary command), four extractors
  (`json_in_script` / `html_regex` / `json_stdout` / `lines_regex`), a deliberately tiny path
  language (`a.b`, `[0]`, `[-1]`, `[]` = map, ops `time|join:x|len|len-1|int|str|strip`), config-driven counts/selects/
  audits, and a config-driven report. Everything site-specific lives in `<site>/sources/*.json`: URL template, how the
  date parameters are computed, the row path, each field's path+ops, the time window, the selection rules, the report
  columns and notes. `test_the_engine_knows_no_site` strips the engine's DOCSTRINGS and then greps the remaining code
  for `ctrip.com` / `__INITIAL_STATE__` / `flightItem` / `price-line` / `kmg` / `08:00` / `¥` -- and it caught three
  real leaks on first run (a Ctrip default for `extract.var`, a hard-coded `¥` in the report, another in the print
  path). The second source is the proof: `ctrip-hotels-pc` uses the SAME engine with zero code change by switching to
  `kind: html_regex`, `checkin/checkout` date params and an `audits` entry that measures "price node empty 5/5".
  `validate_source` runs at load time (unknown extractor/op/client, wrong capture-group count, unknown date expression,
  unknown `default_dates` expression, non-list `block_markers`, unknown `transport.cli` key) so a bad config fails loudly
  instead of silently extracting wrong data. Source lookup is DISCOVERY, not a directory list: every `*/sources` and
  `apps/*/sources` dir under the repo is a config dir (`--sources-dir` overrides; the engine file contains no site names
  at code level, and a test greps for concrete tool names too). `default_dates: "next_week"` is an
  ENGINE-level date expression (`datasource.next_week_dates` — pure calendar math; `ctrip-data.ts` re-exports it, so the
  dependency points site → engine), and bot-block body signatures are CONFIG too (`transport.block_markers`, e.g.
  `["whaleguard"]`) — the engine itself only treats non-200 as blocked. Report output follows the source:
  `<sources dir>/../results` unless `--out`.
- **A CLI tool is a TRANSPORT, not a new application -- and it must never see a shell.** `transport.client: "cli"` runs
  `transport.cli.bin` with an **argv array** (`spawnSync`, `shell: false`): templates (`{url}` + `constants`) are
  substituted per argument, so `;`, `$(...)`, backticks and `|` arrive as plain characters — `tests/cli-transport.test.ts`
  literally fires those at a temp file and asserts it was never created. The config surface is six keys
  (`bin / argv / env_allow / cwd / exit_ok / stdin`), unknown keys fail at load; `env_allow` is a whitelist with `PATH`
  always kept (otherwise the binary cannot be found), and credentials are referenced by NAME from the environment —
  never written into the audited plan. Exit codes map onto the engine's status code (`exit_ok`, default `[0]` → 200,
  anything else passes through so `blocked()` and the report say "命令退出码 N"), which means audits/counts/selects/report
  needed **no change at all**. Two output shapes have their own extractors: `lines_regex` (line-oriented text — kept
  separate because `html_regex` drops the first block, an HTML-header convention that would silently eat line 1) and
  `json_stdout` (the whole stdout is one JSON document). **Tool versions drift like the wall clock does**, so
  `transport.version_pin` + `version_argv` must match or the source throws (`ValueError`), and the observed version goes
  into the result and the report. Verified across four tool types: synthetic stub (`apps/demo-tool`, CI-safe), line text
  (git), JSON (`jq`), and the pre-existing curl/httpx HTTP clients whose 163-item parity corpus is untouched except the
  two "unknown value" messages. Adding an app = a directory under `apps/` (see `apps/README.md`), never a new branch in
  the engine.
- **An application is a DIRECTORY, not a driver -- and its cost is a measured number.** `apps/<id>/pack.json` declares
  the app: `roles` (reusable step templates: desc/signal/hint/slots/when/retries), `journey` (which roles, in what
  order — inline steps merge over the template), `slots` + `required_slots` (the data bag; values still only ever come
  from the plan), `sources` (its data leg — the same datasource engine, HTTP or CLI channel), `invariants` (assertions on
  the END state) and `hosts` (documentation + the leak check's input). Discovery is `apps/<id>/pack.json`, load-time
  validation reuses `PlanningRules.problems` (one grammar, not a second one), `{slot}` placeholders substitute ONLY
  declared slots (tool args and JSON payloads are full of braces; an unknown placeholder fails at load), and relative
  `start_url`s resolve to `file://` from the repo root. `src/app-runner.ts` runs the whole chain in one command
  (`npm run apps -- --app demo-app`): data leg → journey → invariants → report. The journey is a **mixed step list**
  (browser steps and tool steps, in order): a browser step goes through `runSubgoalWithRetries` — the executor loop is
  still `BrowserMiddleware.run`, and the runner owns the session (created lazily at the FIRST browser step, `close()`
  deferred) so the invariants are evaluated on the journey's real end state, cookies included. It no longer hands the
  whole journey to `runPlan` because that entry only understands DOM steps. Invariants cannot see INTERMEDIATE
  requirements (that is what subgoal signals are for) and need at least one browser step (validated) — recorded in the
  pack's own notes rather than pretended away. The cost is checkable:
  `npm run apps:matrix` prints per app the declared lines, roles/browser steps/tool steps/invariants, the **code lines
  inside app dirs (currently 0 — apps are data)** and a leak check that fails if any app-declared host or CLI tool name
  appears in the CORE shared modules (word-boundary match after stripping block comments; `git` must not match `digit`).
  Site knowledge in per-site drivers is reported as DEBT, never as an exemption; the probe family has since been
  migrated into `apps/<id>/pack.json` probe sets, so that number is now 0 and those drivers joined the CORE list.
  Two roles keep this honest (`apps/INVENTORY.md`): an **author** writes the packs, an **independent verifier** reproduces
  every claim from commands and raw output (never from narration), tries to FALSIFY invariants on temp copies, and files
  defects with a minimal repro. Its first pass found 11 problems, 6 of which are fixed: role inline-overrides silently
  dropping cross-kind keys, `hosts: []` opening a hole in the probe host check, a bare-string `hosts` making the leak gate
  tokenise per CHARACTER, a probe-only app "passing 0/0" through the app runner, an invalid pack crashing the CLI with a
  stack, and a missing CLI binary throwing instead of becoming `refused: "tool-unavailable"`. The remaining five
  (duplicate ids across target lists, non-string ids silently `String()`-ed, a browser step without `start_url`, unchecked
  `max_subgoals`/`slots`/`sources` types, persisted retry counters) are recorded in `apps/INVENTORY.md` §四 for the next
  round — reported, not pretended. Round 2 fixed five more of them, each with a regression test: ids that are one
  namespace ACROSS the probe target lists, a non-string target id (silently `String()`-ed), a browser step without
  `start_url` (the executor re-navigates every subgoal), type checks for `max_subgoals`/`slots`/`required_slots`/
  `sources`/`model` (a bare string used to produce a string of character-by-character "unknown source" pseudo-errors
  ON TOP of the real one), and `{run_id}` — a per-run placeholder, because a retry counter written into the shared
  `{out_dir}` makes the SECOND run of the same command behave differently (measured: `cli-report`'s flaky step went
  from `attempts=3` to `attempts=1`; with `{run_id}` it is 3 every time). Round 3 added one more, found by the AUTHOR this
  time: `PlanningRules.problems` validated every subgoal `signal` recursively but never its `when` — the same
  `signals.ts` answers both questions, so the guard went unchecked until the run, where a bad op surfaced as
  `stop_reason: "error: … unknown signal spec"` and a BLOCKED subgoal (loud, but a round too late). `when` now goes
  through the same walker (nested combinators and an empty `when` included). One boundary the tests state out loud:
  a green run is not automatically a model-free run — `transfer-slowjet` asks laya once per cold load and passes only
  because `retries` re-runs the subgoal, so its test asserts `act` was asked AND `attempts>1`; symmetrically,
  `transfer-farehaven`'s `when` guards are discriminatingly verified only because DELETING them (temp copy) turns the
  run red (exit 1, exactly those 4 subgoals blocked).
- **A site that exists ONLY as a mobile page needs a declared DEVICE, or the plan silently cannot work.** Adding the
  last application (`apps/qunar-live`, the live `touch.qunar.com` H5 journey) exposed a schema gap rather than a site
  change: the same frozen plan failed 3/3 on desktop with `low confidence 0.15 < floor 0.25`, because the mobile DOM
  has the city chip the plan names (`div "北京"`) and the desktop DOM does not — the hint can never match, and laya on a
  Chinese page is at ~0.15 anyway. The fix is data, not code: a pack may declare `device`
  (`user_agent` / `viewport` / `is_mobile` / `has_touch` / `locale` / `timezone` / `device_scale_factor`, unknown keys
  fail at load), and `browserSession(headless, device)` opens a context with exactly those options — packs without a
  `device` keep the old `browser.newPage()` path so no existing app's output changes. Measured after the declaration:
  **2/2 subgoals, both `rule:match`, 46.5 s** (`click div "北京" (clicked, rule:match, conf=1.00)`). Evidence:
  `bench/live-retest/qunar-live-app-run.md`. The lesson generalises: when a "blocked" live app is reproducible as a
  hint that matches nothing, ask what the app was never allowed to declare.
- **A tool step is an ACTION LEG, and the three disciplines are what make it safe.** A journey entry with a `source` is a
  tool step: it reuses the CLI transport (argv array, env allowlist, cwd, exit codes, version pin) and adds `args` /
  `dry_run_args` / `idempotent` / `dangerous`. Its completion truth is the **process observation** — `src/tool-signals.ts`
  grows the same shape as the DOM language on that surface (`exit_ok`, `exit_code_equals`, `stdout_contains`,
  `stdout_matches`, `stderr_contains`, `json_path_equals` via the datasource path language, `file_exists`, `file_absent`,
  plus recursive `all_of`/`any_of`/`not`), validated at load exactly like the DOM one. Because re-running a CLI command
  is not like re-clicking a link: (1) `retries > 0` REQUIRES `idempotent: true`; (2) `dangerous: true` REQUIRES
  `dry_run_args`, and a failed dry run never applies; (3) a dangerous step is REFUSED unless `--allow-dangerous` (or an
  injected `confirmToolStep`) approves it after seeing the dry-run evidence — the refusal is reported as
  `refused: dangerous|declined|dry-run-failed`, never silently skipped, and a refused step leaves no artifact behind
  (pinned by `tests/apps.test.ts`, which also checks the flaky-tool retry really took 3 attempts and that the file only
  appears after confirmation). `{out_dir}` is a RUNTIME placeholder (this run's `--out`), not a plan value: artifacts go
  to a run directory so the pack stays machine-independent. Verified on two tool types: the deterministic stub
  (`apps/cli-report`, CI-safe) and real tools (`apps/repo-report`: git line text + jq JSON).
- **A probe is DATA too -- and the debt meter must not need a declaration to see it.** The last site knowledge in
  shared code lived in the probe/task drivers (`live-probe` / `live-capture` / `ota-probe` / `qunar-probe` /
  `qunar-task`): URL tables, gate/login markers, result dirs, even the frozen plan of the qunar task. It now lives in
  `apps/<id>/pack.json` under a `probe` block (`date`, `results_dir`, `home`/`http`/`alts`/`mobile`/`capture`
  targets with `{date}`-family placeholders, `browser` re-verification ids, `repeat{id,times}`, `roles` = which
  declared target a verdict should read, `markers` = the observed strings/regexes, `login` = redirect hosts/paths/
  titles). Three load-time rules keep the declaration honest: **every URL's host must be in `hosts`** (otherwise the
  leak gate silently misses that host), only the four date placeholders are legal (pure calendar math, `{checkout}` =
  +1 day, `{date_slash}`), and `browser`/`repeat`/`roles` may only reference declared http target ids. The drivers now
  contain **zero** site identifiers, so all five joined the CORE list -- re-hardcoding a host there fails
  `apps:matrix` instead of quietly adding debt. Two details worth keeping: the verdict/reason strings must stay
  byte-identical to the committed corpus, so the display handle (`short`, e.g. `flights.ctrip.com` or the brand
  `Trip.com`) is DECLARED per target and interpolated -- and `gate_text` stays separate from `block_text` because
  merging them would silently change the meaning of the already-committed `whaleguard` measurement field. Finally,
  the debt meter no longer depends on apps having declared a token first: it ALSO scans non-CORE shared files for
  hard-coded `http(s)://host` literals (`localhost`/`example.com` excluded), so knowledge hidden in a driver shows up
  as debt the moment it is written. Measured: 3 debt entries before -> **0** after, with the probe packs declaring 20
  hosts, 9 apps / 917 declared lines and still 0 code lines inside app dirs.
- **Ctrip serves its H5 ROUTE pages server-side, and WhaleGuard's gate is a CLIENT fingerprint check.** `m.ctrip.com/
  html5/flight/<dcity>-<acity>-day-<N>.html` (N = target date minus today) returns 200 to `curl` -- with its default UA
  or an iPhone Safari UA -- and 432 to `curl` + a Chrome UA, to Python `httpx`, to Chromium and to Playwright's
  `context.request`. The page carries `window.__INITIAL_STATE__.listData.flights`: the complete itinerary list for that
  date (flight no, times, airline, airports, stops, price, cabin, discount; 90-98 rows for KMG-BJS). So real Ctrip fare
  data IS reachable from this box -- through the HTTP door, not through a browser. The hotel half has no such door:
  anonymous hotel responses carry names/stars/scores with EMPTY price nodes (the UI says \u201c登录以查看会员价\u201d).
  `ctrip/h5_flights.py` implements it (curl-only transport, pure parser, offline fixture + tests) and `--render` proves
  the executor can extract elements from the real DOM (29 interactive elements) when the fetched HTML is rendered.
- **A verdict must be measured, not assumed -- the live-capture tool got this wrong first.** `ctrip/live_capture.py`
  reports one of four verdicts per target (`captured` / `blocked` / `login_required` / `unreachable`); its first version
  counted a page that had been REDIRECTED to `passport.ctrip.com/user/login` as "captured" (40 elements of a login form).
  Distinguishing "the page opened" from "the page I asked for opened" is the same failure mode as counting a
  `whaleguard` body as content. Measured here: flights 432, hotels -> login redirect, so `captured 0/2`.
- **The flow is DATA (`transfer/specs/*.json`), not Python -- including its SHAPE.** A spec is a LIST of phases
  (`{phase, stage, repeat, steps}`) expanded in order, where `repeat` is one of `once` / `per_date` / `per_checkin` and
  `stage` says whether the phase runs before the departure date is known (flight) or after it (hotel). Opening a second
  `per_date` phase IS a two-page search wizard -- the loader has no idea what a wizard is (the fifth replica was added
  that way). The rest of a spec holds the description templates, the per-step triple (hint(s) / signal / URL template),
  the data bag, the ledger expression and the site directory; `layaapp`'s
  `SIGNAL_OPS` validates the signals at load time and unknown placeholders raise instead of silently producing a wrong plan.
  Proven, not asserted: `transfer/specs/ctrip.json` expands to the SAME 19 subgoals, field for field, as the hand-written
  `ctrip/ctrip_task.py` plan (`transfer/test_transfer.py`). Adding a similarly laid out site = one spec + one data generator,
  zero flow code -- and that is how the third and fourth replicas were added (`specs/trekly.json`: English table layout, a
  range-slider price cap, one click records every row; `specs/flyquest.json`: the results page is only reachable by
  SUBMITTING a search form; `specs/voyagio.json` / `specs/farehaven.json` / `specs/slowjet.json` add a search wizard, a
  conditional overlay and a retrying cold-load step). Seven sites now run the same 18 shared roles to 7/7 on their own
  oracle, each on its own inventory -- the fifth changes the SKELETON SHAPE, the sixth skips four subgoals at runtime,
  the seventh retries five, and the metric reports all of that (extra roles / skipped / retried) instead of pretending
  the plans line up. What deliberately stays in Python: the site's inventory generator and the independent judge -- a judge
  written in the same config as the flow would stop being independent.
- **A subgoal may RETRY (`retries`), and a retry is the WHOLE subgoal.** Transient failures (a cold first load, a
  hydration race, a page left half-navigated by the previous action) are the most common reason a real plan stops, and
  the old vocabulary had only "succeeded" or "BLOCKED". `retries: N` re-runs the step N extra times, each a fresh
  navigation with `when` re-evaluated and the element pool re-scanned; only after that does the subgoal block (and only
  then does replan get its turn). Bounded by the plan, never a runtime invention. Measured on the seventh replica, whose
  booking-summary page is cold on its first hit per date: 7/7 with 5 retried subgoals in 19 steps, versus 0/7 with
  `--no-retries` blocking on the first cold page (0.16 < 0.25). Note what it does NOT change: the plan's shape, so the
  migration metrics look identical to the baseline -- `retries` is runtime policy, not structure.
- **A subgoal may be CONDITIONAL (`when`) -- and that is the honest answer to "no branching".** The guard is a signal
  evaluated on the page AFTER the navigation and BEFORE any action; when it does not hold the subgoal is SKIPPED (no
  action, no model call, `status=skipped`, resume does not retry it). This is the shape of the most common real
  interruption -- a consent/promo overlay that exists on some page loads and not others. Measured on the sixth replica:
  the overlay is there on the three promo dates and gone afterwards, so the dismiss step must run once and skip four
  times (24 subgoals -> 20 steps, 4 skipped, 7/7); stripping the guards (`--no-when`) blocks at the first page WITHOUT
  the overlay (hint resolves to nothing -> laya picks a nav link -> the signal can never fire -> 1/7). What is still not
  expressible: backtracking, multi-branch choices, conditional jumps inside a repetition.
- **The signal language lives in `layaapp/signals.py`, below both planner and executor.** `check_signal` answers two
  questions with the same five operators -- "is this subgoal DONE?" (completion) and "does this subgoal APPLY?"
  (the `when` guard). planner imports executor, so putting the implementation in either would force a second copy;
  the hint grammar already drifted once that way, so the signal language gets its own module instead.
- **A subgoal may name SEVERAL targets, in order (`target_hints`).** Real travel sites hide their results behind a
  search FORM: fill the date, choose the window, press Search. With one `target_hint` the hint stays authoritative after
  the fill, so the same element is re-picked (inert -> forbidden) and the subgoal stalls -- measured on the fourth
  replica, whose fares page is unreachable without submitting. `target_hints` walks an ordered list, advancing once each
  action has executed (or its element has been forbidden); a single `target_hint` keeps its old whole-subgoal authority,
  which every pre-existing plan depends on (`test_a_single_hint_still_owns_the_whole_subgoal` pins exactly that).
  The same subgoal can also carry its own `slots` (a date to type into the form), merged over `plan.slots`, so a
  per-step value stays a plan datum instead of prose. Measured: that replica runs 19 subgoals in 30 steps, all rule hits.
- **The executor's action model needed a THIRD case: radio/checkbox.** It used to decide "type into input/textarea/select,
  click everything else", so a radio-group price filter took the fill path, returned `needs_value`, was forbidden and burned
  the subgoal -- unreachable (filling one is not a fix either: Playwright rejects it). Found by the transfer replica, where
  filters are radios rather than link chips; `_is_typing` / `_is_checkable` now classify all three cases in one place.
  Pinned by unit tests, including the nasty shape `<input type=radio id="cap-300">` with `slots={"cap": ...}`, where
  `_slot_value`'s substring match would have handed a value to a radio.
- **`<input type=range>` needs no new action: `locator.fill()` sets the value and fires `input`.** Measured on the third
  replica, whose price cap is a slider (a slot supplies "300", the fill path runs, `oninput` navigates, the result list
  narrows 32 -> 12). So the executor's action model covers link / button / input / textarea / select / radio / checkbox /
  range; the untested shapes left are uploads, rich text, `<dialog>` and anything inside a cross-origin frame.
- **`<select>` fills must not pay Playwright's 30 s default on the label probe.** A slot normally carries the machine value
  ("0800-1800"), so `select_option(label=...)` is expected to miss before the `value=` fallback runs -- with the default
  timeout that miss was charged to every select fill (measured on the transfer replica: ~300 s across ten fills, ~0 s after
  the probe got `timeout=1500`).
- **A frozen plan over a list page needs the filter/sort state IN THE URL.** `run()` re-`goto`s every subgoal, and `target_hint` is
  authoritative *within* one subgoal -- so a hint on the "filter" link gets re-clicked on step 2 (inert -> forbidden -> the subgoal
  derails) and state kept in page JS is lost between subgoals anyway. The ctrip replica encodes window/sort/cap in the query string
  (real list pages do too), which makes "one subgoal = one click = one deterministic state": 19 subgoals, 19 clicks, 7/7 oracle checks
  (`ctrip/ctrip_task.py`). A subgoal that genuinely needs several actions says so explicitly (`target_hints` + its own
  `slots`), one that may not apply at all says so with `when` ("dismiss the overlay IF it is there") -- skipped, not
  failed -- and one that failed this once says `retries` and is re-run whole. What remains inexpressible is a branch
  INSIDE a subgoal, jumping BACK to an earlier subgoal, and multi-way choices (ARCHITECTURE.md §七 第 3 条).
- **On Chinese pages the plan's `target_hint` is load-bearing, not decoration.** The ctrip case resolves 19/19 steps by rule with
  hints (zero model calls); stripping them blocks subgoal 1 outright -- confidence **0.13** on the zh homepage, and **0.24** after
  `laya.Router` correctly routes to `multilingual` (Han = 61% of letters). Routing doubles it and still misses the 0.25 floor.
  Measured: `src/ctrip-task.ts --no-hints [--route]` -> 0/7 both ways. Do not read this as "rules beat the model":
  it says the model's zero-shot ceiling on CJK list pages is below this flow's floor.
- **A hint is TIERED, and a live list page is why.** `~` hints used to be "substring matches,
  and only usable when every hit is identical"; on real pages that is always ambiguous —
  `a[href~Alan_Turing]` matched **17** links on the live en.wikipedia search results
  (Alan_Turing, _law, _Institute, Legacy_of_Alan_Turing, ...), the ambiguity check gave up, and the
  step fell to laya at **0.23 < 0.25 → BLOCKED**. Similarly a bare token: the zh results page has the
  canonical link labelled exactly `艾伦·图灵` plus ~100 language-sidebar links that merely CONTAIN it
  (`艾伦·图灵 – 古吉拉特语`, where the token is even its own word) → the pick was a 0.29 coin flip. Now:
  `attr~v` prefers **exact attribute → whole last path segment → old all-substring behaviour**;
  a bare token prefers **whole label → whole word → word prefix → word substring**. Genuine ambiguity
  inside the winning tier still returns None (the bbc two-`/news`-links rule is unchanged). Measured
  after: the live pack went **6/8 cases / 8/9 subgoals → 8/8 / 11/11, every step `rule:match`, zero
  model picks**. Pinned by unit tests + 6 new frozen parity cases.
- **A plan hint outranks token matching — in the rule ORDER, not just in `affordance_rule`.** The loop
  used to run `nav_rule(...) or affordance_rule(...)` regardless of a hint, so with the plan's
  `#searchInput` absent (Wikipedia served an error shell) `nav_rule` token-matched **18 slot-less
  fields**, each forbidden and re-picked inside ONE step, then laya clicked junk → `max_steps` after 22
  steps. A hint is authoritative: when one exists only the hint may decide, and a miss falls through to
  **laya** (the documented "rather than gambling on a token"). Both implementations now do that.
- **Visibility needs a NON-ZERO BOX, and a failed action must be a RESULT, not an exception.** The zh
  wikipedia main page ships **349 interlanguage links** that pass `checkVisibility()` but measure 0×0 —
  Playwright refuses to click them, and letting one through made a click timeout **escape `run()`**
  (the whole case reported 0/0). Extraction now requires `rect.width > 0 && rect.height > 0` (aligned
  with what Playwright can actually act on) and `_click_only`/`_execute_element` catch action failures,
  return `action_failed`, and let the loop forbid the ref — nothing Playwright raises can kill a plan.
  The box test is **ANY non-empty rect, not `getClientRects()[0]`**: an inline anchor that wraps a block
  (`<a data-test="item-2-title-link"><div>Product title</div></a>`, the ordinary card-title markup) reports
  its 0×0 inline boxes FIRST and the real block box after them, so the `r[0]` form silently dropped all six
  product-title links on live saucedemo.com (pool 25/31) — the element a human clicks was invisible to both
  the model and hint matching. All-zero rects are still rejected. Pinned by `tests/extraction.test.ts`.
- **The live pack needs `retries`, and the HARNESS must honour it.** Real sites are cold on the first
  hit (en.wikipedia burned 9 steps into `max_steps` in one pack run while the same case passed in
  isolation). `bench/cases-live.json` sets `retries: 2` per subgoal and `run_case` goes through
  `run_subgoal_with_retries` — before that the case data's `retries` was **inert**, and case-level
  `slots` were silently dropped once the retry path was wired (the live pack caught that regression).
- **A completion signal is INDUCTED, or it is human-attested — never guessed.** Asking a human (or an LLM
  planner) to predict a real page's post-state is how both wikipedia live cases failed twice; so the flow can
  WATCH the transition instead: `tools/induce_signal.ts` demonstrates a step once and compiles a plan-ready
  predicate from the before/after pair. Accuracy comes from three gates, not from trust: the candidate must be
  **false before / true after** (discriminating), use a **stable handle** (`data-test`/`id`/`name`/`near`, never a
  positional path or a volatile literal — ids, dates, counts of 4+ digits, hashes), and **reproduce across
  `--replays` runs** before adoption. Measured on the repo's own fixture: the induced top candidate IS the
  hand-written `{"css_text_equals":["[data-test=cart-count]","1"]}`. Two design consequences the live pages
  forced: (1) the captured state must include **signal-bearing non-interactive nodes** (badges, counters, toasts)
  — the executor's pool holds only actionable elements, and the natural completion signal usually lives one node
  away (`captureStateView` adds a bounded witness pass); (2) when nothing discriminates, the honest answer is
  `{"signal":{"manual":true}}` + `manualConfirmFn`, which records the state the human was shown and reports
  `manual: true`, rather than a looser predicate.
- **Composition cannot weaken evidence.** `all_of` / `any_of` / `not` are validated recursively by
  `PlanningRules` and evaluated offline by `evalSignalOnState`; every leaf is still one of the five DOM
  operators, so `all_of` can only add discrimination and `any_of` only accepts alternatives a human verified.
  `not` is how a disappearing spinner is expressed without inventing a positive claim.

- **The pool is the model's whole world — so widen it before giving up.** browser-use names this the
  observation bottleneck ("the button is there, we just failed to show it"): a target that never entered
  the element pool cannot be chosen no matter how good the model is. The live-pack failures were exactly
  this (python.org's `#searchInput` evicted by the 40-element budget; the fixture's own `cart-count` badge
  outside the pool entirely). `RunOptions.reobserve` (default ON) takes ONE wider look (`WIDER_ELEMENTS=120`,
  via the now-parameterised `extractElements(page, jsProbe, maxElements)`) and re-asks before blocking;
  the pick is traced as `laya:reobserve`. A/B pinned in `tests/reobserve.test.ts`: with 60 decoy buttons
  ahead of the target, OFF blocks with `low confidence … < floor 0.25`, ON recovers and completes.
  Only the way to stopping pays for the extra scan.
- **A deterministic model should not be asked twice.** laya answers identically for identical
  (state, question, option set), yet retries, replans, resumes and ablation re-runs asked again every
  time. `withDecisionCache` memoises on an EXACT fingerprint (state + questions, sorted-key canonical
  JSON), is bounded, resettable, and can append one JSONL record per decision. Measured on the real
  model with the same plan run twice: 12 forwards / second run 9.2 s without it, 6 forwards total with
  it — **second run 0 forwards, 1.3 s**. Exact keys mean a changed page is a miss, never a stale hit.
- **模型出场有两个口径，缺一个都会漏报（P1 实测出来的）。** The executor writes `method` into the trace
  only for decisions that PASSED its gates; the ask that dies at `low confidence < floor` never reaches
  a trace line. So "how often did the model take part" cannot be counted from traces alone —
  `transfer-slowjet`'s cold load would report 0 model steps while it is precisely the run where the
  model is load-bearing (asked, below floor, saved by `retries`). Hence two counters, each in one place:
  **passes counted from traces** (`rule/laya/laya:reobserve/escalate` in `summarizeDecisions`) and
  **consultations counted at the runtime seam** (`countingRuntime` wraps `predictShortlist`, sees hits
  AND misses, never touches the executor loop). The gap between them is "asked but never trusted" —
  reported as its own number, not hidden. Model tier (`on` = 真模型，**默认**；`off(missing)` = 产物不齐、如实降级；`off(ablation:scripted-stub)`
与 `off(ablation:rules-only)` = **消融实验臂**，`--ablate` 显式才出现；旧的 `--no-model` 把桩标成
`off(rules-only)`，名实不符，已改名) is written by
  the engine into `<app>-result.json` (`model_status`), read by `apps:matrix`/`apps:suite`/the DSH bridge
  — one source (`src/model-artifacts.ts`), because doctor and the runtime once disagreed about what
  "artifacts complete" means (a box with graph+weights but no tokenizer read as "真模型" and failed later).
- **The model author's preset wording is not automatically better.** `laya.presets.guard_questions()`
  phrases prompt-injection as "instructions aimed at the AI system rather than a genuine user request";
  measured on the three fixtures it scores benign pages **0.969 / 0.930**, i.e. ABOVE the 0.95 attack
  threshold (`path-a.ts`) — it would flag a product page. Our hand-written phrasing gives 0.907 / 0.940
  with the injection page at 1.000 for all three. Presets are tuned for USER PROMPTS, not page text;
  the measured rule stays ours (see `docs/decision-model-survey.md`, variant C in `src/tune-guard.ts`).
- **C3-R's top-two margin does NOT transfer — measured, then rejected.** The same-base application
  (ColomboAI C3R) abstains on "low confidence OR small top-two margin". On our data (live pack with
  `--force-rules off`: 70 model picks → 39 good, 5 inert/坏, 26 abstained) the margin points the WRONG way:
  bad picks have a HIGHER median margin (0.348) than good ones (0.263), and the worst one scored 0.942.
  Every threshold that catches anything destroys far more good picks — t=0.10 catches 1/5 bad and loses
  7/39 good; t=0.15 catches 1/5 and loses 17/39. So a small margin here means "the model is torn", not
  "the model is about to be wrong": our wrong actions are CONFIDENT clicks on plausible-but-inert elements,
  which the confidence floor + inert detection + re-observe already handle. The margin stays a diagnostic
  (`trace.margin`), never a gate. (Same run quantifies the rule layer: 8/8 with rules, 4/8 without.)
  Also hardened here: an empty probability map used to make `Math.max()` return `-Infinity`.
- **Escalation is a PICKER, not a planner — and it must see the WIDER view.** C3-R's deliberative path is
  implemented as `RunOptions.escalateFn` / `llmEscalator()`: consulted once per step, only after the local
  model fell below the floor AND one wider look failed. It receives exactly the criteria view the harness
  renders and may only name one of those refs; a `null`, a non-candidate ref, or a throwing endpoint means
  ABSTAIN (fail closed, back to the previous blocking behaviour), so nothing it says can invent an element,
  a value or an action. Two implementation traps, both hit and fixed: (1) the escalator was originally handed
  the NARROW pool (40 candidates, target invisible) because the wider pool was only adopted when the local
  model recovered — widening now becomes the step's view unconditionally; (2) a confident local pick is never
  overridden (escalation is a fallback, not a second opinion). Pinned by `tests/escalate.test.ts`
  (recovers a blocked subgoal; rejects an invented ref; not consulted at high confidence; survives a throw).

- **Confidence is NOT a usable gate on real pages — measured on two labels, then rejected.** The same-base
  application (C3-R) demands "held-out, slice-specific calibration" before deciding; this repo had the model
  author's own metric ported (`eceScore`) but never applied it to decisions, so `tools/calibration.ts`
  (`npm run calibration`) now turns recorded traces into per-slice reliability tables on two labels — action
  level (executed & page changed) and task level (the subgoal completed). Measured over 80 model-driven steps
  from two `--force-rules off` runs (fixture matrix + the 8 live sites): english slice n=51, mean confidence
  0.498, action-level accuracy 0.922 with **ECE 0.441**, task-level completion only **0.314** with ECE 0.200.
  The reliability table is INVERTED — the 0.2-0.4 confidence band was effective 95.0% of the time, the
  0.8-1.0 band 88.9%. Direct A/B on the live pack, same cases: floor 0.25 → 4/8 cases / 6/11 subgoals;
  floor 0.10 → **4/8 / 6/11, unchanged**. So neither the floor nor a calibration gate is the lever here: the
  model is not asked to be accurate, it is asked less often (rules on = 8/8 vs rules off = 4/8). Gate rejected,
  instrument kept for re-measurement. Note the project ALREADY applies C3-R's spirit on the one slice where
  calibration is catastrophic — English-on-CJK (ECE 0.855) → route by SCRIPT, and make the 类型 column a
  first-class rule instead of trusting confidence.
- **Ablation knobs are part of the evidence, not a convenience.** `bench --force-rules on|off`,
  `--force-model`, and now `--force-conf-floor <n>` exist so a gate's *setting* is measurable on the same cases
  (the floor A/B above is what retired the calibration gate). Same for `npm run cache:measure`.

- **Decision memory has TWO halves: what was decided, and what HAPPENED.** `withDecisionCache` covers the
  first (round 1). `src/outcome-memory.ts` covers the second: an element that was clicked and changed nothing
  is remembered per (EXACT url + subgoal) by element SIGNATURE (refs are re-indexed every scan, so they must
  never be persisted), skipped while at least one other candidate remains (it can never empty the pool), and
  cleared the moment that element works. Bounded (256 keys / 32 per key, LRU), optionally persisted to JSON,
  and a damaged file degrades to "no memory" rather than failing a run. Mechanism evidence, A/B pinned:
  two rule-proof buttons where the first is inert — attempt 1 clicks the dead one and spends its step budget,
  attempt 2 skips it (trace `prevented: 1`) and completes; the no-memory control fails identically twice; and a
  remembered element that is the ONLY candidate is still used. Real-model measurement (live pack, rules off,
  A/B): 4/8 cases / 6/11 subgoals BOTH ways, while the memory demonstrably engaged — 4 (url, subgoal) keys,
  8 inert signatures, 8 steps with candidates pruned, 39 candidate picks skipped. So it ships as an OPT-IN
  (`--outcome-memory on`, `runCase(..., mem)`, `BrowserMiddleware({outcomeMemory})`) with both numbers
  recorded: the mechanism works, the outcome effect is not measurable in a configuration whose failures are
  "the model cannot find the element at all", not "it keeps hitting a dead one".
- **A dropped option is worse than a crash.** The first outcome-memory A/B handed `BenchMiddleware` an
  `outcomeMemory` that was accepted but never forwarded to `super()`, so the executor had none: the run looked
  normal and both legs measured identically — nearly recorded as "no benefit". `tests/outcome-memory.test.ts`
  now asserts the harness keeps what it was given (`mw.outcomeMemory === mem`). When an experiment's two legs
  come out suspiciously identical, verify the knob is actually CONNECTED before believing the result.

- **A hint can be EARNED, not only authored.** Authored hints carry the live pack (8/8); strip them and the
  same pack drops to **3/8** (measured with `--force-hints off`, rules still on) — so the lever is the hint
  layer, not model accuracy. `src/hint-memory.ts` turns an OBSERVED success into a rule: when a MODEL pick
  actually advanced the subgoal, the element it touched becomes a hint in the existing grammar
  (`data-test` -> `id` -> `name` -> `tag[near~label]`, and the value must not be volatile: 4+ digits, hashes
  and counters are refused). Keyed by (exact url, subgoal), used ONLY when the plan authored no hint
  (authored always wins), bounded, optionally persisted. It is the same epistemology as induced signals:
  WATCHED, never guessed — and a wrong learned hint is harmless because the grammar falls back to the model
  when it matches nothing or is ambiguous. Mechanism A/B pinned in `tests/hint-memory.test.ts`: run 1 asks the
  model, learns, completes; run 2 resolves the step `rule:match` with **zero further model calls**; the
  control (no memory) asks again; an authored hint still wins; a broken learned hint does not stall the run.
  Live observation, reported as OBSERVATION not proof: with authored hints stripped, baseline 3/8 & 4/11
  (105 model picks), learn pass 3/8 & 4/11 (96), reuse pass 3/8 & **5/11** (91) — and the subgoal covered by
  the learned `a[near~艾伦·图灵]` went from 4 steps to 1. Live sites vary far too much run to run (154/140/128
  total steps; Wikipedia serves error shells) to call the extra subgoal causal. Learned hints amortize
  subgoals that once SUCCEEDED; they cannot rescue one the model never solved.
- **Learned hints DO pay — measured noise-free, not inferred from a live session.** `npm run hint:measure`
  runs the fixture matrix twice IN ONE PROCESS with the authored hints stripped, so the only difference
  between run 1 and run 2 is the memory: control 53 -> **53** forwards (identical legs, so the matrix is
  deterministic), learned 53 -> **44** — 9 forwards saved (−17%), model-driven steps 12 -> 7, 3 of the 4
  learned hints reused. The pass count is 8/9 in BOTH legs and BOTH runs, which rules out the confound that
  matters (saving forwards by failing faster). So the mechanism is worth using; it stays opt-in at the
  LIBRARY level only because the memory's scope and file path are a deployment decision — a middleware must
  not invent a persistence location — and `--hint-memory` stays explicit in bench so future A/Bs are clean.

- **The inert observation has TWO usages, and neither moves outcomes — measured, both engaged.** The
  round-4 memory FORBIDS a remembered-inert element (`outcomeMemoryMode: "forbid"`, default); this round added
  the other usage, `"rank"`: keep it in the pool and annotate it in the model's view
  (`[tried before, page did not change]`), so the MODEL decides. Three live legs (8 sites, rules off) came out
  IDENTICAL — 4/8 cases, 6/11 subgoals — while BOTH engaged: forbid removed candidates in 3 steps (3 keys /
  5 signatures learned), rank annotated in 5 steps (3 keys / 4 signatures). Verifying engagement before
  believing an equal-outcome result is the lesson from round 4's dropped option. So on these pages neither
  usage is a lever: the failures are "the model cannot find the right element", not "it keeps hitting a dead
  one". `forbid` stays the default (decisive, already shipped); `rank` stays as an opt-in with its own
  mechanism test, because its advantage is principled — it never shrinks the candidate pool — and it matches
  the project's main line (improve what the model SEES; every threshold gate measured so far has failed).

- **Learned hints are a SIDECAR, never part of the plan.** `plan_cli run --learn-hints` keeps the memory
  next to the plan (`<plan>.hints.json`), or `--hint-memory FILE` names it explicitly; the run prints how many
  hints it knows and how many it reused. The distinction is load-bearing and pinned by
  `tests/plan-cli-hints.test.ts`: the plan file IS rewritten (status/obstacle are the resume checkpoint — that
  is a feature), but no run may write what it LEARNED into the audited artifact — after a run the subgoals
  still carry no `target_hint`, and the learned handle appears only in the sidecar. The same test proves the
  payoff end to end through the CLI: run 1 asks the model and records `[data-test=proceed-now]`, run 2 of the
  same plan completes with **zero further model calls**, and without the flag the model is asked every time.

- **A frozen corpus must not depend on the WALL CLOCK.** The ctrip parity layer compares a rendered
  report byte for byte, and that report embeds a human-readable 「执行日期」 line — so the gate silently
  expired at midnight: 10/10 -> 9/10 on 2026-10-03 purely because the reference corpus was generated on
  2026-10-02 (`first byte diff @108`). The corpus is a Python artifact and stays untouched; the CLOCK is
  what gets pinned. `todayIso()` (single implementation in `src/datasource.ts`, now also used by
  `ctrip-data.ts`/`ctrip-task.ts` instead of their two private copies) honours `LAYA_TODAY=YYYY-MM-DD`
  (malformed values are ignored, never trusted), `nextWeekDates()` derives from it, and
  `tools/ctrip-parity.ts` pins it to the day parsed out of its own corpus. `tests/parity-clock.test.ts`
  pins the property both ways: under the corpus day the corpus reproduces exactly, and without a pin the
  value tracks the real date. When a "frozen" fixture can change at midnight, it is not frozen.

- **The risk head fires on ~40% of benign clicks.** On the ctrip case 8/19 steps were flagged RISKY: a nav link "机票" 0.82,
  a sort link "价格从低到高" 0.87, a price-cap link "¥300以下" 0.79, and a purely local "record" button 0.62-0.79. The gate asks
  (never blocks), so the scenario's `confirm_fn` allows anything outside `DESTRUCTIVE_PATTERNS` and refuses what matches --
  calibration by action *type* is the fix, and this is the second scenario measuring it.

- **A LONG FLOW reaches three execution shapes the short live pack cannot, and all three were real defects.**
  `bench/cases-live-long.json` (3 sites / 34 subgoals / one journey each) is what surfaced them; the case-level
  numbers and the per-subgoal evidence are in `bench/LONG_FLOW_REPORT.md`.
  1. **`target_hints` must RE-RESOLVE the next hint in the SAME step it advances.** Advancing `_hintI` while the
     stale `curHint` stayed in hand sent the very next action to the model: on the live saucedemo logout, the menu
     click is a CSS-only change (so `inert`, so its element is forbidden), the ordered list named the logout link all
     along, and rules-only mode blocked the subgoal with "needs a model pick". A single `target_hint` keeps its old
     whole-subgoal authority — only the ordered list walks (`tests/executor.test.ts` ⑤b).
  2. **`action-timeout` must not be a life sentence.** The occlusion probe returns it when the hit-test at the
     element's centre is CLEAN but Playwright would not commit the click inside its budget — i.e. "slow, not
     blocked" — yet the caller forbade the ref for the rest of the subgoal. Live: saucedemo's burger sidebar slides
     in over ~0.5 s and would not click inside 0.8 s, so the pack lost its last target. The probe now gives one
     longer try (2.5 s) before reporting (`⑩b`); a genuinely covered element still fails fast via the hit-test.
  3. **A done-signal needs a bounded SETTLE window after an executed action.** Client-side routing updates the url
     the instant the click is handled and re-renders AFTERWARDS, so the one post-action check can look at the OLD
     page — measured on "Back to products": the signal became true 30-230 ms after the click, and roughly 1 run in 4
     checked too early, after which the step had no target left (the action had removed it) and asked the model.
     4 × 0.12 s polls (max 0.48 s), deliberately NOT gated on `!inert` (an async effect is invisible to the
     pre/post snapshot) (`⑤c`). The saucedemo case's flake rate went **7 failures in 15 runs -> 0 in 8**, and the
     whole pack runs **34/34 subgoals with zero model picks** (real model: 43 steps, all `rule:match`, 102.6 s).

## 执行层三段化（2026-10 重审，P0/P1 已落地；全文见 ARCHITECTURE.md §四.11 + docs/ARCHITECTURE_REVIEW.md）

重审把 `run()` 揉在一起的三件事切开：**命令层**（声明半=应用配置/实例化半=运行期收候选集）、
**决策层**（只读，唯一问模型处，只在闭集内选）、**数据槽层**（声明式绑定 + 该面原语执行）。
本轮落了 P0（只改形状、不改任何运行结果）与 P1（hint 单实现 + tier 候选集，门控默认关）：

- **P0 五条硬化，每条都有负例（`tests/executor-p0.test.ts`）**：① 禁元素单出口
  `forbid/unforbid/pruneForbids`（源码结构守卫钉死 1 处写入）；② 停因是数据 `stop_code`+`stop_step`
  （人读串 `stop_reason` 逐字节照旧——parity 语料钉它）；③ 敏感字段掩码 `password/file/hidden` 只留
  按长度掩码（明文不进快照/trace/报告/witness，inert 判定与 `css_value_equals` 不受影响）；
  ④ `hosts` 是**导航信封**：`disallowedHost` goto 前拒绝（0 步 0 副作用）、动作后越界即停，
  **空声明不启用**（离线包逐字节不变）；⑤ 配置类错误 `preflightConfig` 在任何腿前拦、
  `NEVER_RETRY_CODES={config_error,host_not_allowed}` 只跑一次。`LAYA_ONNX_MODEL` 优先级并入
  `model-artifacts` 单一口径（doctor 与 runtime 曾判得不一致）。
- **应用落盘移出 checkout**（前提 A）：新产物默认写 `$AMBERFLOW_HOME/apps`（缺省 `~/.amberflow/apps`），
  发现制扫 `[用户目录, 仓库夹具]` 同 id 用户赢；`spec_version` 不认识就响亮拒绝（CI 盖不到用户的包）。
  **这条纪律必须覆盖每一类落盘产物**：2026-10-14 开箱测试轮实测到缝裂开过一次——pack.json 走两目录，
  而 v2 `flow.json` 的发现（`semantic-flow` 的 `loadTemplate/listFlowApps/loadSiteProfile`）只扫仓库，
  plan:flow 的产物因此"落得下、跑不起"。修好后由 `tests/semantic.test.ts` 的"模板发现跨两个根"钉住
  （用户赢 + 仓库夹具仍可见 + 显式传目录保持单根语义）。"两份实现各扫各的"是本项目反复复发的缺陷形状。
- **P1 hint 单实现 + 更小提问（门控 `tieredHint`，默认 OFF = 逐字节不变；`tests/rules-tiered.test.ts`）**：
  6 种语法收敛进 `rules.hintMatchImpl`，`hintMatch ≡ firstIfSame(hintCandidates)` 由 20 例差分逐形状钉死；
  ON 时档内歧义向模型只问那几条候选（实测 OFF 问 15、ON 问 3），窄问弃权即回退整池——
  **阶梯四个 `method` 取值一字未动**。出口打通 CLI `--tiered-hint` 与桥 `tiered_hint`。
- **P2 命令层已落地（`src/actions.ts`；门控 = `commands` 字段本身，不声明逐字节不变；`tests/actions.test.ts` 15 条）**：
  声明半 `COMMAND_OPS=click|check|fill|select|skip` 是引擎能力面（代码），包/计划 `commands` 引用它，
  未知 op / 重复 id / fill 缺 slot 绑定 / 参数来源非 slot ⇒ 加载期红（同一个 `PlanningRules.problems`，无第三套语法）；
  实例化半 `instantiateSpace`=声明×当次观察（纯函数），解析不到出局、全空 ⇒ 结构化 `space_empty`
  **绝不退回全池、绝不问模型**；`fill/select` 值只按计划槽位**具名绑定**（`resolveCommandValue`），缺绑 ⇒
  `needs_value` 停并进 `NEVER_RETRY_CODES`。验收用例兑现：SkyBook"勾选+提交"放进**一个子目标**
  （§七.9 未解边界 → 可表达；真 site2 夹具 2 条 executed 命令、零选择提问、信号落账），
  旧 8 个生成包一字未动（`apps:gen --check` 8/8）。红线（闭集不可逃逸、缺省等价、新知识过零模型重放门）见 review §8。
- **P3 数据槽层已落地（`src/bindings.ts`；门控 = 绑定形状本身，不声明逐字节不变；`tests/bindings.test.ts` 20 条）**：
  参数三条来源、都必须点名：`{from:"slot",key}`（计划袋）、`{from:"option",key,match}`（**当次观察**的页面候选
  + `match: value|label|contains`）、`{from:"list",by,order}`（行集 + `order: min|max`）。规则不声明 ⇒ 加载期红
  （"看着像就填"就是猜）；分档匹配、**档内歧义即弃权**（P1 的 tier 纪律用到值上）；解析只有一份实现
  （`resolveBinding` 纯函数；`list` 内部调 `datasource.selectIndex`，`selects`/`list_step`/命令绑定共用），
  `<select>` 的候选在**绑定那一刻现读**（`_optionCandidates`）。两处前身接线完成：`<select>` 的 label→value
  两候选回退 → `match` 声明；`semantic-flow` 的 `min|max` 词表已删（合法面只剩 `bindings.LIST_ORDERS`）。
  验收台 `apps/checkin-binding`（真夹具：机器值 `2026-10-13` ≠ 人读标签 `10月13日 周二`，零模型提问）；
  负例"规则命不中 ⇒ `needs_value` 且页面一个字没改"。顺带修一处静默假红：`{slot}` 占位符现在对
  `invariants` 与 journey 是同一套规则（未知占位符加载期红）。
- **P4 声明式后继已落地（`next`，应用旅程层；缺省逐字节等价；`tests/path-next.test.ts` 17 条）**：
  步 `id` 从死字段变活，`next: [step-id,…]` 是有序候选；加载期校验"id 唯一 + 落点存在"（指向空气的边
  = 一步都不走的静默分支）。运行期按声明顺序取第一个"此刻适用"的候选，适用性 = 该步**自己的 `when`**
  （同一个问题、同一套信号语言、零模型）。**路径上界**是硬约束（`maxSteps` 是每步的，不是每路径的）：
  `plan.createPathWalk` 是走向的唯一实现，带 per-step 计数（缺省 3，包可声明 `max_step_visits`），
  到顶 ⇒ 结构化 `path_stop.code="next_cycle"`（不挂死、不栈溢出），走过的次数进报告 `path_visits`。
  验收台 `apps/cold-search-next`（冷启动回边把 search 走两遍；**删 `next` 即红**：record 的 `when` 不成立
  → skipped → 不变量不成立）。**边界**：`runPlan`（resume 队列语义）对 `next` **响亮拒绝**而非静默忽略；
  语义流模板的步骤键白名单里没有 `next`（那边不存在"写了不生效"）；`BrowserMiddleware` 更名仍未做。
- **D3/R-4 已落地（`inert` 不再是循环唯一的终止依据；`tests/no-progress.test.ts` 5 条）**：
  `inert` 是整页快照比对，页面有倒计时/轮播/埋点回执时**永远不成立** → 证据链断掉、anti-repeat
  不触发、同一个死按钮被反复点，最后报告把病因写成 `max_steps`。现在
  `MiddlewareOptions.maxEffectiveRepeats`（缺省 3；**0 = 显式消融**回到旧行为）按**元素签名**
  （不是位置性 ref）数"驱动了但信号没成立"的次数，超界 ⇒ 结构化 `stop_code: "no_progress"`
  （正文点名元素/次数/"不是步数预算"）。计发生在信号（含 SPA settle）与人工/noul 检查之后。
  **§8.5 的验收方式**（同一份夹具 A/B，数字进断言）：`testpages/dead-target.html` 同时是"死目标"与
  "吵页面"（50 ms 倒计时 + 页面级点击计数，后者让"不 inert"变成确定性的，不靠采样运气）——
  关掉上界 **8 步 / `max_steps` / 4.5 s**，缺省上界 **第 4 步 / `no_progress` / 2.3 s**；
  点到第 3 次才成立的信号照旧 `dom_goal_signal`（不误杀合法重复）。
- **A2′ 已落地（非破坏性步放开模型、事后由信号裁决；`tests/executor-adjudicate.test.ts` 8 条）**：
  W0 把"换闸门信号"（A1）否证了——`confidence/pTop1/margin` 同台比，现状已是最优，"反向"只是两把尺子
  混用的假象。A2′ 是它剩下的、不依赖"信分数"的半边：**步声明 `adjudicate:true`（加载期硬校验必须
  `effect.irreversible:false` + 可判定 DOM 信号；不可逆/manual/没声明一律红）**，运行期在规则/窄问/
  加宽/升级**都拿不下**、本来要 `low_confidence` 阻塞时，让模型的低置信选择**被执行、由这一步自己的
  信号事后裁决**（trace 记 `laya:adjudicated`；执行了但信号没成立 ⇒ 该元素立即禁，一次白跑就是全部代价）。
  这是老师的"提名被执行、信号定生死"同一认识论，只是爆炸半径由作者声明限定。**R1 那条臂当场兑现**：
  漂移族红格 plain（今天）0/3 → **A2′ 3/3**——模型低置信下其实**选对了**，是闸门把正确答案丢了
  （`bench/drift-real-arm.json` 两条臂都冻结进门禁）。缺省不开 = 全语料逐字节不变。
  顺带修一条潜伏断链：`TaskPlan` 构造器的保留清单**没有 `effect`** ⇒ W1 的 `effect.irreversible`
  声明从没穿过 pack→plan→executor（0 个包用过它所以从没暴露）；A2′ 依赖这个声明存活，先把它接上（`src/plan.ts`）。

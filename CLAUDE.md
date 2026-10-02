> **状态（2026-10）**：本仓库现在是 **TypeScript 单一技术栈**。
> 下文描述的 Python 实现已整体移出并备份（见 [BACKUP.md](BACKUP.md)）；
> 文中的 `python xxx.py` / `pytest` 命令指向备份中的参考实现，对应的 TS 入口见 [README.md](README.md)。
> 设计规范、实测结论与用例记录照旧有效——TS 代码的注释大量引用它们。

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-automation middleware built on top of the **pip-installed `laya` package** (v0.3.5, a non-autoregressive decision engine — each question is one forward pass ≈35 ms on the local CUDA GPU). The laya *source* is not in this repo; it lives in `C:\Python314\Lib\site-packages\laya\` (`common.py` has the model architecture, `build_sequence` serialization, `proper_reward` scoring rule). Nothing here trains laya — fine-tuning exists only in `_laya_finetune_ref.ipynb` (official Kaggle notebook, saved from NandhaKishorM/laya).

Environment: the author's box is Windows (bash shell), Python 3.14, CUDA (≈35 ms per laya forward pass); this Linux checkout runs the same suite CPU-only (≈0.5–1 s per forward pass, Python 3.12) and resolves chromium through `browser_env.py`. Model checkpoints are cached in `~/.cache/huggingface` (`convaiinnovations/laya` plus the `multilingual/` subfolder); everything runs offline unless an LLM endpoint is configured.

## Commands

```bash
npm ci                                   # Node ≥ 22.6；工具脚本跑在 `node --experimental-strip-types` 下
npm run verify                           # 一键门禁：typecheck + 全部测试 + 六层跨实现对拍
bash bench/smoke.sh                      # CI 调用的唯一"绿色"定义（离线部分无条件；模型侧缺产物时打印 SKIP）
npm test                                 # 529 个测试（仓库不变量 / 执行器 / 提取 / 计划 / 用例 / 对拍语料）
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
node --experimental-strip-types src/datasource.ts --list                           # 数据源引擎（引擎不含站点知识）
node --experimental-strip-types src/datasource.ts --source ctrip-flights-h5        # 真实票价，config 驱动
node --experimental-strip-types src/datasource.ts --source ctrip-hotels-pc --dates 2026-10-09
node --experimental-strip-types src/qunar-task.ts                                  # qunar 迁移测试（边界已实测）
node --experimental-strip-types src/ip-config.ts                                   # Excel IP 规划表 → 设备网络页
node --experimental-strip-types src/camera-entry.ts                                # Excel 类型列路由两套表单
node --experimental-strip-types src/long-task.ts                                   # 全链路 demo：plan → execute → audit
node --experimental-strip-types src/path-a.ts [--confirm-safe]                     # Path A：Playwright + 固定动作拾取器
node --experimental-strip-types src/picker-server.ts                               # Path B：扩展用的本地模型服务
node --experimental-strip-types src/tune-guard.ts                                  # 注入闸门分离度实测
node --experimental-strip-types src/live-probe.ts                                  # 携程可达性矩阵（真实站点）
npm run plan-cli -- --help                                                         # 计划 CLI：new/add/edit/check/run
npm run shortlist                                                                  # 真 ONNX 的 shortlist demo
```

线上平台用例：`node --experimental-strip-types src/bench.ts --cases bench/cases-live.json --mode-tag live`（8 个真实站点，见 README 的实测一节）。

**Python 参考命令**（`pytest`、`python3 xxx.py`、`pip install -r requirements.txt`）属于已移出的参考实现，
在 `/root/ML/LayaWebUse-python-reference-backup`（另见 `BACKUP.md`）。本仓库不包含 Python，也不再需要 Python 环境。

CI：`.github/workflows/checks.yml` 只做一件事——装 Node 依赖 + chromium，然后跑 `bench/smoke.sh`。
保持 `bench/smoke.sh` 是"绿色"的唯一定义。

Playwright 需要浏览器：`src/browser-env.ts` 按平台解析 chromium（Playwright 管理的版本，或 `PLAYWRIGHT_BROWSERS_PATH`
下已安装的 `chromium-*`），MV3 扩展必须走 `launchPersistentContext`。Mock 页面在 `testpages/`，bench 夹具在 `bench/fixtures/`。

LLM planner/auditor 在 `OPENAI_BASE_URL` + `OPENAI_API_KEY`（可加 `PLANNER_MODEL` / `AUDIT_MODEL`）齐备时自动启用；
否则用 `MockAuditor` / `ScriptedPlanner`，全流程照常运行。模型运行时（ONNX）缺产物时，所有离线测试用
`installLayaRuntime(scriptedRuntime(...))` 注入脚本模型，**不会**去碰 1.7GB 的权重。

## Architecture

**Python 参考 → TS 模块对照**（实现已全部迁移，Python 侧仅供比对）：

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
- **Two implementations of the hint grammar must stay in sync.** `BrowserMiddleware._hint_match` resolves hints against the in-memory pool; `hint_lookup` re-queries the DOM in JS for a target the MAX_ELEMENTS budget evicted. They drifted once (`#id` was added to one side only) and the plan-named target was silently lost on en.wikipedia. `hint_lookup` also **stamps** its matches (`data-hintref`) in the same pass that matches them: re-resolving scan indices against a later `page.locator(...).all()` returned a *different* element on python.org because the DOM mutated in between. Multi-word labels additionally need real `\s` escapes inside the raw JS string.
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
- **Fetching a site is CONFIG, not a script -- and "the engine knows no site" is a unit test.** `datasource.py` is a
  generic engine: transports (curl/httpx), two extractors (`json_in_script` / `html_regex`), a deliberately tiny path
  language (`a.b`, `[0]`, `[-1]`, `[]` = map, ops `time|join:x|len|len-1|int|str|strip`), config-driven counts/selects/
  audits, and a config-driven report. Everything site-specific lives in `<site>/sources/*.json`: URL template, how the
  date parameters are computed, the row path, each field's path+ops, the time window, the selection rules, the report
  columns and notes. `test_the_engine_knows_no_site` strips the engine's DOCSTRINGS and then greps the remaining code
  for `ctrip.com` / `__INITIAL_STATE__` / `flightItem` / `price-line` / `kmg` / `08:00` / `¥` -- and it caught three
  real leaks on first run (a Ctrip default for `extract.var`, a hard-coded `¥` in the report, another in the print
  path). The second source is the proof: `ctrip-hotels-pc` uses the SAME engine with zero code change by switching to
  `kind: html_regex`, `checkin/checkout` date params and an `audits` entry that measures "price node empty 5/5".
  `validate_source` runs at load time (unknown extractor/op, wrong capture-group count, unknown date expression, unknown
  `default_dates` expression, non-list `block_markers`) so a bad config fails loudly instead of silently extracting wrong
  data. Source lookup is DISCOVERY, not a directory list: every `*/sources` dir under the repo is a config dir
  (`--sources-dir` overrides; the engine file contains no site names at code level). `default_dates: "next_week"` is an
  ENGINE-level date expression (`datasource.next_week_dates` — pure calendar math; `ctrip/data.py` re-exports it, so the
  dependency points site → engine), and bot-block body signatures are CONFIG too (`transport.block_markers`, e.g.
  `["whaleguard"]`) — the engine itself only treats non-200 as blocked. Report output follows the source:
  `<sources dir>/../results` unless `--out`.
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
  INSIDE a subgoal, jumping BACK to an earlier subgoal, and multi-way choices (ARCHITECTURE.md §7.3).
- **On Chinese pages the plan's `target_hint` is load-bearing, not decoration.** The ctrip case resolves 19/19 steps by rule with
  hints (zero model calls); stripping them blocks subgoal 1 outright -- confidence **0.13** on the zh homepage, and **0.24** after
  `laya.Router` correctly routes to `multilingual` (Han = 61% of letters). Routing doubles it and still misses the 0.25 floor.
  Measured: `python3 ctrip/ctrip_task.py --no-hints [--route]` -> 0/7 both ways. Do not read this as "rules beat the model":
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

- **The risk head fires on ~40% of benign clicks.** On the ctrip case 8/19 steps were flagged RISKY: a nav link "机票" 0.82,
  a sort link "价格从低到高" 0.87, a price-cap link "¥300以下" 0.79, and a purely local "record" button 0.62-0.79. The gate asks
  (never blocks), so the scenario's `confirm_fn` allows anything outside `DESTRUCTIVE_PATTERNS` and refuses what matches --
  calibration by action *type* is the fix, and this is the second scenario measuring it.

# 应用清单（"所有应用"的题面与验收）

这份清单是**出题**：把"这个仓库里还算不上应用的东西"逐个列成一道题；**测试优化**是另一个独立角色，
它要能在不相信任何叙述的前提下把每道题**复现**出来。两边共用下面这份"完成"的定义。

## 一、什么叫"完成一个应用"

一道题只有同时满足下面五条，才算做完：

1. **声明在 `apps/<id>/pack.json`**：roles / journey / slots / sources / invariants / hosts
   （测量型应用则是 `probe` 块）。加载期校验必须能挡住坏配置（未知键、未知角色、未声明槽位、
   URL 主机没进 `hosts`……），而且是**响亮地**挡住。
2. **有一条能跑的命令**：`npm run apps -- --app <id> ...`（离线应用用 ``，
   需要真模型/真网络的在题面里注明，且不进 CI）。命令必须给出**非零一票否决**的结论
   （不变量不成立 → 退出码 1）。
3. **应用目录是数据**：`apps/<id>/**` 里 0 行代码（只放 JSON，必要时放 `bin/` 夹具）。
   `npm run apps:matrix` 必须保持 0 代码行、0 泄漏、0 债。
4. **有一个会因回归而失败的测试**（不是"跑过就算"）：放在 `tests/` 下，离线、可进 CI。
5. **有可复算的证据**：结果 JSON/报告里能读到 目标、逐步骤状态、不变量结论；原始观测不进 `src/`。

## 二、清单

| # | 应用 | 素材（现有代码/夹具） | 离线? | 验收命令 | 状态 |
|---|---|---|---|---|---|
| A1 | `apps/ctrip-case` | `ctrip/site/*.html` 复刻站 + `src/sites/ctrip-task.ts` 的 19 冻结子目标 + 独立判分 7/7 | ✅ | `npm run apps -- --app ctrip-case --no-sources` | **已完成**（独立复核：19/19、与冻结计划逐字段全等、3 条不变量） |
| A2 | `apps/ip-config` | `src/cli/ip-config.ts`（Excel IP 规划表 → 设备网络页）+ `testpages/` | ✅ | `npm run apps -- --app ip-config` | **已完成**（独立复核：8/8；表格写错的 CAM-1003 是**显式一步**、由设备页自己的拒绝文案判定） |
| A3 | `apps/camera-entry` | `src/cli/camera-entry.ts`（Excel 类型列路由两套表单）+ `testpages/` | ✅ | `npm run apps -- --app camera-entry` | **已完成**（4/4；空类型行用行内证据显式选页、CAM-12 被拒行显式成步；独立复核 confirmed） |
| A4 | `apps/transfer-voyagio` | `transfer/site5` + `specs/voyagio.json`（6 个 phase = **两页向导**） | ✅ | `npm run apps -- --app transfer-voyagio --no-sources` | **已完成**（24/24；与 `emitPlan("voyagio")` 全字段全等） |
| A5 | `apps/transfer-slowjet` | `transfer/site7` + `specs/slowjet.json`（**冷启动重试**） | ✅ | `npm run apps -- --app transfer-slowjet --no-sources` | **已完成**（19/19；`retries` 真的被用上：有子目标 attempts>1） |
| A6a | `apps/transfer-trekly` | `transfer/site3`：价格上限是 **`<input type=range>` 滑块**（19 步） | ✅ | `npm run apps -- --app transfer-trekly --no-sources` | **已完成**（19/19；三条结束状态不变量含 `#row-count` 32→12；独立复核：滑块四重证据 + 删除语义相同） |
| A6b | `apps/transfer-farehaven` | `transfer/site6`：**条件浮层 `when`**（24 步，5 条 when） | ✅ | `npm run apps -- --app transfer-farehaven --no-sources` | **已完成**（20 done + **4 skipped**；独立复核：删掉 when → exit 1 且恰好那 4 步 blocked，说明是被区分性验证的） |
| A6c | `apps/transfer-skybook` | `transfer/site2`：**23 步**（本批最大）、唯一的**分页**骨架；5 个角色模板覆盖 19/23 步 | ✅ | `npm run apps -- --app transfer-skybook --no-sources` | **已完成**（23/23；独立复核：23/23 全字段 0 diffs；信号 8 种 / 5 个重复组，其中 1 组跨页面已作边界记录） |
| A6d | `apps/transfer-flyquest` | `transfer/site4`：结果页**只能靠提交搜索表单**到达（有序 `target_hints`） | ✅ | `npm run apps -- --app transfer-flyquest --no-sources` | **已完成**（19/19；独立复核：退化成单 hint → exit 1 且恰好那 5 步 attempt 1 blocked） |
| A7 | `apps/qunar-live`（旅程 + 探针同一包） | `touch.qunar.com` **H5 手机版**机票；边界见 `src/sites/qunar-task.ts` | ❌ 需网络 + 真模型 | `npm run apps -- --app qunar-live --out /tmp/qunar` | **已完成**（**2/2**，两步都 `rule:match`，46.5s）——前提是包里声明了 `device`（见 §五） |
| A8 | `apps/checkin-binding` | `testpages/checkin.html`：机器值（`2026-10-13`）与人读标签（`10月13日 周二`）**不同**的真 `<select>`；P3 数据槽层的验收台 | ✅ | `npm run apps -- --app checkin-binding` | **已完成**（1/1 步、2/2 不变量、零模型提问；负例"规则命不中 ⇒ `needs_value` 且页面一个字没改"钉在 `tests/bindings.test.ts`） |
| A9 | `apps/cold-search-next` | `testpages/cold-search.html`：站点状态活在 sessionStorage 里（每个子目标都会重新 `goto`，页面自己记不住"搜过几次"）；P4 声明式后继 `next` 的验收台 | ✅ | `npm run apps -- --app cold-search-next` | **已完成**（2/2 步、`search` **走两遍**、1/1 不变量；删 `next` 即红、无条件自环 → `next_cycle` 结构化停因，钉在 `tests/path-next.test.ts`） |
| — | `apps/skybook-checksubmit` | `transfer/site2/hotels.html`：P2 命令闭集的验收台（"勾选 + 提交"放进**一个**子目标） | ✅ | `npm run apps -- --app skybook-checksubmit` | **已完成**（旧 8 个生成包 `apps:gen --check` 8/8 不漂；负例钉在 `tests/actions.test.ts`） |
| — | `apps/mixed-demo` | **同一旅程混用 web + cli + ssh + stdio（游戏）**：返回值三条通路（cli→ssh、ssh→浏览器命令绑定 `{from:"dataset"}`、stdio→cli）；真实副作用的证据在 `{out_dir}` 里可查 | ✅* | `npm run apps -- --app mixed-demo` | **已完成**（7/7 步；套件能力探测到本机 sshd 才跑，不可用**如实跳过**——跳过 ≠ 通过。*需本机 sshd；stdio 用 `bench/fixtures/guess-game.mjs`，CI 可跑） |
| — | `apps/demo-app` / `cli-report` / `repo-report` | 应用层示范、工具步示范、真实工具（git+jq） | ✅ | 见 `apps/README.md` | 已完成 |
| — | `apps/ctrip-live` / `ota-live` / `qunar-live` | 测量型应用（探针集） | ❌ 需网络 | 见 `bench/live-retest/REPORT.md` | 已完成 |
| — | `apps/demo-tool` / `git-log` / `bench-cases` | 纯数据源应用（无旅程） | ✅ | `npm run apps:matrix` | 已完成 |

## 三、角色分工（Agent Teams）

- **出题（author）**：写 `apps/<id>/**` + 一个会因回归失败的测试；只碰自己的目录与自己的测试文件。
- **测试优化（verifier）**：独立复现题面里的每个断言（不看作者的叙述，只看命令与原始输出）、
  用坏包去撞加载期校验、检查 0 代码行/防泄漏门禁、并尝试**证伪**不变量；
  发现共享层缺陷时先报告（附最小复现），再决定是否改 `src/**`。
- **Lead**：维护这份清单、跑最终门禁（`npm run verify` + `bash bench/smoke.sh`）并提交；
  Lead 是 `CLAUDE.md`、`README.md`、`apps/README.md`、`tools/apps_matrix.ts`、
  `tests/repo-integrity.test.ts` 的唯一写者。

每个角色的报告都要落到：**题 → 命令 → 原始观测 → 结论**。没有原始观测的"通过"一律不认。

## 四、独立复核发现（本轮）

复核报告：[bench/APP_VERIFY_REPORT.md](../bench/APP_VERIFY_REPORT.md)（含 §8 的 A1/A2 复核节）。
"测试优化"角色的第一轮就找出 11 处问题，其中 3 处在共享层、已修（附最小复现，修后 6 个既有包 + 3 个探针集零回归）：

| # | 问题 | 状态 |
|---|---|---|
| G-B | 角色内联覆盖混用两种步型的键被**静默丢弃**（`{role: 浏览器角色, args: [...]}` 的 args 消失，step 仍按浏览器步跑） | 已修（加载期报错） |
| G-C | `hosts` 为空/缺失时，探针 URL 的主机校验被跳过 → 门禁后门 | 已修 |
| G-D | `hosts` 写成裸字符串能过校验 → 门禁按**字符**建 token（既漏主机又刷假泄漏） | 已修 |
| G-A | 测量型应用（探针集）经 `runApp` **空转"通过 0/0"** | 已修（CLI 指路探针驱动，exit 2） |
| G-J | 坏包走 CLI 是未捕获异常（栈） | 已修（报清楚 + exit 2） |
| G-L | 命令起不来（缺二进制/超时）抛栈、不写结果 | 已修（`refused: "tool-unavailable"` 进结果 JSON） |
| G-E/G-F | 跨列表重复 id / 非字符串 id 静默 `String()` | **已修（第 2 轮）** |
| G-I | 重复 invariant id | 下一轮 |
| G-G/G-H | 浏览器步无 `start_url` 放行 / `max_subgoals`·`slots`·`sources` 类型不校验 | **已修（第 2 轮）** |
| G-K | 工具步的重试计数文件跨运行持久（`cli-report` 的 attempts 会从 1 变 3 再变 1） | **已修（第 2 轮，`{run_id}`）** |
| G-N | **应用包不能声明设备面**：`touch.qunar.com` 的手机版页在桌面 UA/视口下 DOM 不同 → hint 落空、laya 也选不出来（0.15 < 0.25 floor）→ 一个线上应用被记成"跑不通"。修法：`device`（UA/视口/触摸/locale/时区/DPR）进声明面 + `browserSession(headless, device)`，qunar 包声明 iPhone 390×844 后 **2/2 全规则命中** | **已修（第 4 轮）** |
| G-M | **`when` 不校验**：`signal` 走 `PlanningRules`，`when` 没人管——未知算子要到运行期才变成 BLOCKED 的 `error: unknown signal spec` | **已修（第 3 轮：`when` 用同一个 walker 校验，含组合嵌套与空 when）** |

第 1 轮结果：**A1 / A2 完成并各自通过独立复核**（19/19 + 8/8，不变量成立，逐字段对齐）。
第 2 轮结果：**A3 / A4 / A5 完成并各自通过独立复核**（4/4 + 24/24 + 19/19，不变量成立，逐字段对齐），
共享层 5 类加固（G-E/G-F/G-G/G-H/G-K）已修并各有回归测试；三轮共 **14 个应用**（`npm run apps:matrix` 的行数：11 个包 + 3 个纯数据源应用）。
一条必须说清楚的边界：**`transfer-slowjet` 的绿不是"全程规则命中"**——它的冷启动让第一次尝试落空、
laya 被问过一次（脚本模型给不出 choice），最后靠 `retries` 重跑才过；测试里显式断言了 `act` 被问过 +
有子目标 `attempts>1`。其余四条旅程（ctrip-case / ip-config / camera-entry / voyagio）都是全规则命中。

第 4 轮结果：**A6c skybook（23 步）与 A6d flyquest（提交表单）完成并各自通过独立复核**，
**A7 线上那道题也完成**（`apps/qunar-live` 2/2，两步全规则命中，46.5s，证据 [bench/live-retest/qunar-live-app-run.md](../bench/live-retest/qunar-app-run.md)）。
**清单至此没有待出题的行**；`npm run apps:suite` 覆盖 12 个离线旅程应用（11 绿 + `cli-report` 待放行），
线上/测量型应用被自动识别并明着跳过。当前 18 个应用 / 3210 声明行 / 应用目录 0 行代码 / 泄漏 OK / 债 0。

第 4 轮（线上那道题）暴露并修掉了一个**schema 缺口**（G-N，见 §五）：应用包无法声明**设备面**，
于是"只有手机版页面存在"的站点（`touch.` 域）在桌面上下文里跑——DOM 不同、计划点名的目标不在元素池里、
hint 必然落空。修复后同一份计划 2/2 一次命中（`click div "北京" (clicked, rule:match, conf=1.00)`）。

另有两条"知道的边界"要一直说清楚：`cli-report`/`repo-report` 在**缺 git/jq** 的机器上以前会崩（G-L 已修成结果），
`ip-config` 前三台设备的"保存了正确值"由**逐步骤信号**保证，而 `invariants` 只看**结束状态**（CAM-1003 的拒绝页）。

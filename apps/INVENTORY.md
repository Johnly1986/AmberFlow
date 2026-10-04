# 应用清单（"所有应用"的题面与验收）

这份清单是**出题**：把"这个仓库里还算不上应用的东西"逐个列成一道题；**测试优化**是另一个独立角色，
它要能在不相信任何叙述的前提下把每道题**复现**出来。两边共用下面这份"完成"的定义。

## 一、什么叫"完成一个应用"

一道题只有同时满足下面五条，才算做完：

1. **声明在 `apps/<id>/pack.json`**：roles / journey / slots / sources / invariants / hosts
   （测量型应用则是 `probe` 块）。加载期校验必须能挡住坏配置（未知键、未知角色、未声明槽位、
   URL 主机没进 `hosts`……），而且是**响亮地**挡住。
2. **有一条能跑的命令**：`npm run apps -- --app <id> ...`（离线应用用 `--no-model`，
   需要真模型/真网络的在题面里注明，且不进 CI）。命令必须给出**非零一票否决**的结论
   （不变量不成立 → 退出码 1）。
3. **应用目录是数据**：`apps/<id>/**` 里 0 行代码（只放 JSON，必要时放 `bin/` 夹具）。
   `npm run apps:matrix` 必须保持 0 代码行、0 泄漏、0 债。
4. **有一个会因回归而失败的测试**（不是"跑过就算"）：放在 `tests/` 下，离线、可进 CI。
5. **有可复算的证据**：结果 JSON/报告里能读到 目标、逐步骤状态、不变量结论；原始观测不进 `src/`。

## 二、清单

| # | 应用 | 素材（现有代码/夹具） | 离线? | 验收命令 | 状态 |
|---|---|---|---|---|---|
| A1 | `apps/ctrip-case` | `ctrip/site/*.html` 复刻站 + `src/ctrip-task.ts` 的 19 冻结子目标 + 独立判分 7/7 | ✅ | `npm run apps -- --app ctrip-case --no-model --no-sources` | **已完成**（独立复核：19/19、与冻结计划逐字段全等、3 条不变量） |
| A2 | `apps/ip-config` | `src/ip-config.ts`（Excel IP 规划表 → 设备网络页）+ `testpages/` | ✅ | `npm run apps -- --app ip-config --no-model` | **已完成**（独立复核：8/8；表格写错的 CAM-1003 是**显式一步**、由设备页自己的拒绝文案判定） |
| A3 | `apps/camera-entry` | `src/camera-entry.ts`（Excel 类型列路由两套表单）+ `testpages/` | ✅ | `npm run apps -- --app camera-entry --no-model` | **已完成**（4/4；空类型行用行内证据显式选页、CAM-12 被拒行显式成步；独立复核 confirmed） |
| A4 | `apps/transfer-voyagio` | `transfer/site5` + `specs/voyagio.json`（6 个 phase = **两页向导**） | ✅ | `npm run apps -- --app transfer-voyagio --no-model --no-sources` | **已完成**（24/24；与 `emitPlan("voyagio")` 全字段全等） |
| A5 | `apps/transfer-slowjet` | `transfer/site7` + `specs/slowjet.json`（**冷启动重试**） | ✅ | `npm run apps -- --app transfer-slowjet --no-model --no-sources` | **已完成**（19/19；`retries` 真的被用上：有子目标 attempts>1） |
| A6 | `apps/transfer-trekly` / `transfer-farehaven` / `transfer-skybook` / `transfer-flyquest` | `transfer/site3`（滑块）/ `site6`（条件浮层 `when`）/ `site2`（11 步最大）/ `site4`（提交表单才能进结果页） | ✅ | 同 A4 口径 | 待出题 |
| A7 | `apps/qunar-flight` | `touch.qunar.com` H5 机票（真实站点；边界见 `src/qunar-task.ts`） | ❌ 需网络 | `npm run apps -- --app qunar-flight --model english` | 待出题 |
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
| G-E/G-F/G-I | 跨列表重复 id / 非字符串 id 静默 `String()` / 重复 invariant id | 下一轮 |
| G-G/G-H | 浏览器步无 `start_url` 放行 / `max_subgoals`·`slots`·`sources` 类型不校验 | 下一轮 |
| G-K | 工具步的重试计数文件跨运行持久（`cli-report` 的 attempts 会从 1 变 3 再变 1） | 下一轮（记录在案） |

第 1 轮结果：**A1 / A2 完成并各自通过独立复核**（19/19 + 8/8，不变量成立，逐字段对齐）。
第 2 轮结果：**A3 / A4 / A5 完成并各自通过独立复核**（4/4 + 24/24 + 19/19，不变量成立，逐字段对齐），
共享层 5 类加固（G-E/G-F/G-G/G-H/G-K）已修并各有回归测试；三轮共 **14 个应用**（`npm run apps:matrix` 的行数：11 个包 + 3 个纯数据源应用）。
一条必须说清楚的边界：**`transfer-slowjet` 的绿不是"全程规则命中"**——它的冷启动让第一次尝试落空、
laya 被问过一次（脚本模型给不出 choice），最后靠 `retries` 重跑才过；测试里显式断言了 `act` 被问过 +
有子目标 `attempts>1`。其余四条旅程（ctrip-case / ip-config / camera-entry / voyagio）都是全规则命中。

另有两条"知道的边界"要一直说清楚：`cli-report`/`repo-report` 在**缺 git/jq** 的机器上以前会崩（G-L 已修成结果），
`ip-config` 前三台设备的"保存了正确值"由**逐步骤信号**保证，而 `invariants` 只看**结束状态**（CAM-1003 的拒绝页）。

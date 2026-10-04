# 使用者体验评审（三个子代理扮演真实使用者 · 2026-10-04）

**怎么做的**：派三个子代理，各自扮演一种真实使用者，走完整路径并把**原始输出**带回来：

| 身份 | 它做了什么 | 报告落盘（工作区外） |
|---|---|---|
| A. 第一次拿到它的人 | `npm run doctor` → `npm start` → `npm run apps --list/--dry/真跑` → 只读 README 判断够不够 → 试错 `demoo-app` / `--nope` | `/tmp/ux-review-LayaWebUse.md` |
| B. 想加一个自己应用的人 | **只按 `apps/README.md`** 从零写一个最小应用 → 跑到绿 → 故意犯三类错 → 删干净；不许读源码/CLAUDE.md/别人的 pack | 报告在消息里（全文见 §5） |
| C. 每天跑任务排障的人 | `repo-report`（真实 git+jq）、`cli-report` 放行/不放行、`apps:suite` 全量、四种失败注入、逐项计时 | `/tmp/ux-review-apps-suite.md` |

本文件是**汇总**。凡标 ✅ 的条目，我（Lead）事后自己复核过并贴在下面；标 ⚠️ 的是子代理观察到、我用最小复现**没能**复现的，如实降级；标 ❓ 的是子代理自己声明"未验证/猜测"的部分。

---

## 一、好消息（都是实测，不是设计意图）

| 体验点 | 原始观测 | 来源 |
|---|---|---|
| **到第一次成功 17 秒** | `npm run doctor` 1.1s（Node/chromium/模型/LLM 四项）→ `npm start` 15.8s → `结果：2/2 步骤 2 跳过 0 重试 0`、`每步的判定方式：rule:match, rule:match`、`这份计划全部由「计划点名目标 + DOM 信号」解决，没有用到模型权重` | A |
| **共享层零改动就能加应用** | B 只写了一个 28 行纯 JSON 包：`apps:matrix` 从 `18 个 ｜ 3210 行` → `19 个 ｜ 3238 行`，`应用目录里的代码 0 行`、`泄漏检查：OK` 全程保持；删除后精确回到 `18 个 ｜ 3210 行` | B |
| **拒绝不等绿** | `cli-report` 不带 `--allow-dangerous` → `exit 1`、`refused:"dangerous"`、产物**未落盘**；带上 → `exit 0`、`wrote .../cli-report-artifact.txt` | C |
| **真实工具的来源可复算** | `repo-report` 报告里给了数据源列 + **完整 argv**（`git log --since=… --pretty=format:%h\|%an\|%ad\|%s`、`jq -r .cases[].id bench/cases-live-long.json`）+ 退出码 + stdout 摘要 | C |
| **验收失败不会被动作腿洗绿** | 临时副本里把 ctrip-case 的 invariant 改成不可能成立 → `exit 1`、`19/19 done` 照跑但 `**未通过**` | C |
| **逐条复现了已入库的复核表** | `apps:suite` 全量 158.5s，12 行真跑 + 3 行"明着跳过"，与 `bench/APP_VERIFY_REPORT.md` §11.5 pin 的表逐行一致（本机更快：ctrip-case 5.9s vs 7.3s） | C |

---

## 二、使用者打分（1–5，可自解度 = "出错时我能不能自己修好"）

| 任务 | 命令 | 退出码 | 耗时 | 可自解度 |
|---|---|---|---|---|
| 环境体检 | `npm run doctor` | 0 | 1.1s | 5 |
| 开箱任务 | `npm start` | 0 | 15.8s | 5 |
| 列出应用 | `npm run apps -- --list` | 0 | 0.6s | 5 |
| 只展开计划 | `--dry` | 0 | 0.7s | 5 |
| 跑一个真应用 | `--app demo-app` | 0 | 50.9s | 5 |
| 真实工具应用 | `--app repo-report` | 0 | 0.5s | 5 |
| 危险步（不放行/放行） | `--app cli-report` | 1 / 0 | 1.1s / 2.0s | **3** |
| 一条命令跑完所有应用 | `npm run apps:suite` | 0 | **158.5s** | 4（表）/ **2（当门禁）** |
| 应用 id 拼错 | `--app demoo-app` | 2 | 0.4s | 5（清楚）/ **3（不给候选）** |
| 未知参数 | `--app demo-app --nope` | **1** + Node 栈 | 0.4s | **1** |
| 未写目标却只有信号 | 自己写的包 | 1 | 2.9s | **1** |
| 未声明槽位 | `--slot foo=1` | **0（通过）** | 2.4s | **1** |
| 输出目录不可写 | `--out /sys/...` | 1 + Node 栈 | 0.4s | **2** |

---

## 三、缺陷清单（按"最误导使用者"排序）

### 1. ✅ 未声明的槽位被**静默接受**（我复核确认）
```
$ npm run apps -- --app demo-app --no-model --slot foo=1 --out /tmp/vb-slot
- 结果：**通过** ｜ 步骤 5/5 ｜ 用时 2s         EXIT=0        ← foo 根本不是声明过的槽位
```
打错槽位名字照样全绿。**最小改法**：`--slot k=v` 校验 `k ∈ pack.slots ∪ required_slots`，不在就 exit 2 并列出已声明槽位。

### 2. ✅ `apps:suite --only <打错字>` → **"0/0 通过" + exit 0**（我复核确认）
```
$ npm run apps:suite -- --only demo-ap
应用套件：0/0 通过  ← 离线旅程型应用没有红项        EXIT=0
```
一个都没跑却报绿、还带一句"没有红项"。**最小改法**：过滤命中 0 个 → 报错 + 非零退出码。

### 3. ✅ `apps:suite` 作为"是否全部完成"的退出码**不诚实**（我复核确认）
实测 `11/12 通过，1 个待显式放行` 时 **exit 0**——`apps:suite && echo OK` 会打印 OK。**最小改法**：分层退出码（0 只给"全部真执行且通过"；"待放行"与"跳过"各自一个非零码），或至少把汇总行改成"未达全绿"。

### 4. ✅ `npm start` 静默弄脏工作区（我复核确认）
```
$ git status --short        # 运行前：空
$ npm start                 # exit 0
$ git status --short
 M .task_plan.json          # 只有 saved_at 变了
$ grep -c "task_plan\|计划已保存" /tmp/vb-start.log
0                           # stdout 一次都没提
```
"离线零配置演示"的代价是仓库里多一个改动，而且**零提示**——`git status` 干净是使用者的默认预期。**最小改法**：结束时打印写入的检查点路径（或默认写 `$TMPDIR`）。

### 5. ✅ README **完全没提应用层**（我复核确认）
```
$ grep -c "npm run apps\|pack.json\|应用包" README.md
0
```
而实际有 **18 个应用包**、`npm run apps` / `apps:suite` 是体验最好的端到端路径。新人读 README 不会知道它们存在。**最小改法**：README 补一节（`--list` / `--dry` / 真跑 / 产物路径 / `apps:suite`），并把第 43–45 行列出的 ctrip/transfer/qunar/跑分补上**可复制命令**（现在一条都没有）。

### 6. ✅ 自己写的包，最常见的一次失败**报错完全指不到病因**（子代理 B 亲历，我读过同一处代码路径）
```
- 结果：**未通过** ｜ 步骤 0/1
| 0 | 打开 portal 页 | blocked | 1 | picked ref 'undefined' is not in the element pool on step 1 |
```
`--dry` 展开正常，说明不是语法问题；而 `ref 'undefined' is not in the element pool` 是执行器内部产物，与"这一步没有能点到的目标"没有字面联系。B 因此被迫去读夹具 HTML（下面 §5 记为"文档缺口"）。**最小改法**：改成 `step 0 "…" has neither target_hint(s) nor an actionable element; its signal was false before any action`。

### 7. ✅ 校验错误**缺位置信息**（子代理 B 实测三处输出逐字相同）
```
roles.open-portal.desc 里 {ghost} → unknown slot placeholder {ghost}
target_hints 里 {ghost}            → unknown slot placeholder {ghost}
signal 选择器里 {ghost}            → unknown slot placeholder {ghost}
```
同仓库的 `journey[1]: unknown role "no-such-role"` 已经带下标了——这是**一处不一致**。**最小改法**：消息带 `roles.<name>.<field>`。

### 8. ✅ 不可写输出目录 → **原生 Node 栈 + exit 1**（我复核确认）
```
$ npm run apps -- --app demo-app --no-model --out /sys/vb-out
EXIT=1
node:fs:1370
  const result = binding.mkdir(
```
与"干净报错 + exit 2"的契约不一致（`src/app-runner.ts` 的 `mkdirSync` 没有 try/catch）。

### 9. ✅ 用法错误的退出码不统一
`--app demoo-app` → **2**（干净一行）；`--app demo-app --nope` → **1 + 12 行 Node 栈**（parseArgs 原生）。脚本化调用方分不清"用法错"和"运行失败"。

### 10. ⚠️ 一个杂散目录能让 `apps:suite` **整条崩掉且不输出已完成的 11 行**（子代理 C 亲眼看到）
```
Error: app pack ".../apps/ux-scratch-hello/pack.json" not found under .../apps
```
**我的复核结果是"部分确认、机制不同"**：我用一个空目录 `apps/zz-ux-empty/` 做最小复现，套件照常 `1/1 通过 exit 0`——因为 `appDirs()` 本来就只收 `pack.json` 存在的目录。C 撞到的应是**并发写者删除该目录**造成的 TOCTOU（列目录之后、`loadPack` 之前消失）。结论不变：`suite()` 的逐应用加载在 try 之外，**异常会掀掉整张表**；最小改法仍是逐应用 try/catch → 表内一行"未通过（加载失败：…）"，其余照常出表。

### 11. ⚠️ `/proc/ux-out` 挂死 >300s —— **我未能复现**
```
$ timeout 5 mkdir -p /proc/ux-test ; echo $?
1                       # 立即 EPERM，不是挂死
```
C 观察到的是 `--out /proc/ux-out` 空转 >300s 被 kill（并附了隔离实验）。我的最小复现给出的是一秒钟的 `EPERM`。**降级为未确认**：可能与具体路径/内核状态有关，需要时再单独查。

### 12. 其他（子代理报告，我未逐条复核）
- 不变量失败只给 `id/desc/不成立`，**没有期望 vs 实际、没有结束页快照**（JSON 里没有 `final_url`）；`desc` 与实际 `signal` 可以互相矛盾，使用者会被 `desc` 带偏。
- 危险步的**同一状态有三种说法**：CLI `REFUSED (dangerous)` / 单应用报告 `**dangerous**` / 套件 `待放行(未执行)`；且三处都没写"加 `--allow-dangerous` 可放行"。
- 纯工具步应用的 `plan_path` 指向一个不存在的文件。
- 输出目录残留 `retry-counter-*`；`apps:suite` 的 255 行逐步日志把第 232 行才开始的表挤到末尾。
- `npm start -- --url <页面>` 在**非 TTY**（管道/CI）下会失败，且提示自相矛盾（"没有可交互输入"——它上一行刚列出 6 个可交互元素），建议的 `--target` 还是第 1 个候选（商品标题）而非目标按钮；照抄建议会得到 `manual` 信号但 **exit 0**（pty 下真人是通的）。**这条我未复核。**
- ❓ 子代理自己的猜测（未验证）：`spec_version`/`model` 是否可省、`id` 是否必须等于目录名、`--slot` 的修复是否会影响既有脚本。

---

## 四、"一条命令跑完所有应用"该怎么用（结论修正）

上一轮我把 `npm run apps:suite` 说成"所有应用是否完成的**退出码**"。**这次实测把它降级**：

- **作为给人看的清单：可信。** 12 行真跑、3 行明着跳过（写明"不是豁免"）、`cli-report` 既不冒充绿也不冒充红，且逐行复现了已入库的复核表。
- **作为退出码门禁：不可信。** ① `11/12 + 1 待放行` 仍 exit 0；② `--only` 打错字 `0/0` 也 exit 0；③ 逐应用加载异常会掀掉整张表；④ 它**不在 CI 里**（`bench/smoke.sh` 与 `.github/workflows` 都没调用），所以这些风险落在"人手动跑/自己串脚本"上。

---

## 五、加一个应用的**真实成本**（子代理 B 全程实测）

| 指标 | 实测 |
|---|---|
| 工具调用 | **24**（21 bash + 1 write + 1 edit + 1 read），其中 `apps` 跑了 8 次 |
| 到绿为止改 `pack.json` | **3 次** |
| 人时 | 约 15 分钟，其中 **≈1/3 花在"找一个能用的选择器"** |
| 被迫越界 | **1 处**：README 从头到尾没给 `testpages/` 或 `bench/fixtures/` 里任何一个具体元素/选择器，只能去读夹具 HTML |
| 共享层改动 | **0** ✅ |
| README 缺的可复制样例 | L100–126 是带注释的 JSONC 片段，不能直接复制跑；`bench/fixtures/shop_cart.html` 只作为示例值出现 |

B 最终的包与验收（`exit 0`、`step 1: click a "枪机 / 筒机 录入…" (clicked, rule:match, conf=1.00)`、`invariant on-camera-a: held`）证实**门槛确实很低**——卡点全在"文档没说的那一步"。

---

## 六、最值得修的前 5 条（按性价比）

1. **`--slot` 校验已声明槽位**（现在打错也绿）+ **`--only` 未命中报错**（现在 0/0 绿）——两处都是"假绿"，各 1 行校验。
2. **`apps:suite` 逐应用容错 + 退出码分层**（坏包/坏目录只影响它自己那一行；"待放行/跳过"不冒充全绿）。
3. **浏览器步缺目标时的报错说人话**（`has neither target_hint(s) nor an actionable element`）——这是子代理 B 唯一一次被迫读源码的直接原因。
4. **README 补应用层一节 + 一个可复制的整包样例 + 给"开箱用例"补命令**；把"零配置"的措辞与准备命令对齐。
5. **副作用与"没执行"都显式化**：`npm start` 打印检查点路径；危险步的 CLI/`.md`/`.json` 统一成"未执行（危险步未放行）+ 加 `--allow-dangerous` 可放行"；不变量失败附带实际求值与结束状态。

---

## 七、复算方式

三个身份的原路径都是可重跑的，最短的几条：

```bash
npm run doctor && npm start                       # 17 秒到第一次成功
npm run apps -- --list && npm run apps -- --app demo-app --no-model --dry
npm run apps -- --app demo-app --no-model         # 50s，5/5 + 2 条不变量
npm run apps -- --app cli-report --no-model       # 期望 exit 1 + REFUSED (dangerous)、无产物
npm run apps -- --app cli-report --no-model --allow-dangerous
npm run apps:suite                                # 158s，11/12 + 1 待放行
npm run apps -- --app demo-app --no-model --slot foo=1     # ← 现在 exit 0（假绿）
npm run apps:suite -- --only demo-ap                        # ← 现在 "0/0 通过"（假绿）
```

子代理的完整原始报告在 `/tmp/ux-review-LayaWebUse.md`（身份 A，387 行）与 `/tmp/ux-review-apps-suite.md`
（身份 C）；身份 B 的报告在会话消息里。三者都实测过 `git status --short` 空、未 commit、未改仓库文件
（`npm start` 弄脏的 `.task_plan.json` 已还原）。

---

## 八、修复后复测（同一轮内完成，2026-10-04）

按"性价比前 5 条"的顺序修完，每条都有回归测试（`tests/ux-fixes.test.ts`，12 条）。
**复测命令与关键观测**（全部是本机实测；🔴 = 修复前、🟢 = 修复后）：

| # | 修复 | 复测命令 | 修复前 | 修复后 |
|---|---|---|---|---|
| 1 | `--slot` 的键必须声明过 | `npm run apps -- --app demo-app --no-model --slot foo=1` | 🔴 `EXIT=0`、`通过 5/5` | 🟢 `EXIT=2` + `--slot "foo" not declared by app demo-app（已声明：coupon）` |
| 1 | `apps:suite --only` 未命中 | `npm run apps:suite -- --only demo-ap` | 🔴 `应用套件：0/0 通过`、`EXIT=0` | 🟢 `EXIT=2` + 列出 15 个已知应用名 |
| 2 | 套件退出码分层 | `npm run apps:suite -- --only demo-app,cli-report` | 🔴 `EXIT=0` | 🟢 `EXIT=3`（有未执行）＋汇总行写明"1 个未执行" |
| 2 | 逐应用容错 | 造一个坏包 `apps/zz-ux-broken/pack.json` 后跑 `--only demo-app,zz-ux-broken` | 🔴 一处加载失败会掀掉整张表 | 🟢 `demo-app 通过` + `zz-ux-broken 未通过 / 加载失败：Expected property name…`，`EXIT=1`（坏行只影响它自己） |
| 3 | 缺目标的报错 | 一个只有 `signal`、没有 `target_hint` 的包 | 🔴 `picked ref 'undefined' is not in the element pool on step 1` | 🟢 `step 1 names no target: no target_hint(s), no rule matched any of the 3 element(s), and the picker returned no usable element（给这一步加 target_hint…）` |
| 4 | README 可复制的最小应用 | 从 README 抽出那段 JSON **逐字节**写进 `apps/hello/pack.json` 再跑 | 🔴 README 零提应用层（`grep -c` = 0） | 🟢 原样复制即 `EXIT=0`、`invariant on-camera-a: held`、`结果：**通过**` |
| 5 | 危险步一套说法 | `npm run apps -- --app cli-report --no-model` | 🔴 CLI `REFUSED (dangerous)` / 报告 `**dangerous**` / 套件 `待放行(未执行)` | 🟢 三处同念 `REFUSAL_LABELS`：`未执行（危险步未放行；加 --allow-dangerous 可放行，本次未落盘）`；JSON 机器字段仍是 `refused:"dangerous"` |
| 5 | `npm start` 的副作用 | `npm start` | 🔴 弄脏 `.task_plan.json` 且 stdout 零提及 | 🟢 打印 `计划检查点：.task_plan.json` + "本次运行已把它更新：git status 会看到这一处改动；不想动工作区就加 --plan …" |
| — | `--out` 建不出来 | `--out /sys/ux-out` | 🔴 原生 Node 栈 + `EXIT=1` | 🟢 `EXIT=2` + `--out "…" 建不出来：EPERM…` |

**这一轮同时纠正了我上一轮的说法**：`apps:suite` 不再是"所有应用是否完成的退出码"——它是**清单**，
退出码是分层的（`0` 全部真执行且通过 / `1` 有未通过 / `2` 用法错误 / `3` 有未执行）。契约写进了
`apps:suite --help`、[README.md](../README.md) 与 [apps/README.md](../apps/README.md)。

**独立复核（`probe-porter`，§12）的结论与补修**：5 项 confirmed；它同时 **refuted 了一条我自己引入的回归**
——新文案里的裸词 `git status` 撞上防泄漏门禁（`git` 是 `apps/git-log` 声明的工具标识、`src/start.ts` 在
CORE 名单里），`apps:matrix` 变红并连带 5 条断言。**已改文案（"版本控制会让你看到这一处改动"），门禁恢复**；
这条值得记一笔：闸门抓到的是"共享层里出现站点/工具知识"，即使它出现在一句给用户看的提示里——写作时
UX 文案也要服从同一条纪律。复核方还发现**同一类的两个静默尾巴**，也已一并收掉：

- `--slot coupon=A --slot coupon=B` 曾是**静默 last-wins**（A 悄悄消失）→ 现在 `exit 2` 并回显两个值。
- `--only` 打错字 + `--json` 会给"`exit 2` 但没有 JSON"→ 现在输出 `{"error":…,"unmatched":[…],"known":[…],"exit_code":2}`。

**仍未修（记在案，不假装）**：

- 不变量失败只给 `id / desc / 不成立`，**没有期望 vs 实际、没有结束页快照**（`final_url` 等）——身份 C 的
  第 5 条，改动会牵到结果 JSON 的形状，值得单独一轮。
- 纯工具步应用的 `plan_path` 指向一个不存在的文件；报告文件（`.md` / `-result.json`）是 **CLI 写的**，
  直接调 `runApp` 不会产出（本轮写测试时才发现）。
- `npm start -- --url` 在非 TTY 下失败且提示自相矛盾（身份 A 的第 2 条，我未复核细节）。
- `/proc` 形态的"无输出挂死"**未能复现**（见 §三.11），依旧留在"未确认"。

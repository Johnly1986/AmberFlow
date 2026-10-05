# 改进意见汇总（backlog）

**这份文件的用途**：把散落在 [bench/UX_REVIEW.md](UX_REVIEW.md)、[bench/AUTHORING_ASSESSMENT.md](AUTHORING_ASSESSMENT.md)、
[bench/APP_VERIFY_REPORT.md](APP_VERIFY_REPORT.md) §四、以及三轮外部参考（[jev-ultrafast-mcp](https://github.com/jiawei686/jev-ultrafast-mcp)、
[jev-stack](https://github.com/aleksvega/jev-stack)、[ego-jev-ultrafast](https://github.com/shikaizhong-design/ego-jev-ultrafast)）
里讨论过的改进，合成**一份按性价比排序、每条都带"怎么验证"的清单**。

规则（沿用本仓库的纪律）：
- 每条都要有**现状证据**（命令/文件/实测数字），不接受"应该会更好"；
- 每条都要有**验收方式**，最好是现成的消融台（`--force-rules off`、`--no-retries`、`hint:measure`、`apps:suite`）；
- **明确不做**的条目也要写上理由——省得下一轮有人再提一遍。

---

## 一、已完成（本轮之前/期间，别再当待办）

| 项 | 证据 |
|---|---|
| 使用者体验 5 项修复（假绿 ×2、门禁可分层、报错说人话、文档缺口、副作用与"未执行"显式化） | commit `30ecc9a`；[bench/UX_REVIEW.md](UX_REVIEW.md) §八；`tests/ux-fixes.test.ts` 14 条 |
| `spec → pack` 生成器（对齐从"验过"变成构造性质） | commit `29773be`；`npm run apps:gen -- --check` 8/8 |
| builder 输入（`--source <模块>#<导出名>`，ip-config 的验收语义搬进代码） | commit `a2cc2ad`；`src/ip-config.ts#buildAppPlan` 与手写包 0 差异 |
| 不变量归纳（对照态 = 旅程少做最后一步；写回自愈） | commit `a2cc2ad`；`npm run apps:induce`；实测"提出 4 条 → 重跑撤掉 1 条不可复现 → 3/3 通过" |
| 探针基线（判决进包，站点变了/手改包都红） | commit `a2cc2ad`；`npm run probes:baseline -- --check` 3/3；`bench/smoke.sh` 2c |

---

## 二、开放项

### 第一批｜LLM 使用与接入的正确性（小改动，当天可验证）

| ID | 建议 | 现状证据 | 验收方式 |
|---|---|---|---|
| **I-1** | **模型可用性做启动期预检**：缺产物/缺 key/地址非法 → 立刻 `model-unavailable` 退出，**0 步、0 副作用**；配置类错误**永不重试**；顺带修提示里的错字 | 实测：`LAYA_ONNX_MODEL=/tmp/definitely-missing.onnx npm run apps -- --app demo-app` → **数据腿与第一个工具步已执行**、同一配置错误被**重试 2 次**、提示写成 `LAYAA_ONNX_MODEL` | 同一条命令：exit≠0 + stdout 有 `model-unavailable` + **产物文件不存在**（证明零副作用） |
| **I-2** | **每次运行报账一行**：`决策 N（缓存命中 M）· 模型 Xs · 页面 Ys · 墙钟 Zs · 重试 R` | 数字都在 trace 里，但没有统一账单行；我们最强的实测结论（rules 8/8 vs 4/8、cache 第二次 0 前向、hint −17%）只在报告里 | 同一应用跑两遍，第二遍账单必须体现"少问"；对齐 `npm run cache:measure` |
| **I-3** | **provider 三元组一起解析**（name + base_url + key 来源 + 默认 model），错误点名"是哪个 provider 失败"；兼容旧变量 | 我们目前三个变量各自独立读，无预检。外部教训原文：跨 provider 借 key 会买到"一个指错公司的 401"，而"按错的 provider 诊断的运行等于没人诊断" | 单测：base_url 与 key 分属两家 → **预检期**干净报错（而不是跑到一半 401）；旧变量组合仍可用 |
| **I-4** | **每个 LLM 入口的"越权即拒绝"负例**：写清"谁可以产出什么"（ref / 子目标+hint / 值 / 判断），每个入口一条越权测试 | escalator 已有（编造 ref → ABSTAIN，`tests/escalate.test.ts`）；planner/auditor 没有同类的"试图写值/写越权字段"负例 | `npm run verify`；负例必须红 |

### 第二批｜运行时（中等，都能 A/B 量化）

| ID | 建议 | 现状证据 | 验收方式 |
|---|---|---|---|
| **R-1** | **"元素表稳定"的 settle**：首次扫描前等到元素表连续 K 次不变（有界），不是等网络静默 | 我们的两类症状都出在这：wiki 错误壳、`transfer-slowjet` 冷启动；现有补丁是 `retries`（治症，且要重跑整步） | `transfer-slowjet --no-retries` 现在 **0/7**（CLAUDE.md 实测）；改后应转绿或显著改善，且 `retries` 触发次数下降 |
| **R-2** | **criteria view 优先级/delta 渲染**：必含 ①点名目标 ②上一步后的变化 ③与子目标最相关的前 N 个；其余只给计数 | `build_sequence` 在 max_len=512（CJK 1024）截断，**约 720 字符之后模型看不见**——对我们"上下文长度 = 精度"，不是省钱问题 | `--force-rules off` 的 live pack A/B + `hint:measure` 式同进程双腿，量"子目标完成数 / 前向次数" |
| **R-3** | **视图上的可行性标注 + `reachable=N/M`**：被遮 `⊘` / 禁用 `⊗` / 屏外 `»`；禁用项**列出但永不作为候选** | 我们已有 0×0 过滤、可操作性探测、被遮 ref 重入，但**模型看到的视图没有这层标注**；而我们测出的唯一有效杠杆是"改善模型看到的东西" | 有覆盖层/禁用按钮的夹具：模型不再选被遮项（复用 outcome-memory/inert 测试台） |
| **R-4** | **no-progress stop**：连续 N 次动作无变化即停，`stop_reason` 与 `max_steps` **分开** | 我们有 inert→forbid + outcomeMemory，但停止原因只有 `max_steps` 一类 | 拿一个死元素当目标：现在会烧完 `max_steps`，改后应早停且理由不同 |
| **R-5** | **`hosts` 从文档升级为导航信封**：跳到未声明主机即拒绝并给出理由 | 已确认：`hosts` 只在**加载期校验类型**，被探针主机检查与防泄漏门禁使用，**运行期不强制** | 给 `ctrip-case` 临时加一条指向 `evil.example` 的步骤 → 干净拒绝；空 `hosts` 的离线包不受影响 |
| **R-6** | **敏感字段不进模型视图/报告**：`password/file/hidden` 的 `value` 置空并标 `secret`；报告与 trace 里打码 | 已确认：`grep password src/extraction.ts src/executor.ts` = **0 处**——没有"排除/遮蔽"的显式规则 | 含 password 输入框的夹具页：模型视图与 `-result.json`/`.md` 都不得出现该值 |

### 第三批｜能力扩展（较大，价值最高）

| ID | 建议 | 现状证据 | 验收方式 |
|---|---|---|---|
| **C-1** | **持久 profile / attach 模式**：手动登录一次，之后一直登录着；`--attach` 只碰自己开的页，退出只断开不关浏览器 | 线上最大边界就是登录墙：ctrip 酒店 `LOGIN_REQUIRED`（"登录以查看会员价"）→"¥300 以内"**没有数据可判**。我们已有 `device` 声明，但没有"会话前提" | 酒店探针从 `LOGIN_REQUIRED` 变成"登录态下价格节点非空 N 条"，并把该判决写进 `probe.baseline`（R-4 的基线正好接上） |
| **C-2a** | ✅ **本轮已落地**："演示一次 → 录成应用包 → 规则模式 0 次模型调用回放 → 回放不过不落盘"（`npm run learn`）。已录 `apps/learned-cart`；门槛被实测咬过两次（① 演示累积状态 vs 回放重导航 → 不变量改从回放形状那次归纳；② 一条候选复跑不成立 → 明确剔除并写进 notes） | — | — |
| **C-2b** | ✅ **已补**：`--cdp` 挂到自己浏览器的端到端演练跑通（起一个带调试端口的 chromium → 挂上去 → 认 `--url` → 录成包 → 0 前向回放 → **退出后浏览器仍活着**），并钉成 `tests/learn.test.ts` 的一条回归。仍缺：真人在 TTY 上现场演示的完整回路（录制器本身有测试） | — | — |
| **C-2** | **宏回放**：记录一次路径 → 零模型调用复跑 → **页面变了就拒绝**（不是猜）；`{{placeholder}}` 参数化；只在页面证明成功后落盘 | 我们只有 `withDecisionCache`（精确指纹）与 `hint-memory`（学到的句柄）；而我们的"冻结计划"是**人写的**，不是**录下来的** | 同一流程第二次运行：**0 次前向**（现有 cache 已能做到同一计划 0 次，宏要把它扩展到学到的路径）；把页面改一处 → 回放必须拒绝而不是点错 |
| **C-3** | **LLM 角色矩阵**：决策/规划/兜底三个角色各配 1–2 个候选模型，量延迟、成功率、是否越权，产出 `bench/LLM_MATRIX.md`（带"小样本、单机、你的数字会不同"的诚实声明） | 我们已有 `--force-model`、`bench/ablate.sh`、`calibration`、`cache:measure`、`hint:measure`，但没有 LLM 角色维度 | 脚本产出矩阵，结论可复算；`bench/` 里留档 |
| **C-4** | **说明书要能被交付通道读下**：`CLAUDE.md` 拆成"短契约 + 链接文档"，加一条 CI 预算检查；另补 `llms.txt` 式短自述 | 本会话里 `CLAUDE.md` **反复被工作区指令预算截断到 65,536 字节**（从 ~71 KB 截到 65 KB），**读者只看到被截断的那部分**。外部同型教训：某客户端会**丢掉** MCP server 的 `instructions`（"measured, not assumed"），他们只好把同一条规则做成 skill 再发一次 | 预算检查：文件超预算即红；拆完后随机抽三条规则，确认都在"短契约"里可读到 |

---

## 三、明确**不做**（附理由，避免重复讨论）

| 不做 | 理由 |
|---|---|
| 让聊天模型写字段值（他们让文本助手"只写那个字符串"） | 破坏我们的硬约束"值只来自计划槽位，模型不许发明取值"。若将来要接，必须落成**计划里的数据 + 审计** |
| 云端 per-step 决策模型当默认主循环 | 他们是按步付费（README 给出日均 $0.01 的账单），所以"一次调用 vs 每步一次"是省钱；我们本地 ONNX 的约束是**秒/前向 + 离线可用**。云模型放 **escalator**（已实现、fail closed）是对的，进主循环会同时丢掉离线性与"规则优先"的经济学 |
| 截图/视觉入环 | 我们本来就没有视觉；加 VLM 每步正是我们刻意避开的那条成本/延迟路径 |
| 用模型自述判定"完成" | 已经实测否掉：DOM 信号是唯一真相，noul 只作建议。ego 版自己承认"同模型判 DONE 可被页面诱导"是继承来的残余风险——我们不继承 |
| 一个全局开关关掉风险闸门（他们的 `JEV_AUTO=1`） | 风险闸门按动作类型确认，而不是整轮关闭；关闸门要按动作粒度，不按全局 |
| 把 `camera-entry` 的类型列路由也搬成 builder | 上游是"Excel 类型列 × 两套表单 × 行内证据"的路由表；搬进 `buildAppPlan` = 判断从一处代码挪到另一处，收益是"可生成"，代价是**同一个应用出现两份路由知识** |
| 自动化"语义意图与最终裁定" | `dangerous`/`idempotent`（不可逆的意图）、"这次结束态对不对"的裁定、"这站是否只有手机版"的结论确认——把它们塞进生成器，等于把"人必须负责的部分"藏起来，比手写更危险 |

---

## 三·一、本轮（第 1 轮"三类入口"）抓到并修掉的缺陷

1. **冻结语料的比较依赖时钟（一处根因、四处发作）**：spec 的 `per_date` 按"下周"展开，所以"当天是哪天"
   会改变展开结果——2026-10-04（周日）算的是 10-05..09，跨到 10-05（周一）就是 10-12..16。本轮实测它同时打红：
   `apps:gen --check`（7 个包漂移）、`tests/transfer.test.ts`（15 条）、`tools/transfer-parity.ts`（41 项不一致）、
   `bench/smoke.sh` 的 transfer oracle 用例。修法：单一出处 `tools/frozen-today.ts` 的 `FROZEN_TODAY`，
   生成器/检查器/对拍工具/测试夹具/smoke 五处共用（环境变量一律不算，只有显式 `--today` 能换周）。
2. **`serializePack` 漏键**（第二次同型）：漏写 `recorded_from` → 落盘的包丢血统、矩阵把它当"手写"。
   （第一次是漏 `roles`，导致生成的包根本加载不了。）
3. **学习工具自身的两处判断错**：URL 类候选被 stability 过滤误杀（`url_contains` 是我们五个算子之一）；
   id 用中文目标（`file://` 页面没有 hostname）→ 改成 ASCII 安全 + 短哈希。

## 四、残余风险登记（我们自己的 "What it is not"，随版本更新）

1. **不变量看不到中间要求**（那是子目标信号的职责）——写在各 pack 的 notes 里。
2. 归纳出的不变量**措辞要人 review**：它给的是"观测到的文本"（如 `¥300以下的酒店`），不是人的意图（如 `已记录`）。
3. `skybook` 的**跨页面信号**未做反事实验证；`flyquest` 只退化了 `#date` 一种（`#search-btn` 预期也红但未实测）。
4. 生成器**沿用种子包结构**：首个包的命名仍带人的偏好（无种子时按 spec 的 role 名归并）。
5. `apps:suite` **不在 CI**（`bench/smoke.sh` 里加了 `apps:gen --check` 与 `probes:baseline --check`，但 suite 要 2–3 分钟且含浏览器）。
6. 报告文件（`-result.json` / `.md`）由 **CLI 写**，直接调 `runApp` 不产出；纯工具步应用的 `plan_path` 指向一个不存在的文件。
7. `/proc` 形态的"无输出挂死"**未能复现**（[bench/UX_REVIEW.md](UX_REVIEW.md) §三.11），仍属"未确认"。
8. `npm start -- --url` 在**非 TTY** 下的提示自相矛盾（"+没复核细节"）。

---

## 五、复算入口（每条建议的验收都落在这里）

```bash
npm run verify && bash bench/smoke.sh        # 现有门禁（含 2b apps:gen --check / 2c probes:baseline --check）
npm run apps:suite                           # 11/12 真执行且通过 + 1 未执行 + 3 要真网络（退出码 3）
npm run apps:matrix                          # 声明成本 / 0 代码行 / 泄漏 / 债 / 生成 vs 手写
npm run apps:gen -- --check                  # 生成的包 == 来源的展开
npm run apps:induce -- --app <id> --json     # 不变量候选（区分性 + 稳定句柄 + 复跑一致）
npm run probes:baseline -- --check           # 探针判决 == 已入库探测记录
npm run cache:measure / npm run hint:measure # "少问模型"的两条无噪声 A/B
npm run bench -- --force-rules off           # 模型视图/规则消融台（R-2/R-3 的验收台）
```

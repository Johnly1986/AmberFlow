# 决策模型的存在理由审查（独立复核）

> 本文只有一个准绳，来自项目方的原始目的：**决策模型的引入，是为了简化流程配置、增加弹性与容错。**
>
> 它不预设既有设计正确，也不预设本项目最近三轮（P2 命令层 / P3 数据槽层 / P4 声明式后继）正确——
> 那三轮都是本文要审的对象。每条结论都带**本机可复算**的证据，其中模型侧的数字来自**真 ONNX 决策模型**
> 的现场实测（本机从 HF 缓存导出，torch↔ORT 数值对拍通过），不是对旧报告的转述。
>
> 本轮**没有**改 `src/`、`apps/` 的既有结论与任何冻结语料；新增一个可复算工具
> （`tools/model-contribution.ts`）与本文。裁定与是否立项仍由项目方决定。

## 0. 一句话结论

**把"决策模型"换成"作者写下的目标声明"，系统能力不变甚至更好；把"作者写下的目标声明"换成"决策模型"，
完成率掉到 0。** 今天这套架构里，简化配置、弹性与容错的承重件不是决策模型，而是
**声明 + 规则 + 编译器/录制器**；模型是兜底层，而兜底层在实测里的 precision 是 **15%**——
用来决定"信不信它"的那个置信度，AUC 只有 **0.325**（比掷硬币还差，方向是反的）。

但真机实验（§2.5）给出了**另一半**同样重要的事实：在当初逼出 P1 的那两个维基页面上，
**窄问（档内 2 条候选）让模型 14/14 选对**，而执行器给它的**全池提问 14 次只对 3 次**，
且错的那 11 次里有 7 次的置信度高到会被采纳。**问题不是模型没能力，而是问法与闸门都用错了。**

这不是"模型没用"，而是**分工写反了**：模型被放在运行期做它最不擅长的事（在 5–20 个相似控件里选一个，
且选错就没有人兜），而它最擅长的事（理解意图、给候选）在作者期几乎没有被使用。

## 1. 复算入口（本轮全部实测）

```bash
# ① 真模型产物（本机：HF 缓存已有 1.5G safetensors；导出配方见 §7）
ls -la /tmp/laya_dec.onnx /tmp/laya_dec.onnx.data          # 2.9 MB 图 + 1.69 GB 外置权重
npm run doctor                                             # 决策模型 /tmp/laya_dec.onnx ✓（图+权重+tokenizer）

# ② 核心计量：模型在"人写 hint 的那一步"能不能顶上（172 步，逐题=生产同一个问题）
npm run model:contribution -- --out /tmp/model-contribution.json

# ③ 弹性 A/B：同一份旅程，去掉全部 hint（含角色模板），真模型兜底
node --experimental-strip-types src/app-runner.ts --app apps/<id>/pack.json --out /tmp/x

# ④ 真机换问法（§2.5：全池 vs 窄问 vs 人写 hint，跑生产代码、不做平均分）
node --experimental-strip-types tools/ask-shapes.ts \
  --url 'https://en.wikipedia.org/w/index.php?search=Alan+Turing&fulltext=1&ns0=1' \
  --goal 'open the Alan Turing article from the search results' \
  --hint 'a[href~Alan_Turing]' --expect 'Alan_Turing' --repeat 3
```

模型侧的对拍锚点（导出时验证，这是本文所有模型数字的可信前提）：

| 序列形状 | torch ↔ onnxruntime logits max\|diff\| |
|---|---|
| len 74 / 3 选项 | 2.43e-06 |
| len 495 / 3 选项 | 1.34e-05 |
| len 120 / 11 选项 | 9.18e-06 |

## 2. 体检数字

### 2.1 配置侧：模型本该消灭的那部分，占了语料的大头

| 指标 | 数值 | 复算 |
|---|---|---|
| 声明行（非空）：`pack.json` + 语义流 `flow.json` + `sites/*.json` | **3651** 行 / 21 个应用目录 / 190 个 step 条目 | §7 末尾的两条复算命令 |
| 应用包旅程步（`journey`，角色模板合并后） | 180 步 | 同上 |
| └ 其中**点名了目标**（`target_hint` / `target_hints`） | **169/180 = 94%** | 同上 |
| 其中由生成器产出（`apps:gen`） | 8 个应用 | `npm run apps:gen -- --check` |
| 声明里"机械展开"的比例（项目自己的评估） | 61%（1797/2965） | `bench/AUTHORING_ASSESSMENT.md` |
| 真正必须人写的判断 | 约 31 条（29 不变量 + 1 设备 + 1 危险动作） | 同上 |
| 容错声明：`when` / `retries` / `next` | 7 / 12 / 1 | 同上计数 |
| P2/P3/P4 新增的声明面 | `commands` 2 处、具名绑定 1 处、`next` 1 处、`max_step_visits` 1 处 | 同上计数 |

### 2.2 运行侧：模型的实际出场

`npm run apps:suite`（17 个可跑应用、179 步、零外部网络）本轮结果：

- 步骤 **179**，模型**咨询 5 次**、**过关执行 0 步**；`reobserve` 挽回 **0** 步；
- 16/17 应用零咨询；唯一咨询的是 `transfer-slowjet`（冷启动 5 次，**全部没过 0.25 闸门**，靠 `retries` 走完）；
- 决策缓存：命中 52 / 提问 205。

也就是说：**在全部已验收的旅程里，"谁点哪个元素"没有一个是由模型决定的。**

### 2.3 模型侧（本轮新测）：如果让它点，它点对多少

`tools/model-contribution.ts` 对每个应用包的每个浏览器步：打开该步的 `start_url` → 生产提取器取元素池 →
把这一步人写的 `target_hint` 解成人选 → 用**生产的** `BrowserMiddleware.pickElement`（同一份 state 渲染、
同一个 criteria 视图、同一个 shortlist k=8、同一个置信度口径）问模型 → 按**元素签名**比对。
**不执行任何动作。**

- 测得 **172** 步，其中 **162** 步可判（10 步 hint 解不出/模型没答：slowjet 的 5 个冷启动步、farehaven 的 2 个、qunar/checkin/skybook 各 1）；
- **top-1 命中率 25%**（40/162）；**拉丁页 23/128 = 18%**，**CJK 页 17/34 = 50%**；
- 置信度：均值 **0.269**、最大 0.974；**75/162（46%）≥ 生产闸门 0.25**；
- 误差解剖（122 个错答）：**89 个选了导航/品牌元素**（"Flights"/"Stays"/logo——正是 `nav_rule` 存在的理由）；
  **17 个错答的置信度 ≥ 0.5**（最高 0.974）；只有 2 个是"标签相同的兄弟节点"（近似命中），12 个同 tag。

**分应用（节选，完整见 `/tmp/model-contribution.json`）**

| 应用 | 步 | 可判 | 选对 | 命中率 | 均值置信度 |
|---|---|---|---|---|---|
| transfer-farehaven | 24 | 22 | 1 | **5%** | 0.247 |
| transfer-voyagio | 24 | 24 | 7 | 29% | 0.198 |
| transfer-skybook | 23 | 23 | 1 | **4%** | 0.444 |
| ctrip-case | 19 | 19 | 9 | 47% | 0.315 |
| transfer-flyquest | 19 | 19 | 8 | 42% | 0.193 |
| transfer-slowjet | 19 | 14 | 0 | **0%** | 0.331 |
| transfer-trekly | 19 | 19 | 3 | 16% | 0.283 |
| ip-config | 8 | 8 | 3 | 38% | 0.068 |
| camera-entry | 4 | 4 | 4 | **100%** | **0.010** |
| demo-app | 4 | 4 | 1 | 25% | 0.380 |

**闸门扫描（本轮最重要的表）**

| floor | 模型会决定的步 | 其中选对 | precision | 被闸门拦下 | 拦下的里本来是对的 |
|---|---|---|---|---|---|
| 0.05 | 141 | 30 | 21% | 21 | 10 |
| 0.10 | 125 | 25 | 20% | 37 | 15 |
| 0.15 | 110 | 17 | 15% | 52 | 23 |
| 0.20 | 95 | 15 | 16% | 67 | 25 |
| **0.25（今天）** | **75** | **11** | **15%** | **87** | **29** |
| 0.30 | 66 | 9 | 14% | 96 | 31 |
| 0.40 | 34 | 5 | 15% | 128 | 35 |
| 0.50 | 20 | 3 | 15% | 142 | 37 |

**precision 在整个 0.05–0.50 区间里是平的（14%–21%）**：置信度几乎不区分对错。
把闸门从 0.25 降到 0.05，会多采纳 66 步：**多对 19 步、多错 47 步**。这直接否掉两个直觉建议——
"把 floor 调低让模型多出场"和"置信度闸门在保护我们"（它保护的是损失**速率**，不是正确率）。

**更硬的一条：闸门不是"不区分"，而是"偏向错误"。** 把置信度当作"这一步答对了"的预测器：

| 指标 | 数值 | 含义 |
|---|---|---|
| AUC(conf → correct) | **0.325** | 0.5 = 毫无区分力；<0.5 = **系统性地把错误的排在正确的前面** |
| Pearson corr(conf, correct) | **-0.239** | 负相关 |
| 答对步的均值置信度 | 0.184 | 答对时反而更"没底" |
| 答错步的均值置信度 | 0.297 | 答错时更"自信" |

**按池子大小分层**（同一份数据）：

| 池子 | 步数 | 命中率 | 均值置信度 |
|---|---|---|---|
| <=5 个元素 | 49 | **51%** | **0.085** |
| 6-10 个元素 | 88 | **6%** | **0.346** |
| 11-30 个元素 | 25 | 40% | 0.355 |

模型最容易答对的地方（小池子、页面语义清楚）它**最没底气**；它最有底气的地方（6-10 个相似控件）
命中率 **6%**。这与项目早就记过的那条实测同源（"C3-R 的 top-two margin 不转移：坏 pick 的 margin
反而更高"，见 `CLAUDE.md`）——本轮把那条结论从 margin 推广到了**生产闸门所用的 confidence** 上。

### 2.4 弹性 A/B：同一份旅程，把 hint 全部删掉（真模型兜底）

| 应用 | 有 hint | 删掉 hint（真模型） | 时间 |
|---|---|---|---|
| demo-app（拉丁夹具 5 步） | **通过** 5/5，1.3 s | 未通过 **3/5**（2 步 `low confidence 0.17/0.15`） | 42 s |
| camera-entry（中文表单 4 步） | **通过** 4/4，5.4 s | 未通过 **0/4**（0.01–0.08） | 31 s |
| ctrip-case（中文复刻站 19 步） | **通过** 19/19，6.6 s | 未通过 **10/19**（0.13–0.23，另有多次 `needs_value`） | 489 s |
| transfer-trekly（拉丁复刻站 19 步） | **通过** 19/19，21 s | 未通过 **0/19**（0.02–0.20） | 192 s |

**流程级：有 hint 4/4 通过，删掉 hint 0/4 通过。** 模型确实被问了（4–12 次/应用），但它的答案要么没过闸门，
要么落在一个计划没有值的字段上（`needs_value`），要么就是别的东西。

复合算术：一步 25% 的对率、19 步走完 ≈ 3.6e-12；即便按最好的 ctrip 47% 算 ≈ 5.9e-7；
`retries: 2`（三次机会）把单步抬到 0.58 / 0.85，19 步全对仍只有 3.0e-5 / 4.7e-2。
**弹性不是"每步差一点"，而是"差一点点就什么都完不成"。**

### 2.5 真机实测：同一个页面、同一个目标，**换问法**（本轮补上项目自己列为"未做"的线上 A/B）

项目记着一条"仍未做"：`--tiered-hint` 的线上 A/B 真机数字。本轮做到了——就在当初逼出 P1 的那两个页面上
（en/zh 维基百科搜索结果页；`a[href~Alan_Turing]` 曾经 17 命中 → 歧义 → 落 laya **0.23 → BLOCKED**）。
工具：`tools/ask-shapes.ts`（同一个 state 渲染、同一个 criteria 视图、同一个 shortlist 语义，全部走生产代码）。

| 问法 | en-wiki（7 次） | zh-wiki（7 次） |
|---|---|---|
| **人写 hint**（规则路径，参照） | 7/7 对 | 7/7 对 |
| **全池提问**（40 元素；hint 未命中时执行器的实际问法） | **0/7 对** | **3/7 对** |
| **窄问**（P1 `tieredHint` 的形状：档内 2 条候选） | **7/7 对** | **7/7 对** |

把 14 次观测合起来看，结论是两条互相对冲的事实：

1. **全池提问在这两个页面上是"错的或没底气的"**：14 次里只有 3 次选对人；错的时候模型每次都扑向
   **搜索框按钮**（en：`input "Search Wikipedia"` / `button "Search"`；zh：`input "搜索维基百科"`）——
   与语料里"89/122 个错答选了导航/品牌元素"是同一个失败模式。
   而且其中 **7 次的置信度 ≥ 0.25**（en 0.467×4、zh 0.390×2 / 0.346×1）——**执行器会采纳并点错元素**；
   另外 7 次低于闸门，直接 BLOCKED。**"兜底"在这两个页面上的两种结局，都不是兜住。**
2. **窄问让 choice 头给出正确答案 14/14**，p(top1) 0.55–0.61、p(top2) 0.39–0.45、margin 0.10–0.23；
   但它的 `confidence`（= 1 − H/log k）只有 **0.007–0.037**，**14/14 全部低于 0.25 闸门**。
   也就是说：**P1 的前提在真机上被证实了（更小的提问确实让模型选对），而这个功能在生产里是死的**——
   不是因为它选错，而是因为"信不信它"用的那个刻度**随选项数变化**：2 选项的 55/45 拿不到 0.25，
   而 40 选项里的 0.467 却能过闸门并点错。

> 这正好回答了本文的核心问题：**模型的问题从来不是"没被给机会"，而是被放在了错误的问法 × 错误的闸门上。**
> 执行器里已经有这条判断的半个先例（`pickElement` 的注释写着"选项少时 confidence 会塌，短名单分支
> 该用 argmax 与次席的差作为闸门信号"）——它只作用在 shortlist 分支，没有作用在**窄问**上。
>
> 边界（必须说清）：这是 14 次观测、2 个页面；真机页面在两次访问之间会变（同一页同问题实测出现过
> 不同答案），所以不能把它当成"改闸门就一定变好"的证明，只能当成一个**已量到方向的立项实验**。

### 2.6 代价口径

一次模型决策在本机（CPU、含 state 渲染/shortlist/前向）均值 **4.98 s**、最大 11.5 s。
对照：`ctrip-case` 有 hint 6.6 s / 无 hint 489 s（同一个旅程，19 步）。
文档里现存的"35 ms"是作者 CUDA 机器上的**单次前向**；把端到端代价写进"模型值不值"的主张里更诚实。

## 3. 三档裁定

| # | 既有主张（显式或隐含） | 裁定 | 依据 |
|---|---|---|---|
| 1 | "决策模型简化流程配置" | **推翻**（在本机/本语料） | 94% 的步手写目标；模型 top-1 25%、precision 15%；删掉声明反而更差（§2.3/§2.4） |
| 2 | "模型带来弹性" | **收窄为"最后手段 + 诊断"** | 删声明后流程完成率 0/4；模型被咨询但过闸门极少（§2.4） |
| 3 | "模型带来容错" | **部分成立，但容错真实来源是声明式三件套** | `when`/`retries`/`next` 承担了全部已验收的容错；slowjet 的 5 次咨询**全没过闸门**，是 `retries` 救了它（§2.2） |
| 4 | "hint 是可选的点名" | **推翻** | 它是承重墙：94% 的步靠它，删掉即 0/4（§2.1/§2.4）。架构文档没有把这条写成必需 |
| 5 | "置信度闸门保护正确性" | **推翻**（作为"分辨对错"的机制）；只保留"限制损失速率"这一条 | AUC 0.325 / corr −0.239：闸门**偏向错误**；precision 在 0.05–0.50 全平（14–21%）；降 floor 净增错误（§2.3） |
| 6 | "模型可选、规则为主"（现状的隐含架构） | **保留** | 这正是实测支持的形状；缺的是把它写清楚，并给模型安排**它擅长的那一半工作** |
| 6b | "窄问（`tieredHint`）只有理论价值，线上 A/B 还没做" | **推翻**：真机 14/14 选对（§2.5） | 但**同时**判定：这个功能在生产里**取不到值**——14/14 的 confidence 都 ≤0.037，被 0.25 闸门全数拒绝；且它只在"hint 语法档内歧义"时才触发（今天那两个页面的 hint 是直接命中的，所以真实触发面比"hint 未命中"窄） |
| 6c | "不确定性用 confidence 闸门处理" | **收窄为"按问法归一化之后再比"** | 同一个模型、同一个页面：2 选项的正确答案 conf 0.007–0.037，40 选项的**错误**答案 conf 0.226–0.467。刻度随选项数变 ⇒ 闸门必须换成 `p(top1)` / `margin`（`pickElement` 的 shortlist 分支已经有这条先例）或者由页面裁决 |
| 7 | P2 命令层 / P3 数据槽层 / P4 声明式后继（本会话上一轮的工作） | **保留，但要补编译侧** | 三者加的都是**声明面**而不是模型依赖：按本文准绳，它们对"简化配置"是**反向**（手写面 +N），对"弹性/容错"是**正向**（闭集不可逃逸、具名绑定、有界回边）。重审文档 §6.2.1 自己写过"候选列表不由人手写，由编译器枚举"——P2/P3/P4 目前仍是手写（语料里 commands 2 处、绑定 1 处、next 1 处） |

## 4. 缺陷（按准绳编号）

**M1｜"模型在场"从未被计量成"模型有用"，"问法/闸门"也从未被计量。** 项目有两套出场口径
（咨询数/过关数），但没有"过关时的正确率"，也没有"同一个页面换一种问法会怎样"。
本轮补上两个工具：`tools/model-contribution.ts`（**过关 75 步、其中 11 步对 = 15%**）与
`tools/ask-shapes.ts`（**窄问 14/14 对但 conf ≤0.037 全被闸门拒绝；全池问法 3/14 对，
其中 7 次错答的 conf ≥0.25 会被采纳**）。没有这两个数，"模型值不值"只能是叙述。

**M2｜hint 是承重墙，却被当成装饰。** 169/180 步靠它；`apps:matrix` 有它的一列，但
`apps:suite` 的"通过"与 `ARCHITECTURE.md` 的措辞都没有把它当**必需条件**。

**M3｜瓶颈是置信度头，不是选择头；而运行期只信置信度头。** 两条证据：
`camera-entry` **4/4 选对、置信度 0.01**；池子 <=5 的 49 步 **51% 命中、均值置信度 0.085**；
池子 6-10 的 88 步 **6% 命中、均值置信度 0.346**。也就是说：
**choice 头在"页面语义清楚、选项少"时是可用的，是 conf 头把可用信号压死、把不可用信号抬高**
（AUC 0.325）。运行期只采纳 conf 过闸门的那一步，于是恰好系统性地采纳了错的那一类。
作者期（提议 hint / 提议 signal）根本不需要 conf 头——人来做这个闸门。

**M4｜"弹性"全压在声明侧，而声明侧没有对应的编译入口。** `when`/`retries`/`next`/`commands`/
绑定都是人写的；`apps:gen` 只覆盖 8 个由 spec 生成的包。P2/P3/P4 的新面（闭集、绑定、后继）
**没有一个**有"从意图编译出来"的入口。

**M5｜成本口径缺失。** 模型决策的端到端代价（本轮 4.98 s 均值）没有出现在任何"模型值不值"的结论旁边。

**M6｜"最后手段"没有验收台。** `escalateFn`（LLM 老师）在语料里出场 0 次；`reobserve` 挽回 0 步。
两级兜底都没有一条"它真的救回过什么"的入库证据（live pack 的 A/B 与 ONNX 权重一样，都还没有）。

## 5. 建议（按性价比排序；M0 不改行为）

| 阶段 | 内容 | 通过判据（可测） |
|---|---|---|
| **M0** | **只加计量**：把"模型过关时的正确率"和 **hint 覆盖率**变成一等数字（`apps:suite`/`apps:matrix` 的列 + README 的主张旁边） | 两个数字出现在套件输出里；hint 覆盖率 <100% 时明确标注"这些步靠模型兜底" |
| **M1** | **换问法 + 换闸门**（本文最具体的一条）：① 让窄问在更多场景生效（今天只在档内歧义时触发）；② 闸门改成**按选项数归一**的信号（`p(top1)` 或 `margin`），而不是 `1 − H/log k`——先例在 `pickElement` 的 shortlist 分支；③ 只在"页面能裁决错误动作（表单/下拉/radio）"或"这一步可回退"的地方放开 | 用 `tools/ask-shapes.ts` 做 A/B：窄问的选对率与 `p(top1)/margin` 的分布（本轮 14/14 对、margin 0.10–0.23），以及**在页面上真的把这一步走完**；同时把"错答被采纳"计数成 0 |
| **M2** | **作者期用模型**：`plan:flow`/`learn` 现在纯观察+归纳、不用模型；让模型提议候选 hint/signal，人只确认 | 提议的接受率与"人减少的手写行数"；作者期错了有人兜，运行期错了没人兜 |
| **M3** | **把分工写进文档**：README/ARCHITECTURE 明说"hint 是主路径、模型是兜底+诊断"，并附本轮数字 | 文档改动 + 这两张表进 `docs/` |
| **M4** | **别做**：整体降 floor / 扩大 shortlist k / 把 hint 变成可选 | 三个都被 §2.3 与 §2.5 的数据否掉（整体降 floor 净增 47 个错误、只多 19 个正确；降 floor 救不了窄问，因为窄问的 conf 是 0.007–0.037 量级） |

## 6. 本轮不做 / 需要裁定

- **没做**：没有动 `src/`、`apps/` 的任何既有结论；live pack 的**整包** A/B 没跑
  （只跑了 §2.5 那两个歧义页面的换问法实验；整包 8 个 case 需要更长时间且真机会波动）；
  `escalateFn` 的 LLM 端点本机没有配置；`noul`/`score` 两个头没测（本文只测了 choice 头，
  它是运行期唯一被采纳的那个）。
- **本文工具自己的边界（写在明面上）**：
  1. "人写的 hint"被当作标准答案——在 hint 只是"可行解之一"的步上会**低估**模型
     （实测里只有 2/122 个错答是"标签相同的兄弟节点"，影响小但存在）；
  2. 每步独立新开浏览器上下文（生产是一个会话），这会去掉会话态，但每步的输入与生产一致；
  3. 172 步里有 10 步无法判定（hint 未命中或模型没答），已在表里单列，没有算成"答错"；
  4. 结论只对**这台机器 + 这个语料**成立；跨语料的稳健性需要 live pack（缺网络）。
- **需要项目方裁定**：
  ① 接受"模型 = 兜底 + 诊断，配置 = 承重"的定位并写进 README/ARCHITECTURE 吗？
  ② M1（换问法 + 换闸门：窄问 + `p(top1)/margin` + 页面裁决）立项吗？
  ③ hint 覆盖率要不要进 `apps:suite` 的验收列（今天它没有牙）？
  ④ 本会话上一轮的 P2/P3/P4 是否补"从意图编译"的入口（重审 §6.2.1 的纪律），还是承认它们是新的人工声明面？

## 7. 附：真模型产物的导出配方（本机复现）

仓库按政策不含 Python（见 [BACKUP.md](../BACKUP.md)），所以配方以 shell 形式给出，
**不要**把脚本写进仓库：

```bash
# 前置：pip 环境里有 torch / transformers / onnxruntime，且 ~/.cache/huggingface 有
#       models--convaiinnovations--laya（1.5 G safetensors + tokenizer）。离线：
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
python3 - <<'PY'
import torch, laya
from torch.export import Dim
from laya.common import QTYPES, build_sequence, collate_items
agent = laya.load("convaiinnovations/laya", device="cpu"); m = agent.model.eval(); tok = agent.tok
q = {"t": "choice", "ins": "x", "crit": {f"opt {i}": f"desc {i}" for i in range(3)}}
seq, mk = build_sequence(tok, "state", q, agent.cfg["max_len"], agent.cfg["head_max_len"])
class W(torch.nn.Module):
    def __init__(s, m): super().__init__(); s.m = m
    def forward(s, i, a, p, k, t):
        lg, act = s.m(i, a, p, k, t); return lg.float(), act.float()
w = W(m).eval()
b = collate_items([[{"ids": seq, "markers": mk, "qtype": QTYPES["choice"]}]], tok.pad_token_id)
names = ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"]
seq_d, opt_d = Dim("seq", min=8, max=2048), Dim("nopt", min=1, max=128)
dyn = {"input_ids": {1: seq_d}, "attention_mask": {1: seq_d},
       "marker_pos": {1: opt_d}, "marker_mask": {1: opt_d}, "qtype": {}}
torch.onnx.export(w, tuple(b[n] for n in names), "/tmp/laya_dec.onnx",
                  input_names=names, output_names=["logits", "act_logits"],
                  dynamo=True, opset_version=21, external_data=True, dynamic_shapes=dyn)
PY
npm run doctor        # 应当显示：决策模型 /tmp/laya_dec.onnx ✓
npm run model:contribution -- --out /tmp/model-contribution.json
```

> 关键点（踩过的）：**必须给动态轴**——dynamo 导出器默认把 dummy 输入的序列长度写死，
> 于是任何别的页面长度都会报 `Got invalid dimensions for input: input_ids`；
> 导完务必用**至少两个不同长度 + 不同选项数**对拍 torch↔onnxruntime（本轮 2.4e-06 … 1.3e-05）。

### 复算 §2.1 的两条计数（无需模型，纯静态）

```bash
# ① 声明行 + step 条目（pack.json / flow.json / sites/*.json 一起数）
node -e '
const fs=require("fs"),path=require("path");let lines=0,steps=0,dirs=0;
for(const d of fs.readdirSync("apps")){const p=path.join("apps",d);if(!fs.existsSync(p))continue;
 const files=[path.join(p,"pack.json"),path.join(p,"flow.json"),
   ...(fs.existsSync(path.join(p,"sites"))?fs.readdirSync(path.join(p,"sites")).map(f=>path.join(p,"sites",f)):[])]
   .filter(f=>fs.existsSync(f)&&f.endsWith(".json"));
 if(!files.length)continue;dirs++;
 for(const f of files){lines+=fs.readFileSync(f,"utf8").split("\n").filter(l=>l.trim()).length;
  const j=JSON.parse(fs.readFileSync(f,"utf8"));
  for(const k of ["journey","steps"]) if(Array.isArray(j[k]))steps+=j[k].length;}}
console.log({dirs,lines,steps});'
# 期望：{ dirs: 21, lines: 3651, steps: 190 }（含用户作用域里录制的那个包时为 22）

# ② 角色模板合并后的"点名了目标"覆盖率
node -e '
const fs=require("fs");let steps=0,hinted=0;
for(const d of fs.readdirSync("apps")){const f=`apps/${d}/pack.json`;if(!fs.existsSync(f))continue;
 const p=JSON.parse(fs.readFileSync(f,"utf8"));const roles=p.roles??{};
 for(const e of p.journey??[]){const m=e.role?{...roles[e.role],...e}:e;steps++;
  if(m.target_hint||m.target_hints)hinted++;}}
console.log({steps,hinted,ratio:hinted/steps});'
# 期望：{ steps: 180, hinted: 169, ratio: 0.9388… }
```

### 复算 §2.3 的判别力数字（读那份 JSON，不再跑模型）

```bash
node -e '
const d=require("/tmp/model-contribution.json");const j=d.rows.filter(r=>r.correct!==null);
const n=j.length,xs=j.map(r=>r.conf),ys=j.map(r=>r.correct?1:0);
const mx=xs.reduce((a,b)=>a+b,0)/n,my=ys.reduce((a,b)=>a+b,0)/n;
const cov=xs.reduce((a,x,i)=>a+(x-mx)*(ys[i]-my),0)/n;
const sx=Math.sqrt(xs.reduce((a,x)=>a+(x-mx)**2,0)/n),sy=Math.sqrt(ys.reduce((a,y)=>a+(y-my)**2,0)/n);
console.log("corr",(cov/(sx*sy)).toFixed(3));
let hit=0,tot=0;const P=j.filter(r=>r.correct),N=j.filter(r=>!r.correct);
for(const a of P)for(const b of N){tot++;hit+=a.conf>b.conf?1:(a.conf===b.conf?0.5:0);}
console.log("AUC",(hit/tot).toFixed(3));
for(const [lo,hi] of [[0,5],[6,10],[11,30]]){const rs=j.filter(r=>r.pool>=lo&&r.pool<=hi);
 const ok=rs.filter(r=>r.correct).length;
 console.log(`pool ${lo}-${hi}: n=${rs.length} acc=${Math.round(100*ok/rs.length)}% conf=${(rs.reduce((a,r)=>a+r.conf,0)/rs.length).toFixed(3)}`);}'
# 期望：corr -0.239 ｜ AUC 0.325 ｜ pool 0-5: n=49 acc=51% conf=0.085 ｜
#       pool 6-10: n=88 acc=6% conf=0.346 ｜ pool 11-30: n=25 acc=40% conf=0.355
```

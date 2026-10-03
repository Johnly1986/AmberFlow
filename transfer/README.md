# 迁移（transfer）：同一套流程，换一个「布局相似的旅游网」

目标的后半句是「**同样流程可泛化并迁移到其他布局相似的旅游网上**」。
这个目录把"迁移"变成可执行、可测量的东西：**流程写进 JSON 配置**，站点差异全部收敛到
"适配器"里（现在也只是配置 + 一个数据生成器），执行器一行不改。

## 1. 流程是配置，不是 Python

```
transfer/specs/*.json   阶段列表（顺序即执行顺序）：每段声明 stage / repeat / steps，
                        每步带 描述模板 / hint(s) / signal / URL 模板 / 自己的 slots
        ↓  transfer/flow.py（加载器：校验 + 占位符替换 + URL 拼装 + 按 repeat 展开）
冻结计划（19–24 个子目标）→ layaapp 的生产循环 → 站点账本 → 独立判分
```

**骨架形状也是配置**。阶段这样写：

```jsonc
{ "phase": "wizard_date",    "stage": "flight", "repeat": "per_date",    "steps": [ … ] },
{ "phase": "wizard_options", "stage": "flight", "repeat": "per_date",    "steps": [ … ] },
{ "phase": "results",        "stage": "flight", "repeat": "per_date",    "steps": [ … ] },
{ "phase": "hotel",          "stage": "hotel",  "repeat": "per_checkin", "steps": [ … ] }
```

`repeat` 只有三种（`once` / `per_date` / `per_checkin`），`stage` 决定它属于"先跑的那段"
还是"依赖出发当日的那段"。**在 `per_date` 上多开一个阶段，就是"两页向导"** ——
加载器不需要知道向导这回事（复刻站 #5 就是这么加出来的）。

- **校验复用 `layaapp` 的 `SIGNAL_OPS`**：信号算子写错、参数个数不对、缺 hint、
  `site_dir` 不存在、占位符写了不存在的名字 —— 加载/展开时立刻报错，而不是跑到第 9 步才发现。
- **证明不是嘴上说的**：`transfer/specs/ctrip.json` 展开出来的 19 个子目标，与
  `ctrip/ctrip_task.py` 里手写的那份**逐字段一致**（`test_config_derived_plan_equals_the_handwritten_ctrip_plan_field_for_field`）。
- **新增一个布局相似的站点 = 一个 spec + 一个数据生成器**，流程代码零改动。
- `--emit-plan <site>` 可以把配置展开成 `TaskPlan` 的磁盘格式（`plan_cli` 能直接 run）。
- **一步可以写多个 hint（`hints`）**：`hints` 是**有序**的，"填日期 → 选时段 → 提交"这种
  表单搜索就是一个子目标三次动作；`hint`（单个）仍是"整段子目标都权威"的旧语义，
  两种写法在同一份配置里共存。
- **一步可以不执行（`when`）**：前置条件在**导航之后、动作之前**判定，不成立就整个子目标跳过
  （不动作、不问模型、记为 `skipped`=已完成）。"同意/促销遮罩只在部分页面出现"这类现实问题用它解决。
- **一步可以重试（`retries`）**：失败后**整步重来**（重新导航 + 重新判 `when` + 重新扫描），
  次数由计划给定；耗尽后才算 BLOCKED、才轮到 replan。用于冷启动/水合竞态这类瞬时失败。
- **一步可以带自己的数据袋（`slots`）**：随子目标变化的值（要填进表单的日期）放这里，
  按 `plan.slots < 子目标 slots` 的优先级合并进执行器，值只来自计划、不来自模型、也不靠描述文本夹带。

**有意留在 Python 里的东西**：站点的**库存生成器**（`ctrip/data.py`、`transfer/data2.py`）和
**独立判分口径**。判分若与流程写在同一份配置里，就不再是"第二实现"，那套自我核对也就没意义了。

## 2. 先测目标站：本环境**没有**匿名可用的 OTA（实测）

`python3 transfer/ota_probe.py` → `results/ota_probe.json`（8 家 × 两种客户端 + 真浏览器渲染）

| 站点 | HTTP 层 | 真浏览器 | 能否当迁移目标 |
|---|---|---|---|
| 携程机票 | 432 `whaleguard block` | 432 | ✗ |
| Trip.com 机票 | 200 挑战页 | 432 | ✗ |
| 去哪儿机票 | 200 | textlen 495、prices 0 | ✗（页面公告：**网页版机票 2026-10-10 起停止提供**）|
| 去哪儿酒店 | 200 | 页脚空壳 | ✗ |
| 同程酒店 | 200 / 236 KB | textlen 1023、prices 0 | ✗ |
| 途牛 / Booking / Agoda / Expedia / Kayak | 202 / 202 / 挑战 / 429 `Bot or Not?` / 人机校验 | — | ✗ |

所以迁移这一步不能靠"再打开一个真实 OTA"证明，只能靠**结构迁移**：
同一份流程，搬到布局不同、同类任务的站点上，只改站点专有的那部分。

## 3. 复刻站 #2（`site2/`）故意长得不一样

| 维度 | 携程复刻站 | SkyBook（迁移目标） |
|---|---|---|
| 界面语言 | 中文 | **英文** |
| 属性约定 | 全是 `data-test` | **id / name / class**（真实站点的常态） |
| 出发时段 / 排序 | 链接（`<a>` + URL 参数） | **`<select>` 下拉**（值来自计划的数据袋） |
| 价格上限 | 链接 | **radio 单选组** |
| 结果形态 | 竖排列表 | **网格卡片**，价格在 `<em class="amount">` 里 |
| 记录方式 | 一个按钮记录最低价 | **先勾选、再提交**（复选 + `select-all`） |
| 结果分页 | 无 | **两页**（≤300 的 15 家：8 + 7） |

## 4. 目录

| 文件 | 作用 |
|---|---|
| `specs/ctrip.json` | 携程复刻站的流程配置（展开后与手写计划逐字段一致） |
| `specs/skybook.json` | 迁移目标的流程配置（23 个子目标） |
| `flow.py` | 配置加载器：校验 / 占位符 / URL 拼装 / 展开 / 迁移度量 |
| `profiles.py` | 只是 `load_spec("ctrip")` / `load_spec("skybook")`，不装站点知识 |
| `transfer_task.py` | 跑迁移：`--site` / `--both` / `--metrics-only` / `--emit-plan` / `--list-sites` |
| `specs/trekly.json` | 第三个站点（**只加配置**加出来的：表格结果 + 滑块价格上限 + 一次记全） |
| `specs/flyquest.json` | 第四个站点：搜索是**表单**（填日期 → 选时段 → 提交），结果页只能靠提交到达 |
| `specs/voyagio.json` | 第五个站点：**两页向导**（第 1 页选日期 → 第 2 页选时段并搜索）—— 形状差异写在阶段列表里 |
| `specs/farehaven.json` | 第六个站点：**促销遮罩只出现在部分日期** —— 用前置条件（`when`）让这一步在该跳过时被跳过 |
| `specs/slowjet.json` | 第七个站点：**摘要页首次访问是冷的** —— 用重试策略（`retries`）把瞬时失败救回来 |
| `data2.py` + `site2/` | SkyBook 的库存与页面（判分口径复用 `ctrip.data` 里与数据集无关的那几个函数） |
| `data3.py` + `site3/` | Trekly 的库存与页面（第三种布局；`<input type=range>` 滑块用执行器的填值路径驱动，实测可行） |
| `data4.py` + `site4/` | FlyQuest 的库存与页面（第四种布局；表单搜索需要执行器的**有序 hint 序列**与子目标级 `slots`） |
| `data5.py` + `site5/` | Voyagio 的库存与页面（第五种布局；两页向导 = 阶段列表里多开一个 `per_date` 阶段） |
| `data6.py` + `site6/` | FareHaven 的库存与页面（第六种布局；部分日期弹遮罩，验证条件子目标 `when`） |
| `data7.py` + `site7/` | SlowJet 的库存与页面（第七种布局；摘要页每个日期首次访问都是冷的，验证 `retries`） |
| `ota_probe.py` + `results/ota_probe.json` | 候选真实站点的可达性实测 |
| `test_transfer.py` | 33 个离线测试：spec 校验/等价性/按角色对齐的度量/五个站点的行为、hint 序列、子目标级数据袋、阶段列表骨架 |
| `TRANSFER_REPORT.md` | **迁移报告**：指标、抓到的问题与修法、滑块结论、边界 |

## 5. 怎么跑

```bash
python3 transfer/transfer_task.py --list-sites        # 有哪些站点 spec
python3 transfer/transfer_task.py --metrics-only      # 只算迁移指标（不开浏览器）
python3 transfer/transfer_task.py --site skybook      # 迁移目标端到端
python3 transfer/transfer_task.py --site trekly       # 第三个站点（只加配置的那个）
python3 transfer/transfer_task.py --site flyquest     # 第四个站点（表单搜索，用有序 hint 序列）
python3 transfer/transfer_task.py --site voyagio      # 第五个站点（两页向导，形状差异全在阶段列表里）
python3 transfer/transfer_task.py --site farehaven    # 第六个站点（条件子目标：遮罩只在部分日期出现）
python3 transfer/transfer_task.py --site farehaven --no-when   # 消融：去掉前置条件 -> 卡在第 6 步
python3 transfer/transfer_task.py --site slowjet               # 第七个站点（重试策略：冷启动摘要页）
python3 transfer/transfer_task.py --site slowjet --no-retries  # 消融：去掉重试 -> 第一个冷页面就 BLOCKED
python3 transfer/transfer_task.py --both              # 所有站点都跑 + 对比
python3 transfer/transfer_task.py --emit-plan skybook # 配置 → 冻结计划 JSON
node --experimental-strip-types tools/transfer-parity.ts      # TS 侧逐例对拍（原 Python 套件见 BACKUP.md）
bash bench/smoke.sh                                   # 回归门（含本目录）
```

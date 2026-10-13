# 接入 JevK5（https://github.com/allebee/jevk5）

> 代码：[src/decision-jevk5.ts](../src/decision-jevk5.ts) ｜ 测试：[tests/decision-jevk5.test.ts](../tests/decision-jevk5.test.ts)（假服务，CI 不需要权重）
> ｜ 选择入口：`--provider jevk5` / `AMBERFLOW_DECISION_PROVIDER=jevk5` / 插件参数 `provider`

## 为什么它接得上

JevK5 与 laya 是**同一类东西**：给一个状态和一道类型化的题，一次前向返回每个选项的概率，不生成 token。
它的 `/v1/systemone` 请求形状与我们的决策缝几乎同构（`jevk5/server.py`）：

```jsonc
// 请求
{ "state": { "goal": "..." },
  "questions": { "act": { "type": "choice", "instructions": "...", "criteria": { "e1": "Add to cart", "e2": "Cart" } } } }
// 响应（`jevk5/prompt.py:answer`）
{ "answers": { "act": { "type": "choice", "choice": "e1", "confidence": 0.62, "probabilities": { "e1": 0.62, "e2": 0.38 } } },
  "usage": { "input_tokens": 10, "output_tokens": 0 }, "latency_ms": 1 }
```

criteria 的 key 就是元素 ref，所以 `ChoiceOutcome.ref` 直接对上；`noul` 头同时供风险与完成投票用。

## 它与 laya 的三个不同（这些差异必须声明，不能抹平）

| | laya（我们的端口） | JevK5 | 后果 |
|---|---|---|---|
| `confidence` 的含义 | `1 − H(p)/log k`（归一化熵） | **`max(p)`** | `score_kind` 分别是 `entropy_conf` / `calibrated_prob`。**跨 provider 比这个数没有意义**——本仓库当年就是把两支 AUC 平均成一个 0.325，得出"闸门系统性反向"的错误结论 |
| 选项数 | 短名单 k=8 重问 | 16 个字母一次读完；更多走 knockout（`ceil(n/16)+1` 次前向 + 第二个温度） | `shortlist: false`；我们不做内部重问，收窄由执行器传子集（`narrow`） |
| 语言 | 有 multilingual checkpoint 可按文字系统路由 | **英文only**（README 明写） | 中文包（`ctrip-case` / `camera-entry` / `qunar-live`）预期显著退化——**这是要测的，不是要假设的** |

另外两个硬约束已在 provider 里处理：choice 至少两个选项（`server.py:normalized` 会 400）⇒
**只剩一个候选时不发请求，直接"结构上没得选"**（`signals` 全 `null`，不是 0）；输入超 16k token 会被拒。

## 怎么起一个真服务

**A. CUDA（4B，~9 GB 显存）**
```bash
pip install "jevk5[fast] @ git+https://github.com/allebee/jevk5@v0.3.0"
jevk5-serve --model alibiserikbay/JevK5 --port 8090
```
**B. llama.cpp / GGUF（CPU、Mac、消费级 GPU）**——4B Q4_K_M 2.71 GB、2B Q8 2.01 GB
```bash
llama-server --hf-repo alibiserikbay/JevK5-GGUF --hf-file jevk5-4b-v0.3-Q8_0.gguf -c 8192 -ngl 99
pip install --no-deps "jevk5 @ git+https://github.com/allebee/jevk5@v0.3.0"
```
（`JevK5GGUF` 读 `llama-server` 的答案字母 log-prob，与 CUDA 同一套读出；README 报 CPU 上 4B 约 0.6 s/次。）

**C. JevK5-Lite（437M DeBERTa，纯 CPU，实验性）**——校准是强项、精度不是：
JevBench 231 公开题上 hard tier 0.405（4B GPU 是 0.739）、p50 71–205 ms（16 线程）。

三种都指向同一个端点形状，我们的 provider 只认 `/v1/systemone`：

```bash
export JEVK5_ENDPOINT=http://127.0.0.1:8090/v1/systemone     # 默认就是这个
npm run apps -- --app camera-entry --provider jevk5
npm run apps:suite -- --provider jevk5                        # 整批语料换模型
```
没起服务时报错会指回这份文档，而不是抛裸栈（`tests/decision-jevk5.test.ts` 钉住）。

## 验收：它必须赢的是基线，不是"没有模型"

`npm run providers:baseline`（[tools/provider-baselines.ts](../tools/provider-baselines.ts)）已经把线画出来了——
在**删掉全部 hint** 的四条旅程上，零智能的 `first-candidate` 过了 **3/4**，而 laya 过 **0/4**：

| 无 hint 旅程 | first-candidate | coin-flip | laya（真 ONNX） | **jevk5** |
|---|---|---|---|---|
| demo-app | ✓ 5/5 | ✗ 2/5 | ✗ 3/5 | **待测** |
| camera-entry | ✓ 4/4 | ✗ 0/4 | ✗ 0/4 | **待测（中文页）** |
| transfer-trekly | ✓ 19/19 | ✗ 0/19 | ✗ 0/19 | **待测** |
| ctrip-case | ✗ 7/19 | ✗ 0/19 | ✗ 10/19 | **待测（中文页）** |

**最后一列我没有数**：这台机器跑不动 JevK5（3.7 GB 内存 / 2 核 / 无 llama.cpp，4B bf16 要 ~9 GB GPU），
所以我交付的是**接好的线 + 钉住的协议 + 一条命令就能测**，而不是一个编出来的成绩。
在有 GPU 的机器上补这张表：

```bash
npm run providers:baseline -- --providers first-candidate,jevk5 --apps demo-app,camera-entry,transfer-trekly,ctrip-case
```
（`tools/provider-baselines.ts` 目前跑的是内置基线；`jevk5` 需要 `JEVK5_ENDPOINT` 在场。
 若你要我把这一格也自动化，说一声——那是给对照台加一个"provider 需要外部服务"的就绪探测。）

判据写死在这里，免得事后各说各话：

1. **`jevk5` 在拉丁语系包上必须 ≥ `first-candidate`**，否则它不该进关键路径；
2. **中文包上单独记账**，不许和拉丁包平均（英文only 是可测的退化，不是噪声）；
3. 换 provider 时 `hint 覆盖 / 声明解决` 两行不变——那才是这套系统真正的承重证据；
4. 任何"某模型更好"的结论都要同时给出它的**咨询数与耗时**（遍历型基线靠多问，代价要摊开）。

## 接入它时抓到的两个真 bug（这是"必须有第二个实现"的实证）

**① `isRisky`/`isDone` 根本没走 provider。** Stage 2 我只把 `pick` 改道，风险/完成两处只加了
"能力跳过"的守卫，于是注册型 provider 落回旧路径读 `this.agent`（那里是 `null`）⇒
`TypeError: Cannot read properties of null (reading 'predict')`，而且**把每个有 hint 的步一起打红**
（风险闸门在 pick 之后跑，规则决定的步同样要过它）。
最该记住的是**它怎么躲过测试的**：三个内置基线恰好都声明 `risk: false`，走的是"跳过"分支，
所以 1116 条测试全绿。是覆盖面放过了它，不是代码对。
→ 回归：[tests/decision-provider-executor.test.ts](../tests/decision-provider-executor.test.ts)（3 条：
掉线要降级并记录、降级时关键词仍拦得住不可逆动作、provider 的数字真的驱动闸门）。

**② 一个外部 provider 掉线，会让整条计划失效——包括不需要它的那些步。**
修法是**降级而不是失败**：风险头调用失败 ⇒ 退回确定性关键词规则，并把原因写进
`<app>-result.json.risk_degraded`、报告一行 ⚠、套件汇总一行。
两条边界都是刻意的：**不静默当成"不危险"**（那等于掉线解锁安全闸门），
也**不让它把 hint 决定的步一起打红**（"点了名的计划不需要模型也能跑"是本仓库明写的承重性质）。

## 与既有结论的关系

- 这次接入本身就是 provider 层的第一个外部客户，它验证了抽象的两条设计：
  **`score_kind` 必须存在**（两家 `confidence` 同名不同义）、**能力必须自报**（JevK5 不做 k=8 重问）。
- 它**不改变** W0 的结论（"换统计量救不了闸门"）：那一测的是 laya 的分布形状；
  JevK5 的分布是否更可分，是同一份分析（`npm run gate:signals`）换一份产物就能问的问题——但要先有真服务。
- 它**不改变**"声明在承重"：`--provider` 换的是兜底层，`hint 覆盖 98.8% / 声明解决 100%` 那两行与它无关。

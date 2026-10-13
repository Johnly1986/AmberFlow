# 决策接口横评：`shape / pTop1 / pTop2 / margin` 是通用接口，还是 laya 独有？

> 起因：项目方认可"闸门按问法分档"这个方向，但要求先说清**这些信号是市面上决策模型的通用接口，
> 还是 laya 的私有形状**——因为如果只有 laya 给得出，那这个设计就是把架构焊死在一个模型上，
> 而"换决策提供者不动上层"是本项目自己的红线。
>
> 证据来源：本机 `laya` 0.3.5 包源码（逐行）、browser-use 的 system prompt（原文）、
> Mind2Web/MindAct 论文（原文）、以及**本仓库自己早就做过的一次 margin 测量与否定**（CLAUDE.md）。

## 0. 一句话结论

**"把页面变成一份枚举候选、让模型选一个"是市场通用形状；"每个候选上的概率分布"不是。**
`shape`（问法形状）与"弃权"是通用的；`pTop1/pTop2/margin` 只在**评分式**选择器上免费存在
（laya 的 choice 头、MindAct 的小 ranker），在**生成式** agent（browser-use、各家 computer-use、
多模态 GUI 大模型）上要么没有、要么只是 per-token logprob——那不是同一个东西。

而最关键的一条发现是：**`confidence` 在 laya 里就是 `1 − H(p)/log k` 这个派生统计量，
而 laya 自己的温度标定本来就是按选项数分桶的**（`2 / 3-5 / 6-10 / 11+`）。
所以"按问法分档"**不是我们发明的外来概念，是我们的闸门把 provider 已经分好的桶压成了一个全局 floor**。

## 1. 这四个东西分别是什么（本机 laya 源码为证）

`laya/agent.py` 的 choice 分支（原文，节选）：

```python
t_scale = self.temperature_by_options.get(temp_bucket(qt, k), self.temperature[qt])
z = logits[r, :k] / t_scale            # ← 按 (问题类型, 选项数桶) 标定
p = np.exp(z - z.max()); p = p / p.sum()
conf_score = round(confidence_from_probs(p, k), 4)
answers[qid] = {"type": "choice", "choice": keys[int(p.argmax())],
                "probabilities": {...}, "confidence": conf_score}
```

`laya/common.py`：

```python
def confidence_from_probs(p, k):        # 归一化香农熵置信度
    return float(np.clip(1.0 - (-(p*np.log(p)).sum()) / math.log(k), 0.0, 1.0))
def temp_bucket(qtype, k):              # "choice:11+" / "choice:6-10" / "noul:3-5" …
    size = "2" if k <= 2 else "3-5" if k <= 5 else "6-10" if k <= 10 else "11+"
```

| 信号 | 定义 | 通用性 |
|---|---|---|
| `shape`（选项数 k、是否短名单重问、池子大小） | 提问的**结构** | **通用**——任何"从枚举候选里选一个"的系统都有 |
| `pTop1` | 最大概率 | 需要 provider 给**分布**；否则只能自造（逐选项打分 = N 次前向） |
| `pTop2` | 次大概率 | 同上，且要求候选是**并列**的（生成式模型里没有"次优动作"这个对象） |
| `margin = pTop1 − pTop2` | 分离度 | 选择性预测（selective prediction / abstention）里的**标准方法之一**，与 max-prob、熵、校准后置信度并列——**方法是通用的，输入不是** |
| `confidence = 1 − H/log k` | laya 出厂的派生统计量 | laya 的**选择**，不是物理定律；同一份 `p` 上 margin/max-prob 都免费 |

**推论**：我们没有任何理由认为 `confidence` 是唯一可用的读数——但它确实是**目前唯一被闸门读的那个**。

## 2. 市场对照

| 系统 | 候选怎么给 | 选的方式 | 有没有 per-candidate 概率 | 有没有弃权 |
|---|---|---|---|---|
| **laya**（我们用的） | criteria 字典（枚举） | 一次前向 ⇒ 分布 + argmax | **有**（softmax over options，且按 k 分桶标定） | 低置信 ⇒ 上层 block |
| **browser-use** | `[33]<button>Submit Form</button>` 编号列表 | 生成 JSON `{"click_element":{"index":33}}` | **没有**——输出 schema 里根本没有概率字段；自评是文本 `"Success\|Failed\|Unknown"`（verbalized，未校准，且评的是**上一步**） | "若没有合适元素就用别的函数"（提示词层，不是信号） |
| **OpenAI / Anthropic computer-use 类** | 截图 + 动作空间 | 自回归出**坐标/动作** | **没有**（闭源 API 不给；即便给 logprobs，也是 **per-token over 词表**，不是 per-candidate over 你那 40 个元素） | 无内建 |
| **Mind2Web / MindAct**（学术主流形状） | ① 小 ranker（DeBERTa 交叉编码器）对**每个元素**打分 → top-k；② 把 top-k 拼成**多选题**给 LLM | ②阶段生成选项，**含一个 None 选项**，选中多个就**重新分组再问** | ①阶段**有**（matching score）；②阶段无 | **有，且是接口的一部分**（None + 迭代分组） |
| **多模态 GUI 大模型**（UI-TARS / CogAgent / AutoWebGLM 一类） | 截图 / SoM 标号 / a11y 树 | 生成坐标或选项字母 | 一般不暴露（开源权重可取 logits，但不是"对候选集归一的分布"） | 靠反思/重试，不是阈值 |

出处：[browser-use 的 system prompt 原文](https://raw.githubusercontent.com/browser-use/browser-use/5f84512d74bd8b6f8dafe188b234c12e1833b63b/browser_use/agent/system_prompt.md)、
[Mind2Web / MindAct 论文](https://ar5iv.labs.arxiv.org/html/2306.06070v3)（§3.1 候选排序、§3.2 多选 QA + None + 重新分组）、
本机 `laya` 包源码。

**两点值得抄的**（都不是 laya 私有）：
1. MindAct 的**两段式**（先小 ranker 收窄、再让大模型在小集合里选）——这正是我们"窄问"的市场版本，
   而且它的收窄器是**确定性打分器**，不是模型；我们的对应物是 hint 分层 + `hintCandidates`。
2. **None 是一等选项**——把"弃权"放进候选集，而不是靠事后阈值拦。这比我们现在"低置信 break"更干净。

## 3. 反证据（必须摆出来，否则这份分析就是推销）

**本仓库早就测过 margin，并且把它否掉了。** CLAUDE.md 里那条 `C3-R's top-two margin does NOT transfer`
记着：live pack 关掉规则面跑出的 70 次模型选择里，**坏选的中位 margin（0.348）比好选（0.263）还高**，
最差的一次错选 margin 0.942；任何能拦住东西的阈值都会毁掉更多好选（t=0.15 拦 1/5 坏、赔 17/39 好）。

而我本轮在 demo-app 上看到的却是分离的：错的两步 margin 0.031/0.062，对的两步 0.538/0.852。

这两件事**不矛盾，但也没被调和**——可能的差别在：分支不同（passthrough vs 短名单重问）、
任务不同（"没规则时选导航链接"vs"有 hint 落空后选按钮"）、样本量（4 行 vs 70 次）。
⇒ **这条 2026-10-13 已被 W0 判定：老结论成立，我的 4 行印象是噪声。**

## 3b. W0 实测（同一份 162 步，三个信号同台，`npm run gate:signals`）

冻结语料：`bench/w0-model-contribution.json`（172 行逐题实测，含 `shape/pTop1/pTop2/margin`）；
分析：`tools/gate-signals.ts` → `bench/w0-gate-signals.json`；回归：`tests/gate-signals.test.ts`。

| 信号 | 全量 AUC | **同 coverage（采纳 75 步）precision** | 桶 3-5 AUC | 桶 6-10 AUC |
|---|---|---|---|---|
| `confidence`（现状，1−H/log k） | 0.325 | **14.7%**（对 11） | 0.48 | 0.533 |
| `pTop1` | 0.34 | 8%（对 6） | 0.518 | 0.326 |
| `margin` | 0.306 | 12%（对 9） | 0.392 | 0.359 |

三条读数：

1. **换信号没有收益**：在同一采纳量下，现状的 `confidence` 反而是三者里最好的（14.7% > 12% > 8%）。
   我原先的假设"闸门读错了统计量"**被数据否掉**。
2. **"闸门系统性反向"是混合假象**：分桶后 `confidence` 的 AUC 是 0.48 / 0.533（≈掷硬币），
   不是聚合的 0.233。**分档确实去掉了一个吓人的错误结论**——但去掉之后剩下的不是"好信号"，
   而是"三个信号都不区分对错"。
3. **margin 的否证与仓库早年的 C3-R 测量一致**（全部 < 0.5）——这条现在两边对上了。

**由此改写的结论**（覆盖 §6 里"方向通用、信号待测"的那句）：
- **改问法有用**（窄问 14/14 vs 全池 3/14，它改变的是**正确率**）；
- **改统计量没用**（三个信号测过了）；
- 所以"信不信模型"**不能靠分数决定**，只能靠**爆炸半径**决定：候选集小 + 动作非破坏性 ⇒ 接受，
  事后由该步自己的完成信号裁决（这本来就是循环的默认）。
- 反过来，池子大的问题（40 选 1、25% 正确率、无法自报把握）**仍然无解**：只能 block 或问人
  （`escalate`，需要端点）。**"运行期弹性"这个主张到今天为止依然没有被任何数字支持。**

## 4. 设计结论：把缝写成 provider 无关的，而不是把 laya 的形状当标准

```
Proposal {
  candidates: [{ref, rank, prob?}]        // rank 必有；prob 只在 provider 能给时填
  shape: {kind: full|shortlist|narrow, k, poolSize}
  available_signals: ("rank"|"prob"|"margin"|"entropy")[]   // ← provider 自报家底
  abstain?: ref                            // 弃权是一等候选（抄 MindAct 的 None），不是事后拦截
}
Gate 按 (shape.kind, k 桶) 分档读——桶的切法直接对齐 provider 自己的标定粒度（2 / 3-5 / 6-10 / 11+）
```

三条硬要求：

1. **`prob` 缺失时 `margin` 必须是 `null`，不许当 0**（0 会被任何阈值判成"最没把握"，
   等于把"provider 不给概率"伪装成"模型很不确定"——这是最容易犯、也最难发现的错）。
2. **换 provider 不许动上层**：`pickProposal` 是执行器内部的形状，`LayaRuntime` 才是对外缝；
   接第二个 provider 时它只需回答"我能给哪些信号"。
3. **分档的粒度跟着 provider 走**，不是我们自己拍：laya 已经按 `2/3-5/6-10/11+` 标定温度，
   我们的闸门读同一个桶才是自洽的；browser-use 那类只有 rank 的，就只能在 rank 上定档（例如"top-1 与 top-2 是否同标签兄弟"）。

## 5. 迁移矩阵（如果明天换掉 laya，这些字段还剩什么）

| 字段 | laya | MindAct 式（ranker + 多选 LLM） | browser-use 式（纯生成） | 结论 |
|---|---|---|---|---|
| `shape.k / poolSize` | ✅ | ✅ | ✅ | **通用**，可以依赖 |
| `choiceRef` | ✅ | ✅ | ✅ | 通用 |
| `pTop1 / pTop2 / margin` | ✅ | 仅 ranker 阶段有分数 | ❌ | **不可依赖**，必须声明可用与否 |
| `confidence = 1−H/log k` | ✅（出厂定义） | ❌ |  | **laya 私有**，只能当诊断 |
| `abstain` | 我们事后 block | ✅ None 选项 | 提示词层 | 应改成**一等公民**（抄 MindAct） |
| 按 k 分桶的标定 | ✅（provider 自带） | ❌（要自己标） | ❌ | 分档这件事在 laya 上几乎免费，在别处要自建 |

## 6. 这对"要不要立项 W4"意味着什么

- **"按问法分档"这个方向是 provider 无关的**：它依赖的只有 `shape`（通用）和"不同 k 上分数不可比"
  （laya 自己已经这么标定，其它 provider 需要自己标定——但那是**它们**的工作，不是我们的假设）。
- **具体读哪个信号还没定**，而且**不该现在拍**：等 §3 的插桩测量出来。
  如果 margin 在两支上都不优于 `confidence`，那 W4 就只剩"分档 + 弃权一等化"，收益要重估。
- 换句话说：**"分档"这个动作是 provider 无关的，但"分档之后读什么"这件事，W0 已经给出答案——
  读什么都不行**。所以分档保留（它去掉了"反向"的假象），但**不要指望换一个数就能信模型**；
  能信的依据只能是"错了会怎样"，不是"它多有把握"。（见 §3b。）

> 复算：本机 `python3 -c "import laya,inspect;print(inspect.getsource(laya.confidence_from_probs))"`；
> 分桶见 `laya/common.py:temp_bucket`；choice 答案构造见 `laya/agent.py`（`t_scale` 那一段）。
> 我们侧的两把尺子见 `src/laya-onnx.ts:predictShortlist` 与 `src/executor.ts:pickInner`
> （passthrough 用 `a.confidence`，短名单用 `max(probs)`）。

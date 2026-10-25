# 本地 laya-onnx vs 线上 token-plan：无 hint 逐应用对比（2026-10-25）

> 目的：同一批应用、同一命令、**剥掉全部计划 hint**（`--without-hints`）后，比较
> 本地 ONNX 决策模型与线上 token-plan 决策模型的逐应用表现。这是"模型被迫做每一个选择"
> 的对抗性口径——正常使用中 hint/规则先行，模型只在兜底时出场（见文末"怎么读"）。

## 0. 本地模型产物安装

1. 候选产物（此前遗留于 `/tmp`，与仓库同文件系统）：

   | 文件 | 大小 |
   |---|---|
   | `/tmp/laya_dec.onnx`（图） | 3.0 MB |
   | `/tmp/laya_dec.onnx.data`（外置权重） | 1.6 GB |

2. 安装到仓库默认落点（`/models/` 在 `.gitignore` 里，不会入库）：

   ```bash
   mkdir -p models
   mv /tmp/laya_dec.onnx      models/laya_dec.onnx
   mv /tmp/laya_dec.onnx.data models/laya_dec.onnx.data
   ```

3. tokenizer 由 HF 缓存自动发现（`~/.cache/huggingface/hub/models--convaiinnovations--laya/…/tokenizer`），
   无需额外配置。装好后 `amber doctor` 输出：

   ```
   决策模型     /root/coding/AmberFlow/models/laya_dec.onnx  ✓ 真模型（图 + 权重 + tokenizer 齐）
   ```

   之后不带 `LAYA_ONNX_MODEL` 也能用本地模型（用户配置默认 provider 仍是 `token-plan`，
   本次对比显式传 `--provider`）。

## 1. 方法

- 应用（5 个离线、声明式数据脚本；覆盖 web-only、混合 web+cli、数据腿、冷启动重试）：

  `demo-app`、`ip-config`、`camera-entry`、`checkin-binding`、`transfer-slowjet`

- 每个应用 × provider 跑一次，唯一差异是 `--provider`：

  ```bash
  amber run <app> --without-hints --provider laya-onnx  --out /tmp/ab/laya-onnx/<app>
  amber run <app> --without-hints --provider token-plan --out /tmp/ab/token-plan/<app>
  ```

- `--without-hints` = **在内存里剥掉计划点名**，规则层仍可命中（比如唯一 affordance 规则）；
  剥不掉规则命中时，每一步都必须由模型选择。
- 指标取各自 `<app>-result.json`：完成步数、不变量、`model_asks`/`model_steps`
  （`asked_not_passed` = 问了但置信度没过闸门）、置信度区间、耗时、本地决策缓存命中。

## 2. 逐应用结果

| 应用 | provider | ok | 完成 | 不变量 | 咨询 | 执行 | 未过闸门 | conf | 耗时 | 缓存(命中/前向) |
|---|---|---|---|---|---|---|---|---|---|---|
| demo-app | laya-onnx | ✗ | 3/5 | 1/2 | 12 | 6 | 6 | 0.261–0.746 | 47.9 s | 8/25 |
| demo-app | token-plan | ✓ | 5/5 | 2/2 | 4 | 4 | 0 | 0.74–1.00 | 12.0 s | — |
| ip-config | laya-onnx | ✗ | 4/8 | 1/3 | 4 | 0 | 4 | — | 29.8 s | 0/12 |
| ip-config | token-plan | ✓ | 8/8 | 3/3 | 4 | 4 | 0 | 0.60–0.76 | 18.6 s | — |
| camera-entry | laya-onnx | ✗ | 0/4 | 1/3 | 4 | 0 | 4 | — | 34.6 s | 0/10 |
| camera-entry | token-plan | ✓ | 4/4 | 3/3 | 7 | 7 | 0 | 0.36–1.00 | 22.9 s | — |
| checkin-binding | laya-onnx | ✓ | 1/1 | 2/2 | 0 | 0 | 0 | — | 12.7 s | 0/2 |
| checkin-binding | token-plan | ✓ | 1/1 | 2/2 | 0 | 0 | 0 | — | 7.2 s | — |
| transfer-slowjet | laya-onnx | ✗ | 0/19 | 1/3 | 35 | 11 | 24 | 0.286–0.812 | 181.7 s | 0/81 |
| transfer-slowjet | token-plan | ✓ | 19/19 | 3/3 | 65 | 60 | 5 | 0.22–1.00 | 171.9 s | — |

**汇总：本地 1/5 通过；线上 5/5 通过。**

本地模型的失败都发生在**第一步/前几步就被置信度闸门挡住**（不是"点错后卡住"）：

| 应用 | 首个 blocked 子目标 | obstacle |
|---|---|---|
| demo-app | 打开购物车页 | `low confidence 0.17 < floor 0.25 on step 1` |
| ip-config | 把规划的 IP / 子网掩码 / 网关保存到 CAM-1001 | `low confidence 0.15 < floor 0.25 on step 1` |
| camera-entry | 按规划表录入 CAM-1001（枪机）… | `low confidence 0.01 < floor 0.25 on step 1` |
| transfer-slowjet | 从 SlowJet 首页进入机票搜索页（昆明 → 北京） | `low confidence 0.06 < floor 0.25 on step 1` |

线上 token-plan 在每个应用上都能给出过闸门的置信度（0.36–1.00），包括中文页面
（`camera-entry` 0.36 起、`transfer-slowjet` 0.22–1.00 且 60 步过闸门）。

## 3. 怎么读这组数

1. **这是对抗性口径**：正常运行中 `target_hint`/规则/数据腿先行，模型只在"规则化不了"时出场；
   剥掉 hint 后，本地 laya 在 fixture 任务上从第一步就低置信（0.01–0.17），线上模型仍能过闸。
2. **本地模型是真实可用的**：`model_status=on`、`provider=laya-onnx`、12 次真实咨询、决策缓存命中
   8/25（同页重复提问被缓存）；它失败时是**响亮 blocked**（低置信 + obstacle），不是假绿。
3. **线上模型明显更强**（本批无 hint 任务）：同一批任务 1/5 → 5/5；本地在 `camera-entry` 上
   置信度 0.01，几乎等于随机；线上在中文表单上 0.36 起。
4. **checkin-binding 两个 provider 都是 0 咨询通过**：它只有 1 步且规则/唯一 affordance 可解，
   与模型能力无关——这也说明"模型出场"必须由真实任务形状决定，而不是强制每步提问。

## 4. 边界与后续

- **单次运行**：每个格子只跑一次；本地有决策缓存（同页重复提问会命中，命中不计前向），
  线上没有该缓存。浏览器/网络抖动未做重复试验，结论按"本机这一次"读。
- **成本未计量**：线上 43 次模型咨询（4+4+7+0+65 中的过闸/咨询合计 80 次请求）的 token/费用与
  延迟未统计；线上单次耗时含网络往返（demo-app 12 s vs 本地 47.9 s，主要差在本地 CPU 前向）。
- 想提升本地模型在本口径下的表现，下一步应做：换 `multilingual` checkpoint（中文页）、
  校准/微调、或把 `--without-hints` 的闸门策略作为消融继续研究；而不是调低 floor 制造假绿。
- 复现：

  ```bash
  npm run model:fetch -- --from models/laya_dec.onnx   # 或按本文件 §0 安装
  amber run demo-app --without-hints --provider laya-onnx
  amber run demo-app --without-hints --provider token-plan
  ```

  批量脚本：`/tmp/ab-run.sh`（本次临时脚本，逻辑即 §1 的两条命令 × 5 应用）。

## 5. multilingual checkpoint 尝试（2026-10-25）

### 5.1 为什么不是"装一个现成 ONNX"

HF 仓库 `convaiinnovations/laya` 只提供 **safetensors**（英文根目录 + `multilingual/` 子目录 +
`typed-decisions/` 子目录），**没有任何 ONNX 文件**；本仓库的本地 ONNX 端口只认
`models/*.onnx` + `.onnx.data`（生产也只加载一份权重，`--model multilingual` 不切权重——这一点
`docs/DECISION_MODEL_PURPOSE_REVIEW.md` 早有记录）。所以先按 POC 记录的口径自己导出了一份。

### 5.2 导出与校验（一次性、本机）

- 用已安装的 `laya 0.3.5` 加载 `multilingual` 权重（ModernBERT 编码器 + 2 层决策头），
  `torch.onnx.export(dynamo=True, opset_version=21, external_data=True)` 导出；
- I/O 契约与英文图完全一致：`input_ids [1,seq] i64 · attention_mask [1,seq] i64 ·
  marker_pos [1,nopt] i64 · marker_mask [1,nopt] bool · qtype [1] i64` →
  `logits [1,nopt] f32 · act_logits [1,2] f32`（seq/nopt 动态）；
- 数值对拍（torch vs onnxruntime）：**logits max|diff| 1.19e-05，act_logits 9.0e-03**；
- 产物：`models/laya_dec_multilingual.onnx`（5.7 MB）+ `.data`（1.2 GB），均在 `.gitignore` 的
  `models/` 下，**未入库**；
- 运行方式（tokenizer 必须显式指向多语言目录；config 会从同一层目录的 `rl_agent_config.json` 读到）：

  ```bash
  LAYA_ONNX_MODEL=$PWD/models/laya_dec_multilingual.onnx \
  LAYA_TOKENIZER_DIR=~/.cache/huggingface/hub/models--convaiinnovations--laya/snapshots/*/multilingual/tokenizer \
  amber run camera-entry --without-hints --provider laya-onnx --checkpoint multilingual
  ```

### 5.3 引擎修复：多语言 tokenizer 的特殊 token

第一次跑 multilingual 时报告 `tokenizer … has no [CLS] token id` → provider 退化 rules-only。
原因：英文 checkpoint 的 tokenizer 用 BERT 风格 `[CLS]/[SEP]/[MASK]/[PAD]`，multilingual
（ModernBERT）用 `<bos>/<eos>/<mask>/<pad>`（其 tokenizer_config 把 cls/sep 映射到 bos/eos）。
已给 `LayaTokenizer.fromDir` 加同义回退（先同名、再按 checkpoint 家族），并保持错误消息点名。
改动在 `src/model/laya-onnx.ts`，英文图行为不变。

### 5.4 结果（no-hint 同一批 CJK 应用；对照 §2 的英文本地模型）

| 应用 | 本地英文 laya | 本地 multilingual laya |
|---|---|---|
| camera-entry | ✗ 0/4，1/3 不变量；咨询 4 / 执行 0；conf —；34.6 s | ✗ **1/4**，1/3；咨询 6 / **执行 3**；conf **0.217–0.379**；22.9 s |
| ip-config | ✗ 4/8，1/3；咨询 4 / 执行 0；conf —；29.8 s | ✗ 4/8，1/3；咨询 4 / 执行 0；conf —（最高 0.16 仍低于闸门）；11.5 s |

- **多语言确实换成了另一套权重/分词器**（同样的输入契约，camera-entry 的决策执行数 0→3、
  置信度从不可用变为 0.217–0.379；`model_status=on`、无 provider 降级）。
- 但在这批**剥掉 hint** 的 CJK 夹具上，它仍不足以过 0.25 的置信闸门（camera-entry 首步 0.12），
  与 token-plan（0.36–1.00）差距明显。**结论：multilingual 是可用的一档本地备选，不是
  "换个模型就能替代线上"**；不要为此调低 floor。
- **正常路径（带 hint）下 multilingual 是安全的替换**：camera-entry 4/4、3/3 不变量、0 咨询、16.9 s
  通过——模型只在规则/hint 兜不住时才出场，这正是产品要的分工。

### 5.5 边界

- 这份 multilingual ONNX 是**本机自行导出**（官方仓库没有 ONNX），未随仓库分发；换机需按 §5.2 重导。
- 版本：`laya 0.3.5` / `torch 2.11.0+cpu` / `onnx 1.23.1` / `onnxruntime 1.30.0`；导出器为
  `dynamo=True, opset 21`——与仓库 POC 记录（`node-port-poc/README.md`）一致。
- 单次运行；未做 multilingual 的置信校准/温度重拟合，也不建议在生产里用未校准的本地 conf 决策。

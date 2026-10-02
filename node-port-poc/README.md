# laya-on-Node.js 概念验证（2026-10-03 实测）

## 结论
laya（421M，ModernBERT-large 编码器 + 2 层决策头）**可以在 Node.js 平台启动**，
且决策输出与 Python 运行时数值一致。

## 验证链（本机 CPU 实测）
1. `torch.onnx.export`（dynamo 导出器，opset 21，68s）→ `laya_dec.onnx`（3.1MB 图 + 1.69GB fp32 权重）；
2. Python ORT vs torch：logits max|diff| **3.7e-06**；
3. Node.js（node v22 + onnxruntime-node + @huggingface/transformers）：
   - AutoTokenizer 直接读 HF 缓存里的 `tokenizer.json`（框架无关格式）；
   - `build_sequence` 的 JS 移植（laya.mjs）产出的 token 序列与 Python **逐 id 一致**；
   - ONNX 推理 → 温度分桶 softmax → 归一化熵置信度：
     probs max|diff| **2.98e-5**（0.8143/0.0265/0.1316/0.0275，argmax 语义正确），
     confidence 0.546 == 0.546，CPU 推理 921ms（Python 0.5–1s，同量级）。

## 复现
```bash
cd node-port-poc && npm install onnxruntime-node @huggingface/transformers
# 需要 /tmp/laya_dec.onnx(+.data) 与 /tmp/laya_parity_ref.json（由导出/对拍脚本生成）
node laya.mjs
```

## 移植注意点（实测踩过的）
- `serialize_state` 必须复刻 Python `json.dumps` 的默认分隔符 `", "`/`": "`（token 数敏感）；
- 特殊 token id 从 tokenizer.json 的 added_tokens 取（transformers.js 属性映射不全）；
- dynamo 导出器会写外部权重文件（.onnx.data），onnxruntime 按同目录自动加载；
- opset 必须 ≥21（新导出器的 Split 用 `num_outputs` 属性）；
- 温度分桶/`clamp_temperature`/`confidence_from_probs` 是纯数学，直接移植。

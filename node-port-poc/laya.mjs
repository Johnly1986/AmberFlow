// laya 在 Node.js 平台的端到端验证：
//   tokenizer.json（@huggingface/transformers）+ build_sequence 的 JS 移植
//   + onnxruntime-node 推理 + 温度分桶/置信度后处理
// 输出与 Python 参考(/tmp/laya_parity_ref.json)对拍。
import fs from "node:fs";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { AutoTokenizer } from "@huggingface/transformers";

const ref = JSON.parse(fs.readFileSync("/tmp/laya_parity_ref.json", "utf-8"));
const TOK_DIR = "/root/.cache/huggingface/hub/models--convaiinnovations--laya/snapshots/55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851/tokenizer";

// ---- build_sequence 的忠实移植（laya/common.py:49-86）----
function renderCriterion(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}
function renderOptions(q) {
  if (q.t === "choice") return Object.entries(q.crit).map(([k, v]) => (v == null || v === "" ? k : `${k}: ${renderCriterion(v)}`));
  if (q.t === "score") return q.crit.map((c, i) => `level ${i}: ${renderCriterion(c)}`);
  return ["false: no, the statement does not hold", "true: yes, the statement holds"];
}
// serialize_state 的 Python 兼容实现：json.dumps(state, ensure_ascii=False)
// 的默认分隔符是 ", " / ": "（带空格）——这影响 token 数，必须一致
function serializeState(state) {
  if (typeof state === "string") return state;
  return "{" + Object.entries(state).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}";
}
function buildSequence(tok, state, q, maxLen = 512, headMaxLen = 192) {
  const mask = "[MASK]";
  const opts = renderOptions(q);
  const enc = (s) => Array.from(tok(s, { add_special_tokens: false }).input_ids.data);
  const ins = String(q.ins).replaceAll(mask, " ");
  let headIds = enc(`${q.t} question: ${ins}`);
  const optIds = opts.map((o) => [MASK, ...enc(` ${o.replaceAll(mask, " ")}`).slice(0, 48)]);
  let optBudget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  if (optBudget < 16) {
    const per = Math.max(4, Math.floor((headMaxLen - 16) / Math.max(1, optIds.length)));
    optIds = optIds.map((o) => o.slice(0, per));
    optBudget = headMaxLen - optIds.reduce((a, o) => a + o.length, 0);
  }
  headIds = headIds.slice(0, Math.max(8, optBudget));
  const stateStr = serializeState(state).replaceAll(mask, " ");
  let ids = [CLS, ...headIds, SEP];
  const markers = [];
  for (const o of optIds) { markers.push(ids.length); ids = ids.concat(o); }
  ids.push(SEP);
  const room = Math.max(0, maxLen - ids.length - 1);
  const st = enc(stateStr).slice(0, room);
  ids = ids.concat(st, [SEP]);
  return { ids: ids.slice(0, maxLen), markers: markers.filter((m) => m < maxLen) };
}

// ---- 主流程 ----
const tok = await AutoTokenizer.from_pretrained(TOK_DIR);
const spec = JSON.parse(fs.readFileSync(TOK_DIR + "/tokenizer.json", "utf-8"))
  .added_tokens.filter((a) => a.special).reduce((m, a) => ((m[a.content] = a.id), m), {});
const CLS = Number(tok.cls_token_id ?? spec["[CLS]"]);
const MASK = Number(tok.mask_token_id ?? spec["[MASK]"]);
const SEP = Number(tok.sep_token_id ?? spec["[SEP]"]);
console.log("special ids: CLS", CLS, "MASK", MASK, "SEP", SEP);
const q = { t: "choice", ins: ref.text.ins, crit: Object.fromEntries(ref.text.crit.map((k) => [k, null])) };
const { ids, markers } = buildSequence(tok, ref.text.state, q);
console.log("node seq len:", ids.length, "markers:", markers.length);
console.log("token ids == python:", JSON.stringify(ids.map(Number)) === JSON.stringify(ref.ids) ? "YES" : "NO");
ids.forEach((t, i) => {
  if (Number(t) !== ref.ids[i]) {
    console.log(`首个差异 @${i}: node=${Number(t)} python=${ref.ids[i]}`);
    console.log(`上下文 node: ${ids.slice(Math.max(0, i - 4), i + 3).map(Number)} | py: ${ref.ids.slice(Math.max(0, i - 4), i + 3)}`);
  }
});

const session = await InferenceSession.create("/tmp/laya_dec.onnx", { providers: ["cpu"] });
const L = ids.length, K = markers.length;
const feeds = {
  input_ids: new Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, L]),
  attention_mask: new Tensor("int64", BigInt64Array.from({ length: L }, () => 1n), [1, L]),
  marker_pos: new Tensor("int64", BigInt64Array.from(markers.map(BigInt)), [1, K]),
  marker_mask: new Tensor("bool", Uint8Array.from({ length: K }, () => 1), [1, K]),
  qtype: new Tensor("int64", BigInt64Array.from([0n]), [1]),
};
const t0 = Date.now();
const { logits } = await session.run(feeds);
const inferMs = Date.now() - t0;

// 温度分桶 + clamp + softmax + 归一化熵置信度（common.py:219-240, 210-216）
const k = K;
const bucket = `choice:${k <= 2 ? "2" : k <= 5 ? "3-5" : k <= 10 ? "6-10" : "11+"}`;
const T = Math.min(5.0, Math.max(0.5, bucket === "choice:3-5" ? 1.7601518630981445 : 1.0));
const arr = Array.from(logits.data).slice(0, k);
const mx = Math.max(...arr.map((x) => x / T));
const exps = arr.map((x) => Math.exp(x / T - mx));
const sum = exps.reduce((a, b) => a + b, 0);
const probs = exps.map((e) => e / sum);
const ent = -probs.reduce((a, p) => a + p * Math.log(Math.max(p, 1e-12)), 0);
const conf = Math.min(1, Math.max(0, 1 - ent / Math.log(k)));

const pyProbs = ref.probs;
const maxDiff = Math.max(...probs.map((p, i) => Math.abs(p - pyProbs[i])));
console.log("node probs:", probs.map((p) => +p.toFixed(4)).join(", "));
console.log("python probs:", pyProbs.map((p) => +p.toFixed(4)).join(", "));
console.log("probs max|diff| node-vs-python:", maxDiff.toExponential(2));
console.log("confidence:", +conf.toFixed(4), "(python:", +ref.conf.toFixed(4) + ")");
console.log("argmax:", probs.indexOf(Math.max(...probs)), "| inference:", inferMs, "ms");
console.log(maxDiff < 1e-4 ? "\nVERDICT: laya 在 Node.js 成功启动且决策与 Python 一致" : "\nVERDICT: 存在数值偏差，需排查");

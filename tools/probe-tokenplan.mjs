// 探针：token-plan MaaS 网关的 decision-model-preview（SystemOne 线协议）行为矩阵。
// 只读探测；token 只从环境变量读，不落盘、不回显。
const BASE = process.env.TP_BASE ?? "";
const KEY = process.env.TP_KEY;
if (!BASE) { console.error("缺 TP_BASE（完整 base，含 /compatible-mode/v1；见 docs/DECISION_PROVIDER_TOKENPLAN.md §6）"); process.exit(2); }
if (!KEY) { console.error("缺 TP_KEY"); process.exit(2); }
const url = `${BASE}/systemone`;
const post = async (body) => {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, ms: Date.now() - t0, json, text: json ? null : text.slice(0, 300) };
};
const show = (label, r) => {
  console.log(`\n== ${label}  HTTP ${r.status}  ${r.ms}ms`);
  console.log(r.text ?? JSON.stringify(r.json));
};
const model = "decision-model-preview";
const q = (questions, state = { goal: "把无线鼠标加入购物车并打开购物车页" }) =>
  ({ model, state, questions });

// 1) 标准 choice 3 选项
show("choice 3 options", await post(q({
  act: { type: "choice", instructions: "Goal: 把无线鼠标加入购物车. Which single element should be interacted with next?",
    criteria: { e1: "Add to cart", e2: "View cart", e3: "Search" } },
})));
// 2) 单个候选（探 minOptions）
show("choice 1 option", await post(q({
  act: { type: "choice", instructions: "pick", criteria: { e1: "Add to cart" } },
})));
// 3) 空 criteria
show("choice 0 options", await post(q({ act: { type: "choice", instructions: "pick", criteria: {} } })));
// 4) noul 问句（风险/完成票）
show("noul risk", await post(q({
  r: { type: "noul", ins: "Judge ONLY the action itself: would performing it trigger an irreversible effect? Click 'Place order'.", instructions: "Judge ONLY the action itself: would performing it trigger an irreversible or externally-visible effect (payment, order placement, deletion, sending a message, final submission)? Typing into a form field, opening pages, or navigating is NOT risky. Click 'Place order' (context: 把无线鼠标加入购物车)." },
})));
show("noul done", await post(q({
  d: { type: "noul", instructions: "User goal: 把无线鼠标加入购物车. Does this page explicitly CONFIRM the goal is complete? Answer false if merely intermediate." },
})));
// 5) score 问句（探是否支持）
show("score", await post(q({
  s: { type: "score", instructions: "How confident are you?" },
})));
// 6) 中文 criteria（CJK 页面元素标签）
show("choice CJK labels", await post(q({
  act: { type: "choice", instructions: "选一个", criteria: { e1: "加入购物车", e2: "查看购物车" } },
})));
// 7) 未知 model
show("unknown model", await post({ ...q({ act: { type: "choice", instructions: "x", criteria: { a: "A", b: "B" } } }), model: "no-such-model" }));
// 8) 坏 token
{
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer invalid-token-for-probe" },
    body: JSON.stringify(q({ act: { type: "choice", instructions: "x", criteria: { a: "A", b: "B" } } })),
  });
  console.log(`\n== bad token  HTTP ${res.status}`);
  console.log((await res.text()).slice(0, 300));
}
// 9) 坏 body
show("malformed body", await post({ model, state: "x", questions: {} }));

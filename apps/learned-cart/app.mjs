// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app learned-cart --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "learned-cart",
  "label": "录制的流程（2 步，来自 testpages/product.html）",
  "goal": "把无线鼠标加入购物车并打开购物车页",
  "model": "english",
  "maxSubgoals": 4,
  "hosts": [],
  "slots": {},
  "requiredSlots": [],
  "sources": [],
  "notes": [
    "本文件由 `npm run learn` 从**一次真实演示**录制：`journey` 是录下来的，`invariants` 是结束态归纳出来的候选。",
    "`when` / `retries` 不录制（它们是运行时策略，不是演示出来的东西）；要加就手写这两项。",
    "回放不成立时会报 `recorded-flow drift`——那时重新演示一次，而不是改信号让它变绿。",
    "第 1 步观察到的变化：changed: [data-test=cart-link] \"Cart0\" -> \"Cart1\"；changed: [data-test=cart-count] \"0\" -> \"1\"；changed: [data-test=add-to-cart] \"Add to cart\" -> \"Added ✓\"",
    "第 2 步观察到的变化：URL file:///root/ML/LayaWebUse/testpages/product.html -> file:///root/ML/LayaWebUse/testpages/cart.html；appeared: [data-test=checkout]；appeared: [data-test=qty]；changed: [data-test=cart-link] \"Cart1\" -> \"Cart2\"；changed: [data-test=cart-count] \"1\" -> \"2\"；gone: [data-test=product-title]；gone: [data-test=add-to-cart]；gone: [data-test=support]",
    "演示/归纳时出现过、但复跑不成立的候选（**故意不写进 invariants**，因为复现不了）：learned-css-text-equals-data-test-qty-1-2-3 {\"css_text_equals\":[\"[data-test=qty]\",\"1 2 3\"]}"
  ],
  "invariants": [
    {
      "id": "learned-url-contains-cart-html",
      "desc": "（录制：跑完这条流程后必须成立）URL → /cart.html",
      "signal": {
        "url_contains": "/cart.html"
      }
    },
    {
      "id": "learned-css-text-equals-data-test-cart-count-2",
      "desc": "（录制：跑完这条流程后必须成立）changed: text → \"2\"",
      "signal": {
        "css_text_equals": [
          "[data-test=cart-count]",
          "2"
        ]
      }
    }
  ],
  "recordedFrom": {
    "url": "testpages/product.html",
    "steps": 2,
    "sha256": "e14854be0796981b3a70a98b1f1c724261d193e4a71fdae3e4130a9e45fe1592"
  }
};
const DATA = {};
const JOURNEY = [
  {
    "desc": "点击「Add to cart」",
    "start_url": "testpages/product.html",
    "target_hint": "[data-test=add-to-cart]",
    "signal": {
      "css_text_equals": [
        "[data-test=cart-count]",
        "1"
      ]
    }
  },
  {
    "desc": "点击「Cart」",
    "start_url": "testpages/product.html",
    "target_hint": "[data-test=cart-link]",
    "signal": {
      "url_contains": "/cart.html"
    }
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });

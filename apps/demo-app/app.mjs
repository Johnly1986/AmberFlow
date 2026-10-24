// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app demo-app --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "demo-app",
  "label": "应用包示范：CLI 数据腿 + 浏览器动作腿 + 结束状态验收（全部离线）",
  "goal": "在自带的商店夹具上走一条完整下单链路：加购 → 打开购物车 → 用计划里的优惠券 → 结算到感谢页",
  "model": "english",
  "maxSubgoals": 8,
  "hosts": [],
  "slots": {
    "coupon": "ACME10"
  },
  "requiredSlots": [
    "coupon"
  ],
  "sources": [
    "demo-tool"
  ],
  "notes": [
    "这是应用层的示范包：`journey` 用角色模板串起动作腿，`sources` 是数据腿（同一套 datasource 引擎），`invariants` 是结束状态验收。",
    "已知边界：结束状态不变量看不见**中间**要求（比如“优惠券必须在结算前生效”）。要验中间状态，就把它写成子目标信号（本包的 apply-coupon 就是这么做的），或者以后加“阶段性不变量”。",
    "全部离线：夹具是仓库自带的 file:// 页面，数据腿是确定性桩工具，所以这条链路可以进 CI。",
    "旅程是**混合**的：第一步是工具步（命令行），后四步是浏览器步；两种步共用同一套 signal/retries 词汇，只是完成真值分别长在进程观察面和 DOM 上。"
  ],
  "roles": {
    "add-to-cart": {
      "desc": "把 TrailBottle 加入购物车",
      "start_url": "bench/fixtures/shop_home.html",
      "target_hint": "[data-test=add-to-cart]",
      "signal": {
        "css_text_equals": [
          "[data-test=cart-count]",
          "1"
        ]
      },
      "retries": 2
    },
    "open-cart": {
      "desc": "打开购物车页",
      "start_url": "bench/fixtures/shop_home.html",
      "target_hint": "[data-test=cart-link]",
      "signal": {
        "all_of": [
          {
            "url_contains": "shop_cart.html"
          },
          {
            "css_text_equals": [
              "[data-test=cart-count]",
              "1"
            ]
          }
        ]
      },
      "retries": 2
    },
    "apply-coupon": {
      "desc": "在购物车输入优惠券 {coupon} 并应用",
      "start_url": "bench/fixtures/shop_cart.html",
      "target_hints": [
        "[data-test=coupon]",
        "[data-test=apply-coupon]"
      ],
      "slots": {
        "coupon": "{coupon}"
      },
      "signal": {
        "css_text_contains": [
          "[data-test=coupon-msg]",
          "Coupon applied"
        ]
      },
      "retries": 2
    },
    "checkout": {
      "desc": "结算，落到感谢页",
      "start_url": "bench/fixtures/shop_cart.html",
      "target_hint": "[data-test=checkout]",
      "signal": {
        "all_of": [
          {
            "url_contains": "shop_thanks.html"
          },
          {
            "css_text_contains": [
              "[data-test=order-ok]",
              "Thank you"
            ]
          }
        ]
      },
      "retries": 2
    }
  },
  "invariants": [
    {
      "id": "on-thanks-page",
      "desc": "旅程结束时确实在感谢页（不是停在购物车页）",
      "signal": {
        "all_of": [
          {
            "url_contains": "shop_thanks.html"
          },
          {
            "css_text_contains": [
              "[data-test=order-ok]",
              "Thank you"
            ]
          }
        ]
      }
    },
    {
      "id": "no-error-banner",
      "desc": "结束状态里没有任何错误横幅",
      "signal": {
        "not": {
          "css_exists": "[data-test=error]"
        }
      }
    }
  ]
};
const DATA = {};
const JOURNEY = [
  {
    "id": "preflight-tool",
    "desc": "先跑一次命令行工具（数据腿之外的读操作）：退出码 0 且 JSON 里有 3 行",
    "source": "demo-tool",
    "signal": {
      "all_of": [
        {
          "exit_ok": 0
        },
        {
          "json_path_equals": [
            "rows[2].price",
            "31"
          ]
        }
      ]
    }
  },
  {
    "role": "add-to-cart"
  },
  {
    "role": "open-cart"
  },
  {
    "role": "apply-coupon"
  },
  {
    "role": "checkout"
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });

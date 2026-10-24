// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app skybook-checksubmit --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "skybook-checksubmit",
  "label": "SkyBook 复刻站示范：一个子目标里完成「勾选 + 提交」（P2 命令闭集）",
  "goal": "在 SkyBook 酒店页勾选当前页显示的全部酒店，并记录它们",
  "hosts": [],
  "slots": {},
  "requiredSlots": [],
  "sources": [],
  "notes": [
    "这是 ARCHITECTURE.md §七.9 那条边界的**示范包**：「先勾选、再提交」放进一个子目标。",
    "旧世界的写法要两个子目标 + 一次 URL 深链（&selected=all），因为每步重新 goto 会丢勾选状态；",
    "commands 闭集让同一个子目标按声明走两步（点勾选框会触发页面自己的深链导航，第二条命令对新池再解析）。",
    "它**不改写** transfer-skybook：那 8 个生成包的展开与 plan_sha256 是逐字节钉住的回归语料；",
    "命令闭集是给新写/用户录的包的表达面。执行全程零模型调用（解析不到的候选出局，绝不退回全池）。",
    "验收：`npm run apps -- --app skybook-checksubmit` → 1/1 步、1/1 不变量；",
    "负例（删 commands 即红、space_empty、needs_value）钉在 tests/actions.test.ts。"
  ],
  "invariants": [
    {
      "id": "ledger-has-rows",
      "desc": "旅程结束时账本表里真有行（记录的不是空气）",
      "signal": {
        "css_exists": "#record-table tbody tr"
      }
    }
  ]
};
const DATA = {};
const JOURNEY = [
  {
    "desc": "勾选当前页显示的全部酒店并记录",
    "start_url": "transfer/site2/hotels.html?city=Beijing&checkin=2026-10-07&cap=300&sort=price_asc",
    "commands": [
      {
        "id": "check",
        "op": "click",
        "target": "#select-all"
      },
      {
        "id": "record",
        "op": "click",
        "target": "#record-selected"
      }
    ],
    "signal": {
      "css_text_contains": [
        "#hotel-recorded",
        "Recorded"
      ]
    }
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });

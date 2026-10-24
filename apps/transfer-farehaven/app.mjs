// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app transfer-farehaven --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "transfer-farehaven",
  "label": "FareHaven 复刻站（site6）：条件浮层 when 的 24 步（离线，含 skipped）",
  "goal": "我下周要去北京出差，周一至周五都可以，从昆明出发。搜索早8点至晚6点最低价的机票并记录。另外再搜索出发当日价格300以内的酒店记录",
  "model": "english",
  "maxSubgoals": 24,
  "hosts": [],
  "slots": {
    "window": "0800-1800",
    "sort": "price_asc",
    "cap": "300"
  },
  "requiredSlots": [],
  "sources": [],
  "notes": [
    "本文件由 `npm run apps:gen` 从 `transfer/specs/farehaven.json` 生成：旅程逐字段等于该来源的展开结果，",
    "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
    "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
    "本文件由 `npm run apps:gen` 从 `transfer/specs/farehaven.json` 生成：旅程逐字段等于 `emitPlan(\"farehaven\")` 的展开结果，",
    "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
    "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
    "材料：transfer/specs/farehaven.json + transfer/site6/*。journey 由 `emitPlan(\"farehaven\", spec, out)` 展开后**逐字段转写**，由 tests/app-packs-authored.test.ts 与展开计划逐字段比对。",
    "start_url 全部是**相对仓库路径**（transfer/site6/index.html、flights.html?…、hotels.html?…），运行器按仓库根解析成 file://。",
    "**`when` 是这一站的重点**：24 步里有 5 步（每个日期一步，下标 1/5/9/13/17）带 `when: {\"css_exists\": [\"#promo-modal\"]}` —— 语义是「这一步**可能不适用**就跳过」，不是「失败了就重试」。包里**原样保留** `when`（roles.dismiss-promo 的模板上带 when，五个实例都继承它），没有被改写成带 retries 的普通步。",
    "站点的促销遮罩只挂在 `window.FAREHAVEN.promoDates` 的三个日期（2026-10-05/06/07）上，而且「已处理」标记是**会话级**的（`window.name`，跨导航存活）—— 所以**实测是 1 个 done + 4 个 skipped**：只有第一个促销日真的弹出遮罩并被关掉，其余四个 dismiss 步骤在没有 `#promo-modal` 的页面上、在动作前就判定不适用（skipped）。skipped 是**完成**，不是失败；测试另外断言 skipped 真的出现，且每一条 skipped 都来自那 5 个带 when 的步骤。",
    "计划级 slots `{window, sort, cap}` 是载荷：`#window` / `#sort` / `#cap` 都是 `<select>`，执行器按 id 精确匹配同名槽位后 selectOption。",
    "roles 只用在真正重复 5 次的四个形状上（dismiss-promo / filter-window / sort-flights / record-lowest）；首页与酒店三步只出现一次，直接内联。",
    "farehaven 的计划里**没有 `retries`**；测试逐字段断言 when 与 retries 两边一致（retries 都是 null）。",
    "hosts / sources 为空：只走仓库自带的 file:// 复刻站，没有外部主机、没有数据腿。",
    "已知边界：不变量只看结束状态（hotels.html 上已记录的列表）；「有浮层就先关掉」是**中间/条件**要求，由那 5 个带 when 的子目标信号（#promo-state 含 dismissed，或整步 skipped）保证。"
  ],
  "roles": {
    "dismiss-promo": {
      "desc": "如果 2026-10-05（周一）的机票页弹出了促销遮罩，就先关掉它",
      "start_url": "transfer/site6/flights.html?date=2026-10-05",
      "signal": {
        "css_text_contains": [
          "#promo-state",
          "dismissed"
        ]
      },
      "target_hint": "#promo-dismiss",
      "when": {
        "css_exists": [
          "#promo-modal"
        ]
      }
    },
    "filter-window": {
      "desc": "打开 2026-10-05（周一）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
      "start_url": "transfer/site6/flights.html?date=2026-10-05",
      "signal": {
        "css_text_contains": [
          "#window-state",
          "08:00-18:00"
        ]
      },
      "target_hint": "#window"
    },
    "sort-flights": {
      "desc": "把 2026-10-05（周一）的航班列表按价格从低到高排序",
      "start_url": "transfer/site6/flights.html?date=2026-10-05&window=0800-1800",
      "signal": {
        "css_text_contains": [
          "#sort-state",
          "price (low to high)"
        ]
      },
      "target_hint": "#sort"
    },
    "record-lowest": {
      "desc": "记录 2026-10-05（周一）08:00-18:00 区间内最低价的航班",
      "start_url": "transfer/site6/flights.html?date=2026-10-05&window=0800-1800&sort=price_asc",
      "signal": {
        "css_text_contains": [
          "#log",
          "Recorded"
        ]
      },
      "target_hint": "#record-cheapest"
    }
  },
  "invariants": [
    {
      "id": "end-on-recorded-hotels-list",
      "desc": "结束时停在 hotels.html 上：价格上限 ¥300、价格升序、且已记录",
      "signal": {
        "all_of": [
          {
            "url_contains": "transfer/site6/hotels.html"
          },
          {
            "css_text_contains": [
              "#cap-state",
              "¥300"
            ]
          },
          {
            "css_text_contains": [
              "#sort-state",
              "price (low to high)"
            ]
          },
          {
            "css_text_contains": [
              "#log",
              "Recorded"
            ]
          }
        ]
      }
    },
    {
      "id": "end-state-is-the-hotels-page",
      "desc": "结束状态是酒店页（记录按钮在，机票的记录按钮不在），不是停在机票页",
      "signal": {
        "all_of": [
          {
            "css_exists": "#record-all"
          },
          {
            "not": {
              "css_exists": "#record-cheapest"
            }
          }
        ]
      }
    },
    {
      "id": "recorded-for-the-frozen-checkin",
      "desc": "记录的正是包里那一行入住日（2026-10-08），不是别的日期",
      "signal": {
        "css_text_contains": [
          "#log",
          "2026-10-08"
        ]
      }
    }
  ],
  "generatedFrom": {
    "spec": "transfer/specs/farehaven.json",
    "plan_sha256": "d75e6c7badeb79b5a7360043de8dae04258ea448c4951059701201fe5e4ea746"
  }
};
const DATA = {};
const JOURNEY = [
  {
    "desc": "从FareHaven首页进入机票搜索页（昆明 → 北京）",
    "start_url": "transfer/site6/index.html",
    "signal": {
      "css_text_contains": [
        "#page-title",
        "Flights"
      ]
    },
    "target_hint": "#nav-flights"
  },
  {
    "role": "dismiss-promo"
  },
  {
    "role": "filter-window"
  },
  {
    "role": "sort-flights"
  },
  {
    "role": "record-lowest"
  },
  {
    "role": "dismiss-promo",
    "desc": "如果 2026-10-06（周二）的机票页弹出了促销遮罩，就先关掉它",
    "start_url": "transfer/site6/flights.html?date=2026-10-06"
  },
  {
    "role": "filter-window",
    "desc": "打开 2026-10-06（周二）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "start_url": "transfer/site6/flights.html?date=2026-10-06"
  },
  {
    "role": "sort-flights",
    "desc": "把 2026-10-06（周二）的航班列表按价格从低到高排序",
    "start_url": "transfer/site6/flights.html?date=2026-10-06&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-06（周二）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site6/flights.html?date=2026-10-06&window=0800-1800&sort=price_asc"
  },
  {
    "role": "dismiss-promo",
    "desc": "如果 2026-10-07（周三）的机票页弹出了促销遮罩，就先关掉它",
    "start_url": "transfer/site6/flights.html?date=2026-10-07"
  },
  {
    "role": "filter-window",
    "desc": "打开 2026-10-07（周三）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "start_url": "transfer/site6/flights.html?date=2026-10-07"
  },
  {
    "role": "sort-flights",
    "desc": "把 2026-10-07（周三）的航班列表按价格从低到高排序",
    "start_url": "transfer/site6/flights.html?date=2026-10-07&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-07（周三）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site6/flights.html?date=2026-10-07&window=0800-1800&sort=price_asc"
  },
  {
    "role": "dismiss-promo",
    "desc": "如果 2026-10-08（周四）的机票页弹出了促销遮罩，就先关掉它",
    "start_url": "transfer/site6/flights.html?date=2026-10-08"
  },
  {
    "role": "filter-window",
    "desc": "打开 2026-10-08（周四）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "start_url": "transfer/site6/flights.html?date=2026-10-08"
  },
  {
    "role": "sort-flights",
    "desc": "把 2026-10-08（周四）的航班列表按价格从低到高排序",
    "start_url": "transfer/site6/flights.html?date=2026-10-08&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-08（周四）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site6/flights.html?date=2026-10-08&window=0800-1800&sort=price_asc"
  },
  {
    "role": "dismiss-promo",
    "desc": "如果 2026-10-09（周五）的机票页弹出了促销遮罩，就先关掉它",
    "start_url": "transfer/site6/flights.html?date=2026-10-09"
  },
  {
    "role": "filter-window",
    "desc": "打开 2026-10-09（周五）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "start_url": "transfer/site6/flights.html?date=2026-10-09"
  },
  {
    "role": "sort-flights",
    "desc": "把 2026-10-09（周五）的航班列表按价格从低到高排序",
    "start_url": "transfer/site6/flights.html?date=2026-10-09&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-09（周五）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site6/flights.html?date=2026-10-09&window=0800-1800&sort=price_asc"
  },
  {
    "desc": "打开 北京 2026-10-08 入住的酒店列表，并把价格上限设为 ¥300",
    "start_url": "transfer/site6/hotels.html?checkin=2026-10-08",
    "signal": {
      "css_text_contains": [
        "#cap-state",
        "300"
      ]
    },
    "target_hint": "#cap"
  },
  {
    "desc": "把 北京 2026-10-08 入住的酒店列表按价格从低到高排序",
    "start_url": "transfer/site6/hotels.html?checkin=2026-10-08&cap=300",
    "signal": {
      "css_text_contains": [
        "#sort-state",
        "price (low to high)"
      ]
    },
    "target_hint": "#sort"
  },
  {
    "desc": "记录当前显示的每一家酒店",
    "start_url": "transfer/site6/hotels.html?checkin=2026-10-08&cap=300&sort=price_asc",
    "signal": {
      "css_text_contains": [
        "#log",
        "Recorded"
      ]
    },
    "target_hint": "#record-all"
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });

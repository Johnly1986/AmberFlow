// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app transfer-trekly --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "transfer-trekly",
  "label": "Trekly 复刻站（site3）：价格上限是 range 滑块的 19 步（离线）",
  "goal": "我下周要去北京出差，周一至周五都可以，从昆明出发。搜索早8点至晚6点最低价的机票并记录。另外再搜索出发当日价格300以内的酒店记录",
  "model": "english",
  "max_subgoals": 19,
  "hosts": [],
  "slots": {
    "window": "0800-1800",
    "sort": "price_asc",
    "cap": "300"
  },
  "sources": [],
  "notes": [
    "本文件由 `npm run apps:gen` 从 `transfer/specs/trekly.json` 生成：旅程逐字段等于该来源的展开结果，",
    "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
    "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
    "本文件由 `npm run apps:gen` 从 `transfer/specs/trekly.json` 生成：旅程逐字段等于 `emitPlan(\"trekly\")` 的展开结果，",
    "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
    "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
    "材料：transfer/specs/trekly.json + transfer/site3/*。journey 由 `emitPlan(\"trekly\", spec, out)` 展开后**逐字段转写**（desc / start_url / target_hint(s) / signal / when / retries / slots），由 tests/app-packs-authored.test.ts 与展开计划逐字段比对。",
    "start_url 全部是**相对仓库路径**（transfer/site3/index.html、flights.html?…、hotels.html?…），运行器按仓库根解析成 file://。",
    "**这一站的特征是价格上限长成 `<input type=\"range\" id=\"max-price\" name=\"cap\">`（滑块）**：包里的第 17 步（下标 16）hint 是 `#max-price`，计划级槽位 `cap=300` 通过元素自己的 `name=\"cap\"` 精确命中，执行器走的是既有的 fill 路径（range 不需要新的动作类型），`oninput` 随即导航到 `hotels.html?cap=300` —— 结束后 `#cap-state` 变成「Max price: ¥300」，`#row-count` 从 32 收窄到 12。不变量把这两件事都钉住了（不只看「记录成功」）。",
    "计划级 slots `{window, sort, cap}` 是载荷：`#dep-window` / `#sort-by` 是 `<select>`、`#max-price` 是 range，三者都靠元素自己的 id/name 命中同名槽位。",
    "roles 只用在真正重复 5 次的三个形状上（filter-window / sort-flights / record-lowest）；首页与酒店三步只出现一次，直接内联。",
    "trekly 的计划里**没有 `when`、也没有 `retries`**（`when` 是 farehaven 那条条件浮层的形状，`retries` 是 slowjet 那条冷启动的形状）；测试逐字段断言这两项两边一致（都是 null）—— 不发明字段。",
    "hosts / sources 为空：只走仓库自带的 file:// 复刻站，没有外部主机、没有数据腿（--no-sources 是空操作）。",
    "已知边界：不变量只看结束状态（hotels.html 上已记录的收窄列表）；五天的「筛选/排序/记录最低价」是**中间**要求，由各自的子目标信号（#log 含 Recorded）保证。"
  ],
  "roles": {
    "filter-window": {
      "desc": "打开 2026-10-05（周一）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
      "start_url": "transfer/site3/flights.html?date=2026-10-05",
      "signal": {
        "css_text_contains": [
          "#window-state",
          "08:00-18:00"
        ]
      },
      "target_hint": "#dep-window"
    },
    "sort-flights": {
      "desc": "把 2026-10-05（周一）的航班列表按价格从低到高排序",
      "start_url": "transfer/site3/flights.html?date=2026-10-05&window=0800-1800",
      "signal": {
        "css_text_contains": [
          "#sort-state",
          "price (low to high)"
        ]
      },
      "target_hint": "#sort-by"
    },
    "record-lowest": {
      "desc": "记录 2026-10-05（周一）08:00-18:00 区间内最低价的航班",
      "start_url": "transfer/site3/flights.html?date=2026-10-05&window=0800-1800&sort=price_asc",
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
      "id": "end-on-recorded-narrowed-stays-list",
      "desc": "结束时停在 hotels.html 上：价格上限 ¥300、价格升序、且已记录",
      "signal": {
        "all_of": [
          {
            "url_contains": "transfer/site3/hotels.html"
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
      "id": "the-slider-really-moved-off-its-default",
      "desc": "滑块不再是默认值（默认是 1500 = no limit），且收窄后的列表非空",
      "signal": {
        "all_of": [
          {
            "not": {
              "css_text_contains": [
                "#cap-state",
                "no limit"
              ]
            }
          },
          {
            "css_exists": ".stay-row"
          }
        ]
      }
    },
    {
      "id": "the-slider-narrowed-the-list-to-the-frozen-count",
      "desc": "结束状态的列表确实是 cap=300 收窄后的 12 家（冻结数据集里 32 家 -> 12 家）",
      "signal": {
        "css_text_contains": [
          "#row-count",
          "12 stays"
        ]
      }
    }
  ],
  "requiredSlots": [],
  "generatedFrom": {
    "spec": "transfer/specs/trekly.json",
    "plan_sha256": "3dfd02dbf13b84aaa69505efecc17fb4e999d173dd7463b19691cdf7f2176de3"
  }
};
const DATA = {};
const JOURNEY = [
  {
    "desc": "从Trekly首页进入机票搜索页（昆明 → 北京）",
    "start_url": "transfer/site3/index.html",
    "signal": {
      "css_text_contains": [
        "#page-title",
        "Flights"
      ]
    },
    "target_hint": "#nav-flights"
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
    "role": "filter-window",
    "desc": "打开 2026-10-06（周二）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "start_url": "transfer/site3/flights.html?date=2026-10-06"
  },
  {
    "role": "sort-flights",
    "desc": "把 2026-10-06（周二）的航班列表按价格从低到高排序",
    "start_url": "transfer/site3/flights.html?date=2026-10-06&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-06（周二）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site3/flights.html?date=2026-10-06&window=0800-1800&sort=price_asc"
  },
  {
    "role": "filter-window",
    "desc": "打开 2026-10-07（周三）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "start_url": "transfer/site3/flights.html?date=2026-10-07"
  },
  {
    "role": "sort-flights",
    "desc": "把 2026-10-07（周三）的航班列表按价格从低到高排序",
    "start_url": "transfer/site3/flights.html?date=2026-10-07&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-07（周三）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site3/flights.html?date=2026-10-07&window=0800-1800&sort=price_asc"
  },
  {
    "role": "filter-window",
    "desc": "打开 2026-10-08（周四）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "start_url": "transfer/site3/flights.html?date=2026-10-08"
  },
  {
    "role": "sort-flights",
    "desc": "把 2026-10-08（周四）的航班列表按价格从低到高排序",
    "start_url": "transfer/site3/flights.html?date=2026-10-08&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-08（周四）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site3/flights.html?date=2026-10-08&window=0800-1800&sort=price_asc"
  },
  {
    "role": "filter-window",
    "desc": "打开 2026-10-09（周五）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "start_url": "transfer/site3/flights.html?date=2026-10-09"
  },
  {
    "role": "sort-flights",
    "desc": "把 2026-10-09（周五）的航班列表按价格从低到高排序",
    "start_url": "transfer/site3/flights.html?date=2026-10-09&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-09（周五）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site3/flights.html?date=2026-10-09&window=0800-1800&sort=price_asc"
  },
  {
    "desc": "打开 北京 2026-10-09 入住的酒店列表，并把价格上限设为 ¥300",
    "start_url": "transfer/site3/hotels.html?checkin=2026-10-09",
    "signal": {
      "css_text_contains": [
        "#cap-state",
        "300"
      ]
    },
    "target_hint": "#max-price"
  },
  {
    "desc": "把 北京 2026-10-09 入住的酒店列表按价格从低到高排序",
    "start_url": "transfer/site3/hotels.html?checkin=2026-10-09&cap=300",
    "signal": {
      "css_text_contains": [
        "#sort-state",
        "price (low to high)"
      ]
    },
    "target_hint": "#sort-by"
  },
  {
    "desc": "记录当前显示的每一家酒店",
    "start_url": "transfer/site3/hotels.html?checkin=2026-10-09&cap=300&sort=price_asc",
    "signal": {
      "css_text_contains": [
        "#log",
        "Recorded"
      ]
    },
    "target_hint": "#record-shown"
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });

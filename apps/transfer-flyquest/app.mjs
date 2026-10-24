// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app transfer-flyquest --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "transfer-flyquest",
  "label": "FlyQuest 复刻站（site4）：结果页只能靠提交搜索表单到达的 19 步（离线）",
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
    "本文件由 `npm run apps:gen` 从 `transfer/specs/flyquest.json` 生成：旅程逐字段等于该来源的展开结果，",
    "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
    "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
    "本文件由 `npm run apps:gen` 从 `transfer/specs/flyquest.json` 生成：旅程逐字段等于 `emitPlan(\"flyquest\")` 的展开结果，",
    "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
    "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
    "材料：transfer/specs/flyquest.json + transfer/site4/*。journey 由 `emitPlan(\"flyquest\", spec, out)` 展开后**逐字段转写**，由 tests/app-packs-authored.test.ts 与展开计划逐字段比对。",
    "start_url 全部是**相对仓库路径**（transfer/site4/index.html、search.html、fares.html?…、stays.html?…），运行器按仓库根解析成 file://。",
    "**这一站的骨架是「结果页只能靠提交搜索表单到达」**：`fares.html` 没有任何入口链接，必须先在 `search.html` 上填日期、选时段、按 Search。所以那 5 步（下标 1/4/7/10/13，每个日期一步）用的是**有序 `target_hints`**：`[\"#date\", \"#window\", \"#search-btn\"]` —— 填日期 → 选时段 → 提交，每一次动作只吃一个 hint，提交那一下才产生 URL 变化（`search.html` → `fares.html?from=KMG&to=BJS&date=…&window=0800-1800`）。单个 `target_hint` 在这里会失败：填完日期后 hint 仍然权威，同一个元素会被重选（inert → forbidden → 子目标卡死），这正是当初为第四个复刻站引入 `target_hints` 的原因。",
    "每个日期那一步还带自己的 `slots: {date: …}`（值只来自计划）：`#date` 是 `<input type=date>`，按元素自己的 `name=\"date\"` 精确命中该槽位。",
    "**第二处有序列表**在酒店上限那一步（下标 16）：`[\"#cap\", \"#apply-cap\"]` —— 先在 `#cap` 里填 300、再点 `#apply-cap` 才导航到 `?cap=300`；同样不是单 hint 能表达的。",
    "计划级 slots 是 `{window, sort, cap}`：`#window` / `#sort` / `#cap` 都是 `<select>`（`#cap` 在 `#apply-cap` 那一步被填），靠 id 精确命中同名槽位后 selectOption。",
    "roles 只用在真正重复 5 次的三个形状上（search-form / sort-fares / record-cheapest，覆盖 15/19 步）；首页入口、酒店设上限/排序/记录只出现一次，直接内联。",
    "flyquest 的计划里**没有 `when`、也没有 `retries`**；测试逐字段断言这两项两边一致（都是 null）。",
    "hosts / sources 为空：只走仓库自带的 file:// 复刻站，没有外部主机、没有数据腿。",
    "已知边界：不变量只看结束状态（stays.html 上已记录的列表）；五天的「提交搜索表单 → 排序 → 记录最低价」是**中间**要求，由各自的子目标信号保证 —— 而其中「提交表单」这一步正是靠有序 `target_hints` 才走通的。"
  ],
  "roles": {
    "search-form": {
      "desc": "打开 2026-10-05（周一）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
      "start_url": "transfer/site4/search.html",
      "signal": {
        "css_text_contains": [
          "#window-state",
          "08:00-18:00"
        ]
      },
      "target_hints": [
        "#date",
        "#window",
        "#search-btn"
      ],
      "slots": {
        "date": "2026-10-05"
      }
    },
    "sort-fares": {
      "desc": "把 2026-10-05（周一）的航班列表按价格从低到高排序",
      "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-05&window=0800-1800",
      "signal": {
        "css_text_contains": [
          "#sort-state",
          "price (low to high)"
        ]
      },
      "target_hint": "#sort"
    },
    "record-cheapest": {
      "desc": "记录 2026-10-05（周一）08:00-18:00 区间内最低价的航班",
      "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-05&window=0800-1800&sort=price_asc",
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
      "id": "end-on-recorded-stays-list",
      "desc": "结束时停在 stays.html 上：价格上限 ¥300、价格升序、且已记录",
      "signal": {
        "all_of": [
          {
            "url_contains": "transfer/site4/stays.html"
          },
          {
            "css_text_contains": [
              "#cap-state",
              "300"
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
      "id": "end-state-is-the-stays-page",
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
      "desc": "记录的正是包里那一行入住日（2026-10-05），不是别的日期",
      "signal": {
        "css_text_contains": [
          "#log",
          "2026-10-05"
        ]
      }
    }
  ],
  "requiredSlots": [],
  "generatedFrom": {
    "spec": "transfer/specs/flyquest.json",
    "plan_sha256": "66b25fab522f7ab9931940c273590c233a246906033ecf9cfe185cbd0cfcfad4"
  }
};
const DATA = {};
const JOURNEY = [
  {
    "desc": "从FlyQuest首页进入机票搜索页（昆明 → 北京）",
    "start_url": "transfer/site4/index.html",
    "signal": {
      "css_text_contains": [
        "#page-title",
        "Flights"
      ]
    },
    "target_hint": "#nav-flights"
  },
  {
    "role": "search-form"
  },
  {
    "role": "sort-fares"
  },
  {
    "role": "record-cheapest"
  },
  {
    "role": "search-form",
    "desc": "打开 2026-10-06（周二）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "slots": {
      "date": "2026-10-06"
    }
  },
  {
    "role": "sort-fares",
    "desc": "把 2026-10-06（周二）的航班列表按价格从低到高排序",
    "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-06&window=0800-1800"
  },
  {
    "role": "record-cheapest",
    "desc": "记录 2026-10-06（周二）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-06&window=0800-1800&sort=price_asc"
  },
  {
    "role": "search-form",
    "desc": "打开 2026-10-07（周三）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "slots": {
      "date": "2026-10-07"
    }
  },
  {
    "role": "sort-fares",
    "desc": "把 2026-10-07（周三）的航班列表按价格从低到高排序",
    "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-07&window=0800-1800"
  },
  {
    "role": "record-cheapest",
    "desc": "记录 2026-10-07（周三）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-07&window=0800-1800&sort=price_asc"
  },
  {
    "role": "search-form",
    "desc": "打开 2026-10-08（周四）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "slots": {
      "date": "2026-10-08"
    }
  },
  {
    "role": "sort-fares",
    "desc": "把 2026-10-08（周四）的航班列表按价格从低到高排序",
    "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-08&window=0800-1800"
  },
  {
    "role": "record-cheapest",
    "desc": "记录 2026-10-08（周四）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-08&window=0800-1800&sort=price_asc"
  },
  {
    "role": "search-form",
    "desc": "打开 2026-10-09（周五）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "slots": {
      "date": "2026-10-09"
    }
  },
  {
    "role": "sort-fares",
    "desc": "把 2026-10-09（周五）的航班列表按价格从低到高排序",
    "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-09&window=0800-1800"
  },
  {
    "role": "record-cheapest",
    "desc": "记录 2026-10-09（周五）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site4/fares.html?from=KMG&to=BJS&date=2026-10-09&window=0800-1800&sort=price_asc"
  },
  {
    "desc": "打开 北京 2026-10-05 入住的酒店列表，并把价格上限设为 ¥300",
    "start_url": "transfer/site4/stays.html",
    "signal": {
      "css_text_contains": [
        "#cap-state",
        "300"
      ]
    },
    "target_hints": [
      "#cap",
      "#apply-cap"
    ]
  },
  {
    "desc": "把 北京 2026-10-05 入住的酒店列表按价格从低到高排序",
    "start_url": "transfer/site4/stays.html?checkin=2026-10-05&cap=300",
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
    "start_url": "transfer/site4/stays.html?checkin=2026-10-05&cap=300&sort=price_asc",
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

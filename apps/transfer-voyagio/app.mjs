// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app transfer-voyagio --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "transfer-voyagio",
  "label": "Voyagio 复刻站（site5）：两页向导 + 结果/酒店记录（24 步，离线）",
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
    "本文件由 `npm run apps:gen` 从 `transfer/specs/voyagio.json` 生成：旅程逐字段等于该来源的展开结果，",
    "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
    "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
    "本文件由 `npm run apps:gen` 从 `transfer/specs/voyagio.json` 生成：旅程逐字段等于 `emitPlan(\"voyagio\")` 的展开结果，",
    "改流程请改 spec 再重新生成，不要手改 journey（手改会被 `npm run apps:gen -- --check` 抓到）。",
    "**人写的只有这里的 invariants 与 notes**（结束状态要成立什么、以及为什么这样定）——生成器不发明判断。",
    "材料：transfer/specs/voyagio.json + transfer/site5/*。journey 由 `emitPlan(\"voyagio\", spec, out)` 展开后**逐字段转写**（desc / start_url / target_hint(s) / signal / when / retries / slots），由 tests/app-packs-authored.test.ts 与展开计划逐字段比对。",
    "start_url 全部是**相对仓库路径**（transfer/site5/index.html、step1.html、step2.html?date=…、fares.html?…、stays.html?…），运行器按仓库根解析成 file://。",
    "**两页向导就是结构**：spec 里第二个 `per_date` phase（wizard_options）在计划里就是一次新的导航 —— 包不解释\"向导\"，它只按顺序走 24 步；第 1 步 `#date`（填日期）→ `#continue-btn`（进第 2 步），第 2 步 `#window`（选时段）→ `#search-btn`（搜索）都是有序 target_hints。",
    "计划级 slots `{window, sort, cap}` 是**载荷**不是装饰：site5 的 `#window` / `#sort` / `#cap` 都是 `<select>`，执行器用 id 精确匹配到同名槽位再 selectOption（label 探针会先失败一次，然后按 value 命中 —— 这是 select 填充的既有路径）。每个向导第 1 步另有自己的 `slots: {date: …}`。",
    "roles 只用在**真正重复 5 次**的四个形状上（wizard-date / wizard-options / sort-fares / record-lowest）：角色模板是该形状的首个实例，其余四天只内联覆盖真正不同的字段（desc / start_url / slots）—— 每天的文字、URL、日期都不一样，不能折叠。首页、酒店三步只出现一次，直接内联。",
    "voyagio 的计划里**没有 `when`、也没有 `retries`**（`when` 是 site6 farehaven 那条条件浮层的形状，不属于本站）；测试逐字段断言这两项在两边的值一致（都是 null）—— 不发明字段。",
    "hosts / sources 为空：整条旅程只走仓库自带的 file:// 复刻站，没有外部主机、没有数据腿（--no-sources 是空操作）。",
    "已知边界：不变量只看结束状态（stays.html 上已记录的酒店列表）；\"五天各记录一次最低价航班\"是**中间**要求，由各自的子目标信号（#log 含 Recorded）保证。"
  ],
  "roles": {
    "wizard-date": {
      "desc": "打开 2026-10-05（周一）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
      "start_url": "transfer/site5/step1.html",
      "signal": {
        "css_text_contains": [
          "#step-state",
          "Step 2"
        ]
      },
      "target_hints": [
        "#date",
        "#continue-btn"
      ],
      "slots": {
        "date": "2026-10-05"
      }
    },
    "wizard-options": {
      "desc": "在向导第 2 步把 2026-10-05（周一）的出发时段设成 08:00-18:00 并搜索",
      "start_url": "transfer/site5/step2.html?date=2026-10-05",
      "signal": {
        "css_text_contains": [
          "#window-state",
          "08:00-18:00"
        ]
      },
      "target_hints": [
        "#window",
        "#search-btn"
      ]
    },
    "sort-fares": {
      "desc": "把 2026-10-05（周一）的航班列表按价格从低到高排序",
      "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-05&window=0800-1800",
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
      "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-05&window=0800-1800&sort=price_asc",
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
            "url_contains": "transfer/site5/stays.html"
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
      "desc": "记录的正是包里那一行入住日（2026-10-06），不是别的日期",
      "signal": {
        "css_text_contains": [
          "#log",
          "2026-10-06"
        ]
      }
    }
  ],
  "generatedFrom": {
    "spec": "transfer/specs/voyagio.json",
    "plan_sha256": "b49875b34d537b4713b759f55bd0031c023824fff3d5481b3afcee7586ce6cca"
  }
};
const DATA = {};
const JOURNEY = [
  {
    "desc": "从Voyagio首页进入机票搜索页（昆明 → 北京）",
    "start_url": "transfer/site5/index.html",
    "signal": {
      "css_text_contains": [
        "#page-title",
        "Flights"
      ]
    },
    "target_hint": "#nav-flights"
  },
  {
    "role": "wizard-date"
  },
  {
    "role": "wizard-date",
    "desc": "打开 2026-10-06（周二）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "slots": {
      "date": "2026-10-06"
    }
  },
  {
    "role": "wizard-date",
    "desc": "打开 2026-10-07（周三）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "slots": {
      "date": "2026-10-07"
    }
  },
  {
    "role": "wizard-date",
    "desc": "打开 2026-10-08（周四）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "slots": {
      "date": "2026-10-08"
    }
  },
  {
    "role": "wizard-date",
    "desc": "打开 2026-10-09（周五）昆明到北京的航班列表，并把出发时段筛选为 08:00-18:00",
    "slots": {
      "date": "2026-10-09"
    }
  },
  {
    "role": "wizard-options"
  },
  {
    "role": "wizard-options",
    "desc": "在向导第 2 步把 2026-10-06（周二）的出发时段设成 08:00-18:00 并搜索",
    "start_url": "transfer/site5/step2.html?date=2026-10-06"
  },
  {
    "role": "wizard-options",
    "desc": "在向导第 2 步把 2026-10-07（周三）的出发时段设成 08:00-18:00 并搜索",
    "start_url": "transfer/site5/step2.html?date=2026-10-07"
  },
  {
    "role": "wizard-options",
    "desc": "在向导第 2 步把 2026-10-08（周四）的出发时段设成 08:00-18:00 并搜索",
    "start_url": "transfer/site5/step2.html?date=2026-10-08"
  },
  {
    "role": "wizard-options",
    "desc": "在向导第 2 步把 2026-10-09（周五）的出发时段设成 08:00-18:00 并搜索",
    "start_url": "transfer/site5/step2.html?date=2026-10-09"
  },
  {
    "role": "sort-fares"
  },
  {
    "role": "record-lowest"
  },
  {
    "role": "sort-fares",
    "desc": "把 2026-10-06（周二）的航班列表按价格从低到高排序",
    "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-06&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-06（周二）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-06&window=0800-1800&sort=price_asc"
  },
  {
    "role": "sort-fares",
    "desc": "把 2026-10-07（周三）的航班列表按价格从低到高排序",
    "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-07&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-07（周三）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-07&window=0800-1800&sort=price_asc"
  },
  {
    "role": "sort-fares",
    "desc": "把 2026-10-08（周四）的航班列表按价格从低到高排序",
    "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-08&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-08（周四）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-08&window=0800-1800&sort=price_asc"
  },
  {
    "role": "sort-fares",
    "desc": "把 2026-10-09（周五）的航班列表按价格从低到高排序",
    "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-09&window=0800-1800"
  },
  {
    "role": "record-lowest",
    "desc": "记录 2026-10-09（周五）08:00-18:00 区间内最低价的航班",
    "start_url": "transfer/site5/fares.html?from=KMG&to=BJS&date=2026-10-09&window=0800-1800&sort=price_asc"
  },
  {
    "desc": "打开 北京 2026-10-06 入住的酒店列表，并把价格上限设为 ¥300",
    "start_url": "transfer/site5/stays.html?checkin=2026-10-06",
    "signal": {
      "css_text_contains": [
        "#cap-state",
        "300"
      ]
    },
    "target_hint": "#cap"
  },
  {
    "desc": "把 北京 2026-10-06 入住的酒店列表按价格从低到高排序",
    "start_url": "transfer/site5/stays.html?checkin=2026-10-06&cap=300",
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
    "start_url": "transfer/site5/stays.html?checkin=2026-10-06&cap=300&sort=price_asc",
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

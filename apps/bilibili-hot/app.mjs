// @amberflow:declarative-data —— 本文件是**数据**（迁移生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app bilibili-hot --write` 生成；改来源再重新生成，不要手改。
// 迁移口径：脚本的 meta()/app() 只是把 pack.json 的字段逐项搬运（含 roles/probe/invariants/journey），
// 不含任何判断；`apps:migrate --all --check` 用 expandPack 逐字段对照来源包。
const META = {
  "id": "bilibili-hot",
  "label": "B 站最热番剧：进站 → 番剧索引按热度排序 → 打开榜首番剧（真实站点，要真网络）",
  "goal": "进入 www.bilibili.com，找到今年最热番剧并打开它的播放页",
  "model": "english",
  "max_subgoals": 8,
  "hosts": [
    "www.bilibili.com",
    "api.bilibili.com"
  ],
  "slots": {
    "top_anime_url": "https://www.bilibili.com/bangumi/play/ss28747",
    "oid": "478818261"
  },
  "sources": [
    "bilibili-anime-rank",
    "bilibili-anime-comments"
  ],
  "notes": [
    "这是真实站点包，要真网络；线上应用被 `apps:suite` 识别为「要真网络」并**明着跳过**（跳过不等于通过）。",
    "**为什么「打开榜首番剧」这一步是导航而不是点击**：B 站几乎所有跨页链接都是 `target=\"_blank\"`（首页「番剧」、索引页卡片、排行榜条目，全都是）。当前引擎只跟踪单一页面，点 `_blank` 链接后当前页 URL 不变 → 判 `inert` → 重试到 max_steps。所以跨页转换用 `start_url`（引擎本来就是每个子目标重新导航），页面内的转换才用点击。这是引擎的真实边界，不是本包的取巧。",
    "`target_hint` 踩过的坑：值里带 `/` 会触发「完整 URL 匹配」档（`a[href~bilibili.com/anime/]` 因此整档落空，三步全退化到模型）。本包改用**标签 token**（`追番人数`）点名，规则层零模型成本命中。",
    "第 3 步的 `start_url` 用槽位 `{top_anime_url}`，值由**数据腿回写**（`source_slots`：取 `bilibili-anime-rank` 榜首那行的 `url`）——不再是把查到的结果抄进包里的过期字面量；换番剧时 `--slot top_anime_url=...` 注入（显式 `--slot` 仍优先于观测值）。",
    "「今年最热」的口径：B 站没有对外的年度番剧榜单接口，本包用官方**番剧排行榜（近期热度窗口）**榜首作为可达且可复现的近似，差异写在 sources/bilibili-anime-rank.json 里。",
    "**评论区这一步做不了**：番剧详情页未登录只给「请先登录或注册」；公开评论接口匿名只回 3 条（`pn` 翻页 0 条、`reply/wbi/main` -403）。所以「筛选 10 条正能量评论」在当前匿名状态下**无法完成**，需注入登录态后重跑；且「正能量」是语义判断，引擎按纪律不猜。"
  ],
  "roles": {
    "enter-site": {
      "desc": "进入 B 站首页",
      "start_url": "https://www.bilibili.com/",
      "signal": {
        "url_contains": "www.bilibili.com"
      },
      "retries": 2
    },
    "sort-anime-index": {
      "desc": "打开番剧索引并按「追番人数」排序（页面内真实点击，同标签导航）",
      "start_url": "https://www.bilibili.com/anime/index/",
      "target_hint": "追番人数",
      "signal": {
        "url_contains": "sort=1"
      },
      "retries": 2
    },
    "open-top-anime": {
      "desc": "打开榜首番剧的播放页",
      "start_url": "{top_anime_url}",
      "signal": {
        "all_of": [
          {
            "url_contains": "bangumi/play"
          },
          {
            "not": {
              "url_contains": "anime/index"
            }
          }
        ]
      },
      "retries": 2
    }
  },
  "invariants": [
    {
      "id": "end-on-anime-play-page",
      "desc": "结束时停在番剧播放页",
      "signal": {
        "all_of": [
          {
            "url_contains": "bangumi/play"
          },
          {
            "not": {
              "url_contains": "anime/index"
            }
          }
        ]
      }
    }
  ]
};
const DATA = {
  "top_anime_url": {
    "kind": "source",
    "source": "bilibili-anime-rank",
    "select": "top",
    "field": "url"
  }
};
const JOURNEY = [
  {
    "role": "enter-site"
  },
  {
    "role": "sort-anime-index"
  },
  {
    "role": "open-top-anime"
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });

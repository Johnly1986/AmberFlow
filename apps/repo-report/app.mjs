// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app repo-report --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "repo-report",
  "label": "真实工具的工具步：git（行文本）+ jq（JSON 抽取）",
  "goal": "用真实命令行工具跑一条只读链路：取最近 30 天的提交，再列出长流程用例包里的用例 id",
  "model": "english",
  "hosts": [],
  "slots": {},
  "requiredSlots": [],
  "sources": [],
  "notes": [
    "这条链路用的是**真实**命令行工具（git / jq），因此不进 CI：缺工具时测试跳过，产物也会随仓库状态变化。",
    "`git-log` 是 30 天窗口：在一个很久没有提交的旧 checkout 上它合理地返回 0 行——那时这条 signal 会不成立（这正是 audit 该报的东西，不是 bug）。",
    "读取类工具步不声明 `idempotent`，所以默认不重试；要重试必须显式 `idempotent: true`。"
  ],
  "invariants": []
};
const DATA = {};
const JOURNEY = [
  {
    "id": "git-log",
    "desc": "跑 git log 取最近 30 天的提交（每行一个 sha|作者|日期|标题）",
    "source": "git-log",
    "signal": {
      "all_of": [
        {
          "exit_ok": 0
        },
        {
          "stdout_matches": "^[0-9a-f]{7,40}\\|[^|]*\\|[0-9]{4}-[0-9]{2}-[0-9]{2}\\|"
        }
      ]
    }
  },
  {
    "id": "case-ids",
    "desc": "用 jq 列出长流程用例包里的用例 id",
    "source": "bench-cases-index",
    "signal": {
      "all_of": [
        {
          "exit_ok": 0
        },
        {
          "stdout_contains": "live-long-saucedemo-checkout"
        },
        {
          "stdout_matches": "live-long-quotes\\s*$"
        }
      ]
    }
  },
  {
    "id": "case-shape",
    "desc": "用 jq + JSON 路径断言用例包的结构（三个站点 / 各自子目标数）",
    "source": "bench-cases-shape",
    "signal": {
      "all_of": [
        {
          "exit_ok": 0
        },
        {
          "json_path_equals": [
            "[0].id",
            "live-long-saucedemo-checkout"
          ]
        },
        {
          "json_path_equals": [
            "[0].subgoals",
            "15"
          ]
        }
      ]
    }
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });

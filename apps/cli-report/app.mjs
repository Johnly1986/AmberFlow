// @amberflow:declarative-data —— 本文件是**数据**（迁移生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app cli-report --write` 生成；改来源再重新生成，不要手改。
// 迁移口径：脚本的 meta()/app() 只是把 pack.json 的字段逐项搬运（含 roles/probe/invariants/journey），
// 不含任何判断；`apps:migrate --all --check` 用 expandPack 逐字段对照来源包。
const META = {
  "id": "cli-report",
  "label": "工具步示范：命令行当动作腿（退出码 / JSON / 干跑 / 确认 / 幂等重试 / 产物）",
  "goal": "用命令行工具跑一条链路：读一次 JSON、认一次失败、重试一次瞬时错误、最后经干跑与确认落盘一个产物",
  "model": "english",
  "hosts": [],
  "slots": {},
  "notes": [
    "工具步与浏览器步共用同一套旅程词汇（signal / retries / 干跑 / 确认），只是完成真值长在进程观察面上：退出码、stdout、stderr、产物文件。",
    "三条纪律：`retries > 0` 必须显式 `idempotent: true`；`dangerous: true` 必须有 `dry_run_args`；危险步默认**拒绝**，要 `--allow-dangerous`（或注入确认钩子）才真跑。",
    "`{out_dir}` 是运行期占位符（本次运行的输出目录），不是计划里的值——产物落到运行期目录，应用包才机器无关。",
    "这条链路全部离线（桩工具），所以能进 CI；真实工具（git / jq）的对应物是 apps/repo-report。"
  ]
};
const DATA = {};
const JOURNEY = [
  {
    "id": "query-json",
    "desc": "跑一次桩工具：退出码为 0，且 JSON 里的第三行是 w-3",
    "source": "demo-tool",
    "signal": {
      "all_of": [
        {
          "exit_ok": 0
        },
        {
          "stdout_contains": "stub-tool"
        },
        {
          "json_path_equals": [
            "rows[2].id",
            "w-3"
          ]
        }
      ]
    }
  },
  {
    "id": "fail-path",
    "desc": "工具以退出码 3 失败时，用精确退出码加 stderr 事实认出来（失败也是一种可验证事实）",
    "source": "demo-tool",
    "args": [
      "--fail"
    ],
    "signal": {
      "all_of": [
        {
          "exit_code_equals": 3
        },
        {
          "stderr_contains": "boom"
        },
        {
          "not": {
            "exit_ok": 0
          }
        }
      ]
    }
  },
  {
    "id": "auth-path",
    "desc": "工具提示要登录时，stderr 信号能认出这类失败（对应浏览器面的 block_markers）",
    "source": "demo-tool",
    "args": [
      "--auth-required"
    ],
    "signal": {
      "all_of": [
        {
          "exit_code_equals": 2
        },
        {
          "stderr_contains": "authentication required"
        }
      ]
    }
  },
  {
    "id": "flaky-read",
    "desc": "前两次调用失败、第三次成功：读操作声明幂等，才允许重试",
    "source": "demo-tool",
    "args": [
      "--fail-times=2",
      "--counter={out_dir}/retry-counter-{run_id}"
    ],
    "idempotent": true,
    "retries": 3,
    "signal": {
      "all_of": [
        {
          "exit_ok": 0
        },
        {
          "stdout_contains": "rows"
        }
      ]
    }
  },
  {
    "id": "write-artifact",
    "desc": "不可逆写入：先干跑，经确认后落盘一个产物文件",
    "source": "demo-tool",
    "args": [
      "--write={out_dir}/cli-report-artifact.txt",
      "--query=report"
    ],
    "dry_run_args": [
      "--write={out_dir}/cli-report-artifact.txt",
      "--query=report",
      "--dry-run"
    ],
    "dangerous": true,
    "signal": {
      "all_of": [
        {
          "exit_ok": 0
        },
        {
          "stdout_contains": "wrote"
        },
        {
          "file_exists": "{out_dir}/cli-report-artifact.txt"
        }
      ]
    }
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });

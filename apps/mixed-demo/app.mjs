// @amberflow:declarative-data —— 本文件是**数据**（迁移/生成），不是逻辑：
//   应用目录仍受"0 行逻辑代码"约束；只有带这个标记的文件允许出现在 apps/<id>/ 下。
// 由 `npm run apps:migrate -- --app mixed-demo --write` 或 apps:gen 生成；改来源再重新生成，不要手改。
const META = {
  "id": "mixed-demo",
  "label": "应用包示范：同一旅程混用 web + cli + ssh + stdio（真实 sshd + 真实交互进程）",
  "goal": "加购一件商品 → cli 产出令牌 → 真实 ssh 把令牌写到远端再读回 → cli 消费远端值 → 浏览器用数据集里的优惠券码填表并应用 → 玩一局真实交互式猜数字游戏 → cli 消费游戏的返回值",
  "model": "english",
  "max_subgoals": 8,
  "notes": [
    "这是**多类型应用**的完整示范：一条旅程里依次执行 web → cli → ssh → cli → web → stdio → cli，类型由适配器注册表分派，runner 里没有类型分支。",
    "返回值传递覆盖三条通路：① cli→ssh（cli 的 stdout_regex → 数据集 → ssh 远端命令的 {dataset:token}）；② ssh→数据集→浏览器命令绑定（{from:\"dataset\", key:\"coupon\"} 填表）；③ stdio→cli（游戏的返回值 → 数据集 → 下一 cli 步 argv）。缺失值一律结构化 needs_value，不猜。",
    "真实场景：ssh 是本机 sshd（key 认证）；stdio 是真实子进程的提示-应答会话（bench/fixtures/guess-game.mjs，一局 7 次猜中）。",
    "前置条件：本机 sshd 在跑且 `ssh localhost` 免交互可用。`apps:suite` 会探测该能力：不可用时**如实跳过**（跳过 ≠ 通过）；直接 `npm run apps -- --app mixed-demo` 在缺服务时如实失败。",
    "边界（Slice 3）：stdio 是行文本协议、没有 pty 语义，也不支持 retries/dangerous；ssh 的 dangerous/干跑语义未实现；ssh argv 走远端 shell（与本地 cli 的 argv-array-永不过-shell 不同，转义由声明者负责）。",
    "结束态不变量是**类型无关**的：web 不变量在浏览器结束态上求值；ssh/cli 不变量是旅程结束后的**只读观察探针**（这里：远端文件还在、工具错误路径仍可观察）——不是重放旅程，也不是模型转述。"
  ],
  "invariants": [
    {
      "id": "coupon-applied",
      "desc": "结束时优惠券已应用（浏览器结束态，在 cli/ssh/stdio 步骤之后仍然成立）",
      "signal": {
        "css_text_contains": [
          "[data-test=coupon-msg]",
          "Coupon applied"
        ]
      }
    },
    {
      "id": "remote-token-file",
      "adapter": "ssh",
      "desc": "远端产物 ssh-token 仍在且非空（只读探针：test -s；不重放写动作）",
      "ssh": {
        "host": "localhost",
        "argv": [
          "test",
          "-s",
          "{out_dir}/ssh-token"
        ]
      },
      "signal": {
        "exit_ok": true
      }
    },
    {
      "id": "cli-error-path",
      "adapter": "cli",
      "desc": "桩工具的错误路径仍可观察（退出码 3 + stderr 事实）——错误也是可验证事实",
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
          }
        ]
      }
    }
  ]
};
const DATA = {};
const JOURNEY = [
  {
    "id": "web-cart",
    "adapter": "web",
    "desc": "把 TrailBottle 加入购物车（web 步）",
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
  {
    "id": "produce-token",
    "adapter": "cli",
    "desc": "cli：产出一个令牌（returns → 数据集）",
    "source": "demo-tool",
    "args": [
      "--query=widgets"
    ],
    "signal": {
      "exit_ok": true
    },
    "returns": {
      "token": {
        "from": "stdout_regex",
        "pattern": "\"query\":\\s*\"([a-z]+)\""
      }
    }
  },
  {
    "id": "remote",
    "adapter": "ssh",
    "desc": "ssh：把令牌写到远端再读回，并从同一次远端输出里抽出优惠券码",
    "ssh": {
      "host": "localhost",
      "argv": [
        "mkdir -p {out_dir} && echo {dataset:token} > {out_dir}/ssh-token && cat {out_dir}/ssh-token && printf 'ACME10\\n'"
      ]
    },
    "signal": {
      "exit_ok": true,
      "stdout_contains": "widgets"
    },
    "returns": {
      "remote": {
        "from": "stdout_regex",
        "pattern": "([a-z]+)"
      },
      "coupon": {
        "from": "stdout_regex",
        "pattern": "(ACME10)"
      }
    }
  },
  {
    "id": "consume-remote",
    "adapter": "cli",
    "desc": "cli：消费 ssh 读回的值（{dataset:remote}）",
    "source": "demo-tool",
    "args": [
      "--query={dataset:remote}"
    ],
    "signal": {
      "exit_ok": true,
      "stdout_contains": "widget widgets"
    }
  },
  {
    "id": "web-coupon",
    "adapter": "web",
    "desc": "web：用数据集里的优惠券码填表并应用（命令绑定 {from:\"dataset\"}）",
    "start_url": "bench/fixtures/shop_cart.html",
    "commands": [
      {
        "id": "fill-coupon",
        "op": "fill",
        "target": "[data-test=coupon]",
        "value": {
          "from": "dataset",
          "key": "coupon"
        }
      },
      {
        "id": "apply-coupon",
        "op": "click",
        "target": "[data-test=apply-coupon]"
      }
    ],
    "signal": {
      "css_text_contains": [
        "[data-test=coupon-msg]",
        "Coupon applied"
      ]
    }
  },
  {
    "id": "game",
    "adapter": "stdio",
    "desc": "stdio：玩一局真实交互式猜数字游戏（提示-应答-信号）",
    "stdio": {
      "argv": [
        "node",
        "bench/fixtures/guess-game.mjs",
        "--secret=42"
      ],
      "script": [
        {
          "when": "Guess a number",
          "send": "50"
        },
        {
          "when": "Too high",
          "send": "25"
        },
        {
          "when": "Too low",
          "send": "37"
        },
        {
          "when": "Too low",
          "send": "43"
        },
        {
          "when": "Too high",
          "send": "40"
        },
        {
          "when": "Too low",
          "send": "41"
        },
        {
          "when": "Too low",
          "send": "42"
        }
      ],
      "timeout_ms": 20000
    },
    "signal": {
      "exit_ok": true,
      "stdout_contains": "You win"
    },
    "returns": {
      "tries": {
        "from": "stdout_regex",
        "pattern": "in (\\d+) tries"
      }
    }
  },
  {
    "id": "consume-tries",
    "adapter": "cli",
    "desc": "cli：消费游戏返回值（{dataset:tries} 进了 argv，桩工具把 argv 原样回显）",
    "source": "demo-tool",
    "args": [
      "--query={dataset:tries}"
    ],
    "signal": {
      "exit_ok": true,
      "stdout_contains": "--query=7"
    }
  }
];

export const meta = () => META;
export const app = () => ({ data: DATA, exec: JOURNEY });

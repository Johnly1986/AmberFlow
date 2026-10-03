# `apps/` —— 应用包（一个应用一个目录）

这个目录回答一个问题：**接入一个新应用，要改多少共享代码？** 答案是**零**。

```
apps/<app>/
  sources/*.json    # 数据腿：这个应用从哪取数（HTTP 抓取 或 命令行工具），怎么抽字段
  pack.json         # 动作腿（规划中）：旅程怎么走（roles/phases/signals/invariants）
  bin/              # 可选：这个应用自带的可执行文件（桩工具/包装脚本）
  README.md         # 可选：这个应用自己的说明
```

目录是**发现制**：`src/datasource.ts` 的 `sourceDirs()` 会扫 `<repo>/*/sources` 与
`<repo>/apps/*/sources`，没有一张"应用清单"要维护。验证一下：

```bash
node --experimental-strip-types src/datasource.ts --list
node --experimental-strip-types src/datasource.ts --source git-log --out /tmp/apps
```

## 一、数据腿：`transport.client = "cli"`

引擎的传输层是"一族客户端"：`curl`（子进程）、`httpx`（Node 全局 fetch）、`cli`（**任意命令行工具**）。
`curl` 那一档的经验直接搬过来——ctrip 的 H5 线路页在浏览器里 432，在 curl 里 200，所以取数走子进程，
渲染与决策走 harness。CLI 工具是同一件事的一般化：**引擎只知道"有一族客户端叫 cli"，工具名只出现在配置里。**

```jsonc
{
  "name": "git-log",
  "transport": {
    "client": "cli",
    "url_template": "{since}",                  // 目标模板（引擎按日期参数拼好，作为 {url} 交给 argv）
    "cli": {
      "bin": "git",                             // 可执行文件（名字或路径）
      "argv": ["log", "--since={url}", "--pretty=format:%h|%an|%ad|%s"],
      "cwd": ".",                               // 相对仓库根
      "exit_ok": [0]                            // 这些退出码算成功（diff/grep 那种语义化退出码用得上）
    },
    "version_pin": "git version 2.",            // 不匹配就响亮报错
    "version_argv": ["--version"]
  },
  "date": { "params": { "since": "date-30day" } },
  "extract": {
    "kind": "lines_regex",                      // 行文本；整份 JSON 见 json_stdout
    "fields": { "sha": "^([0-9a-f]{7,40})\\|", "subject": "^[^|]*\\|(.+)$" }
  },
  "counts": [{ "key": "commits", "label": "提交数" }],
  "audits": [{ "key": "no_subject", "label": "缺标题行", "field": "subject", "empty": true }],
  "report": { "title": "最近 30 天的提交（git）" }
}
```

### `transport.cli` 就六个键（未知键在加载期报错）

| 键 | 含义 | 默认 |
|---|---|---|
| `bin` | 可执行文件（**不是**命令字符串） | 必填 |
| `argv` | 参数数组；`{url}` 与 `constants` 里的键会被替换，**其余花括号原样保留** | 必填 |
| `env_allow` | 环境变量白名单（`PATH` 永远保留，否则找不到可执行文件） | 不给 = 整体继承 |
| `cwd` | 工作目录（相对仓库根） | 仓库根 |
| `exit_ok` | 算成功的退出码 | `[0]` |
| `stdin` | 写进标准输入的内容 | 不给 = 不写 |

### 两条硬规矩

1. **argv 是数组，`shell: false`，永不过 shell。** 槽位/模板里的 `;`、`$(...)`、反引号、`|`
   只会作为普通参数传给进程——`tests/cli-transport.test.ts` 里有一条测试真的拿这些字符串去打一个
   临时文件，并断言文件不存在。页面上误点最多点错，字符串拼接能执行，所以这条不能松。
2. **`env_allow` 是白名单，凭据不进计划。** 计划是受审的冻结产物；密钥只从环境/钥匙串按**名字**引用。

### 版本 pin：工具输出会随版本漂移

与「冻结语料不能依赖墙上时钟」（`LAYA_TODAY`）同型：`version_pin` 是版本输出里的一个子串，
不匹配就抛 `ValueError`，并把实测版本写进结果与报告（`tool_version` / `抓取通道：cli（git，版本 pin …）`）。

### stdout 的两种形状

| `extract.kind` | 用在什么输出上 | 必填 |
|---|---|---|
| `lines_regex` | 一行一条（`git log`、`jq -r`、`ls -l`）：逐行匹配、空行跳过、全空字段的行不计入 | `fields`（每个恰好 1 个捕获组） |
| `json_stdout` | 整个 stdout 是一个 JSON 文档（`jq -c .`、`--print_format json`） | `rows`（哪个数组是数据行） |
| `line_sep` | `lines_regex` 的分隔符 | 默认换行 |

`html_regex` 保持原样（它是 HTML 口径，`split` 后会**丢掉第一块**）；行文本有自己的抽取器，别复用。

## 二、动作腿：`pack.json`（角色 → 冻结计划 → 结束状态验收）

`apps/<app>/pack.json` 把三样东西绑在一起：**动作腿**（`journey` 用 `roles` 里的模板串起来）、
**数据腿**（`sources` 引用数据源配置）、**验收**（`invariants` 是旅程结束状态上的断言）。
跑一条完整链路：

```bash
npm run apps -- --list                                  # 发现了哪些应用包
npm run apps -- --app demo-app --dry                     # 只展开计划（不开浏览器、不装模型）
npm run apps -- --app demo-app --no-model                # 离线整跑（脚本模型，CI 可跑）
npm run apps -- --app demo-app                            # 真模型（需要 1.7GB ONNX 产物）
npm run apps:matrix                                      # 度量：声明行 / 代码行 / 防泄漏
```

```jsonc
{
  "spec_version": 1,
  "id": "demo-app",
  "label": "……",
  "goal": "……",                       // 一句话目标（只给人看；每个子目标只喂自己的 desc 给模型）
  "model": "english",                  // 或 multilingual / router
  "max_subgoals": 8,                   // 预算：超了加载期就报错，而不是让计划无限长大
  "hosts": [],                         // 这个应用声明的站点（防泄漏检查会用到）
  "slots": { "coupon": "ACME10" },     // 数据袋：值只来自计划，模型不许发明
  "required_slots": ["coupon"],        // 缺了就加载期报错
  "sources": ["demo-tool"],            // 数据腿：本目录或别的应用的 source
  "roles": {
    "apply-coupon": {                  // 角色 = 可复用的步骤模板（desc/signal/hint/slots/when/retries）
      "desc": "在购物车输入优惠券 {coupon} 并应用",
      "start_url": "bench/fixtures/shop_cart.html",
      "target_hints": ["[data-test=coupon]", "[data-test=apply-coupon]"],
      "slots": { "coupon": "{coupon}" },
      "signal": { "css_text_contains": ["[data-test=coupon-msg]", "Coupon applied"] }
    }
  },
  "journey": [ { "role": "apply-coupon" } ],   // 也能内联写整步；模板与内联字段合并，内联优先
  "invariants": [
    { "id": "on-thanks-page", "desc": "……", "signal": { "url_contains": "shop_thanks.html" } }
  ]
}
```

要点：

- **角色优先，别复制步骤**：同一套角色在多个应用间复用，矩阵里"角色数"就是一个数字；
  跨应用比的是"映射了几个角色"，不是"抄了几段步骤"。
- **`{slot}` 占位符只替换已声明的槽位**，其余花括号原样保留；未知占位符加载期报错。
- **`invariants` 在会话结束状态上求值**（同一个 page、同一份 cookie），所以能表达"下单后购物车已清空"
  这类验收。它看不见**中间**要求——中间要求写成子目标信号。
- **校验复用冻结计划那一套**：`PlanningRules.problems` 负责信号/hint/`when`/`retries`，
  应用包不新开第二套语法校验器。
- 相对 `start_url` 按仓库根解析成 `file://`（与 bench 同口径），所以应用包可以随仓库搬走。

## 三、多类型工具的复核清单

同一套引擎、同一套 `counts/audits/selects/report`，覆盖四类工具：

| 类型 | 例子 | 通道 / 抽取 | 在哪里验证 |
|---|---|---|---|
| HTTP 客户端 | ctrip H5（curl 200 / 浏览器 432） | `curl` / `httpx` + `json_in_script`·`html_regex` | `npm run parity:datasource`（163 项冻结对拍） |
| 合成桩（CI 无条件） | `apps/demo-tool/bin/stub-tool.mjs` | `cli` + `json_stdout` | `tests/cli-transport.test.ts` |
| 行文本工具 | `git log` | `cli` + `lines_regex` | 同上（缺 git 时 SKIP） |
| JSON 工具 | `jq`（输入是仓库里的用例包） | `cli` + `json_stdout` / `lines_regex` | 同上（缺 jq 时 SKIP） |

## 四、工具步：命令行作为旅程中的一步

当 CLI 不只是"取数"，而是**旅程里的一步且要判定完成**时，它就是**工具步**——与浏览器步共用同一套
旅程词汇（`signal` / `retries` / 干跑 / 确认），只是完成真值长在**进程观察面**上：

```jsonc
{
  "id": "write-artifact",
  "desc": "不可逆写入：先干跑，经确认后落盘",
  "source": "demo-tool",                          // 复用数据源配置（argv/env/cwd/exit_ok/版本 pin）
  "args": ["--write={out_dir}/report.txt"],        // 追加参数；{slot} 与 {out_dir} 都会替换
  "dry_run_args": ["--write={out_dir}/report.txt", "--dry-run"],
  "dangerous": true,                               // 需要 dry_run_args，且默认拒绝执行
  "signal": {
    "all_of": [
      { "exit_ok": true },                         // 退出码在 source 的 exit_ok 白名单里
      { "stdout_contains": "wrote" },
      { "file_exists": "{out_dir}/report.txt" }     // 产物真的落地了
    ]
  }
}
```

进程观察面的信号叶子（同一个组合语法：`all_of` / `any_of` / `not`，递归）：

| 叶子 | 看的事实 |
|---|---|
| `exit_ok` | 退出码在 `exit_ok` 白名单里（最常用的"跑成功了"） |
| `exit_code_equals` | 精确退出码（`grep` / `diff` 那种语义化退出码） |
| `stdout_contains` / `stdout_matches` | 产物里的事实 / 形状（正则） |
| `stderr_contains` | 失败原因（"要登录"这类；对应浏览器面的 `block_markers`） |
| `json_path_equals` | 结构化产物里的一个字段（复用数据源的路径语言） |
| `file_exists` / `file_absent` | 副作用落地了吗 |

三条纪律（都来自"浏览器里重点一次很便宜、命令行重跑可能不可逆"）：

1. **默认不重试**：`retries > 0` 必须显式 `idempotent: true`，否则加载期报错；
2. **不可逆先干跑**：`dangerous: true` 必须有 `dry_run_args`，干跑不成功就不 apply；
3. **确认才动手**：`dangerous` 步默认**拒绝**，只有 `--allow-dangerous`（或注入 `confirmToolStep`）
   点头才真跑；拒绝会作为显式结果上报（`refused: dangerous | declined | dry-run-failed`），不是静默跳过。

`{out_dir}` 是**运行期占位符**（本次运行的输出目录，`--out` 决定），不是计划里的值——产物落到运行期目录，
应用包才机器无关。看两条示范：

```bash
npm run apps -- --app cli-report --no-model --allow-dangerous   # 桩工具：退出码/JSON/stderr/幂等重试/干跑+确认+落盘
npm run apps -- --app repo-report --no-model                    # 真实工具：git（行文本）+ jq（JSON）
npm run apps -- --app cli-report --no-model                     # 不带 --allow-dangerous：危险步被拒绝、不落盘
```

## 五、还没做的（诚实清单）

| 项 | 现状 |
|---|---|
| **数据腿 → 动作腿的绑定**（`bind: {slot: "source.selects.x.field"}`） | 没做。等出现第二个真实消费者再加语法（一个消费者不值得造一条语法） |
| **把每站点专用驱动迁进应用包** | 没做。`apps:matrix` 的"债"那一栏就是进度条（当前 `live-probe` / `live-capture` 3 处站点知识） |
| **交互式 TTY 工具**（`ssh` 提问、编辑器） | 明确不做。真需要人参与就走 `{"signal":{"manual":true}}` + 人工背书 |
| **阶段性不变量**（旅程中途的验收） | 没做。中间要求现阶段写成子目标信号；`invariants` 只长在浏览器结束状态上 |


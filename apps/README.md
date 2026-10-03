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

## 二、多类型工具的复核清单

同一套引擎、同一套 `counts/audits/selects/report`，覆盖四类工具：

| 类型 | 例子 | 通道 / 抽取 | 在哪里验证 |
|---|---|---|---|
| HTTP 客户端 | ctrip H5（curl 200 / 浏览器 432） | `curl` / `httpx` + `json_in_script`·`html_regex` | `npm run parity:datasource`（163 项冻结对拍） |
| 合成桩（CI 无条件） | `apps/demo-tool/bin/stub-tool.mjs` | `cli` + `json_stdout` | `tests/cli-transport.test.ts` |
| 行文本工具 | `git log` | `cli` + `lines_regex` | 同上（缺 git 时 SKIP） |
| JSON 工具 | `jq`（输入是仓库里的用例包） | `cli` + `json_stdout` / `lines_regex` | 同上（缺 jq 时 SKIP） |

## 三、动作腿（下一步）：CLI 是旅程中的一步

当 CLI 不只是"取数"，而是**旅程里的一步且要选**（选哪个子命令/flag、这步算不算完成）时，
形状与浏览器面一一对应，但不新开一套语言：

| 浏览器面 | CLI 面 |
|---|---|
| 元素池 | 退出码 + stdout/stderr（head+tail）+ 产物文件 |
| `target_hint` | argv token / flag（计划点名，规则零成本命中） |
| 完成信号 | `exit_code_equals` / `stdout_contains` / `json_path_equals` / `file_exists`（叶子家族新增，`all_of/any_of/not` 复用） |
| 风险门 | 破坏性 flag 规则（`--force`、`-rf`、`deploy`）+ **干跑优先**（`dry_run_flag`） |
| `retries` | 看幂等性：`idempotent: false` 的步骤默认只跑一次 |

**不可逆动作（部署/推送/删除）单独一类**：两阶段（干跑/计划文件 → 人工确认 → apply），`retries` 强制为 0。
交互式 TTY 工具（`ssh` 提问、编辑器）不在范围内——真需要人参与就走 `{"signal":{"manual":true}}` + 人工背书。

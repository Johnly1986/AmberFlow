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
npm run apps -- --app demo-app                # 离线整跑（默认走真模型；缺产物时如实降级）
npm run apps -- --app demo-app                            # 真模型（需要产物；缺了 `npm run model:fetch` 补）
npm run apps:matrix                                      # 度量：声明行 / 代码行 / 防泄漏 + 上次套件的模型咨询两列
npm run apps:suite                                       # 一条命令验收所有离线旅程应用（结论表 + 退出码）
```

每次运行都带**两行模型账**（`docs/LAYA_VALUE_PLAN.md` P0/P1：保险的价值要看得见）：

- `model: on | off(missing) | off(rules-only)`——此刻跑在哪一层（DSH 桥的 `amberflow_run` summary 念同一行）；
- `决策来源：rule 19 · laya 1 (conf 0.31) · laya:reobserve 1 · 模型被咨询 N 次（…未过闸门） · cache 命中 N/M forwards`——
  出场率 / 挽回 / 缓存三组数。口径：过关数在 trace 里数，**咨询数在运行时缝上数**（低置信的咨询不在 trace 留
  `method`，只数 trace 会把 `transfer-slowjet` 这种"问了、没过、靠 retries"的在场漏报成零出场）。
  `apps:suite` 的"模型咨询"列与 `apps:matrix` 的两列读的是**上一次真跑**落下的 `*-result.json`；
  matrix 上"未跑"≠0——前者是没证据，后者是真跑过且规则消化了全部（结论列直接写 `model not needed`）。
- **模型边际**（`模型边际` 列）：梯级只有低一级没决定才轮到模型，所以 `model_steps` 就是模型在这条
  语料上的**独立贡献**。桩臂打"未测"（它的 0 是构造出来的，不是证据）；真模型臂（`--real-model`）
  若合计为 0 ⇒ 退出码 4 + 页脚写明"运行期弹性主张不成立"。出处：
  [docs/ARCHITECTURE_IMPROVEMENTS.md](../docs/ARCHITECTURE_IMPROVEMENTS.md) §5/§7。

**运行策略可以声明**（`pack.policy`，缺省 = 今天的行为；优先级 CLI 本次 > 包声明 > 缺省）：

| 键 | 作用 | 缺省 |
|---|---|---|
| `tiered_hint` | hint 档内歧义时改问"这几个候选里哪个"（窄问） | `false` |
| `risk_ask` | `rules-only` = 只信 `DESTRUCTIVE_PATTERNS`，不再每步花一次前向问"要不要拦"（实测 5.6–7.7× 提速，结果逐字段相同） | `"always"` |
| `reobserve` | 低置信要停之前，加宽重看一次（120 元素） | `true` |
| `max_effective_repeats` | 同一元素"有效重复"的上界，超了就 `no_progress` | `3` |

生效值与来源写进 `<app>-result.json` 的 `effective_policy` 与报告行；**四项都缺省时这个字段整个不存在**
（缺省等价：不声明的包输出逐字节不变）。未知键/错类型加载期报错。

**退出码契约**（`npm run apps` 与 `npm run apps:suite` 都写进了 `--help`）：

| 命令 | 码 | 含义 |
|---|---|---|
| `npm run apps` | `0` | 动作腿与不变量全部成立 |
| | `1` | 有子目标 blocked / 有工具步未完成 / 有不变量不成立（**危险步没放行也是 1，并且在输出里写明"未执行"**） |
| | `2` | 用法错误：包不合法、`--slot` 的键没声明、`--out` 建不出来、测量型应用没有 journey |
| `npm run apps:suite` | `0` | 每个离线旅程应用都真执行且通过（默认臂 = 脚本桩） |
| | `1` | 有未通过（含"加载失败"：坏包只影响它自己那一行，其余照常出表） |
| | `2` | 用法错误（例如 `--only` 没匹配到任何应用，会列出已知应用名） |
| | `3` | 有**未执行**（危险步没放行——不算绿也不算红，因为绿色的前提是真的执行过） |
| | `4` | **仅 `--real-model` 臂**：应用全过，但"模型边际"= 0（模型一步也没独立决定）⇒ 运行期弹性主张不成立，绿色不许替它背书 |

优先级 `1 > 3 > 4`：**没真执行完的运行不配被判定"模型有没有用"**——所以先报未通过/未执行，
只有"全部真执行且通过"才轮到问边际。规则是纯函数 `suiteExitCode()`，回归在 `tests/apps.test.ts`。

给脚本消费：`npm run --silent apps:suite -- --json`（`npm run` 默认会往 stdout 前加 3 行脚本头，直接
`JSON.parse` 会被它挡住；或者干脆 `node --experimental-strip-types tools/apps_suite.ts --json`）。
`--only` 没匹配到任何应用时，人类可读的消息走 stderr，stdout 是 `{"error":…,"exit_code":2}`。

两条**文档以前没说、但会咬人**的规则：

1. **浏览器步必须有一个能点到的目标**：`target_hint` / `target_hints`（计划点名 → 零模型调用），或至少让规则/
   laya 能在元素池里命中一个元素。缺了就会 `blocked`，报错直说
   `step N names no target: no target_hint(s), no rule matched any of the K element(s)…`。
2. **`--slot k=v` 的键必须在包里声明过**（`slots` / `required_slots`）：打错名字现在 exit 2 并列出已声明的槽位
   （以前是静默忽略 + 假绿）。

一个可复制粘贴的最小应用在 [../README.md](../README.md) 的"应用层"一节（整包 JSON，逐字节复制即可跑绿）。

### 流程也不是手写的：`spec → pack`

```bash
npm run apps:gen -- --list                                  # 有哪些 spec 可生成 / 哪些应用已挂上
npm run apps:gen -- --write --id transfer-trekly --spec trekly   # 生成或刷新一个包
npm run apps:gen -- --write                                 # 刷新所有已挂上的
npm run apps:gen -- --check                                 # 门禁口径：旅程 == emitPlan(spec) 的展开且哈希匹配
```

流程的来源有两种（`generated_from` 里二选一）：

| 来源 | 写法 | 什么时候用 |
|---|---|---|
| spec 文件 | `{ "spec": "transfer/specs/trekly.json" }` | 流程已经是一份 spec（`emitPlan` 展开） |
| **模块导出** | `{ "source": "src/ip-config.ts#buildAppPlan" }` | 流程的判断写在**代码**里（例如"保存要认回显的值""规划表写错的行预期被设备页拒绝"）——驱动与生成器共用同一份，谁也漂移不了 |

```bash
npm run apps:gen -- --write --id ip-config --source src/ip-config.ts#buildAppPlan
```

生成物里 `generated_from` 就是这份承诺：**对齐是构造性质，不是人工核对**。
任何一侧漂移都会让 `--check` 变红（手改 `journey`、改了 spec 没重新生成，都会抓到）；`bench/smoke.sh`
已经把它当成一条门禁。生成器**沿用你已有的结构**（角色名、哪些字段是逐实例覆盖），只把**值**换成展开结果——
所以它不会重排你的包，也不会重新发明角色名。**它不生成判断**：`invariants` / `notes` 仍然是人的，
缺 `invariants` 时它会明着提示（那意味着这个应用什么都不验证）。

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
npm run apps -- --app cli-report --allow-dangerous   # 桩工具：退出码/JSON/stderr/幂等重试/干跑+确认+落盘
npm run apps -- --app repo-report                    # 真实工具：git（行文本）+ jq（JSON）
npm run apps -- --app cli-report                     # 不带 --allow-dangerous：危险步被拒绝、不落盘

npm run apps -- --app ctrip-case --no-sources        # 19 个冻结子目标跑本地复刻站（与 src/ctrip-task.ts 的计划逐字段全等）
npm run apps -- --app ip-config                     # Excel IP 规划表 → 设备网络页（含"表格写错的那行由设备页自己拒绝"）
npm run apps -- --app camera-entry                   # Excel 类型列路由两套表单（空类型行用行内证据、坏序列号显式拒绝）
npm run apps -- --app transfer-voyagio --no-sources  # 第二个复刻站的完整旅程：两页向导（24 步）
npm run apps -- --app transfer-slowjet --no-sources  # 第三个复刻站：冷启动重试（retries 真的被用上）
npm run apps -- --app transfer-trekly --no-sources   # 第四个复刻站：价格上限是滑块（32 → 12 条）
npm run apps -- --app transfer-farehaven --no-sources # 第五个复刻站：条件浮层 when（20 done + 4 skipped）
npm run apps -- --app transfer-skybook --no-sources   # 第六个复刻站：23 步、唯一带分页的骨架
npm run apps -- --app transfer-flyquest --no-sources  # 第七个复刻站：结果页只能靠提交搜索表单到达
npm run apps -- --app qunar-live --out /tmp/qunar                # 线上应用（真网络 + 真模型；包里声明了 iPhone 设备面）
```

应用清单与"完成一个应用"的五条定义在 [apps/INVENTORY.md](INVENTORY.md)；独立复核（题 → 命令 → 原始观测 → 结论）
在 [bench/APP_VERIFY_REPORT.md](../bench/APP_VERIFY_REPORT.md)。

**"所有应用都完成了吗"的退出码**：

```bash
npm run apps:suite                     # 跑完每个旅程型应用的验收（离线口径，一条命令）
npm run apps:suite -- --only ctrip-case,ip-config
npm run apps:suite -- --json
```

线上那道题（`apps/qunar-live`，需网络 + 真模型）不在套件里跑——`isLive()` 会因为它的 `start_url` 是
`https://` 而**明着跳过**；它的验收是自己一条命令，证据在 `apps/INVENTORY.md` §五。

三条口径：① 线上旅程（`start_url` 是 `http(s)://`）与测量型应用（只声明 probe）**自动识别**并明着跳过——
"没跑"不会被算成绿；② 一律脚本模型 + 不跑数据腿，所以离线可复现；③ 需要显式放行的危险步
（如 `apps/cli-report` 的不可逆写入）会记成 **待放行(未执行)**：既不算绿也不算红，因为绿色的前提是真的执行过。

## 五、应用支持器（AppAdapter）：一次旅程可以混用多种应用类型

动作腿的类型不再写死在核心。`src/app-adapters.ts` 的**注册表**声明"一种应用类型 = 一个支持器"：
声明面（该类型的步键 + 加载期校验）、信号面（web = DOM 信号；cli = 进程观察面）、执行（`run`）、
返回值（`returns`，Slice 2 起）。包里的 journey 是**类型无关**的步骤序列，每步用 `adapter` 指名类型：

```jsonc
{ "id": "open-page",  "adapter": "web",  "start_url": "testpages/product.html",
  "desc": "打开页面", "signal": { "css_exists": "main" } }
{ "id": "run-report", "adapter": "cli",  "source": "demo-tool",
  "desc": "跑一次桩工具", "signal": { "exit_ok": true } }
```

- **向后兼容**：不写 `adapter` 时按既有推断（有 `source` ⇒ `cli`，否则 ⇒ `web`），20+ 个既有应用包
  一个字节都不用改；切片 1 的全部产物与套件结果逐字节/逐行不变。
- **专属键白名单**：写错类型（web 步带 `source`、cli 步带 `start_url`）**加载期就红**并点名归属。
- **加一种应用类型 = 注册一个支持器**，不改 `app-pack` / `app-runner` 的核心分支。

**ssh 步**（真实本机 sshd）与 **stdio 步**（交互式进程/游戏）见示范应用 `apps/mixed-demo`：

```jsonc
{ "id": "remote", "adapter": "ssh", "desc": "把令牌写到远端再读回",
  "ssh": { "host": "localhost",
           "argv": ["mkdir -p {out_dir} && echo {dataset:token} > {out_dir}/ssh-token && cat {out_dir}/ssh-token"] },
  "signal": { "exit_ok": true, "stdout_contains": "widgets" },
  "returns": { "remote": { "from": "stdout_regex", "pattern": "([a-z]+)" } } }
```

`ssh` 的信号与工具步同一条进程观察面（exit/stdout/stderr，**没有**本地 `file_*`）；`retries` 需 `idempotent`；
`dangerous`/干跑语义尚未实现（加载期拒绝）。**ssh 的 argv 走远端 shell**（ssh 客户端拼接后交给远端 shell），
与本地 cli 的"argv 数组永不过 shell"不同——转义由声明者负责。

**stdio 步**（游戏/任意交互式进程：提示-应答-信号，行文本协议）：

```jsonc
{ "id": "game", "adapter": "stdio", "desc": "玩一局猜数字游戏",
  "stdio": {
    "argv": ["node", "bench/fixtures/guess-game.mjs", "--secret=42"],
    "script": [                                  // 有序：等到 when 正则 → 写一行 send
      { "when": "Guess a number", "send": "50" },
      { "when": "Too high", "send": "25" },
      { "when": "Too low", "send": "37" }
    ],
    "timeout_ms": 20000                          // 交互式进程必须有界
  },
  "signal": { "exit_ok": true, "stdout_contains": "You win" },
  "returns": { "tries": { "from": "stdout_regex", "pattern": "in (\\d+) tries" } } }
```

stdio 的完成真值仍是进程观察面；`retries`/`dangerous` 不支持（加载期拒绝），`{dataset:NAME}` 可喂 `send` 与 `argv`。
完整示范（web+cli+ssh+stdio 一条旅程、三条传值通路）：`apps/mixed-demo`。

**返回值传递（`returns` → `{dataset:NAME}`）**：进程族步（cli/ssh）可在信号成立后抽取值写进运行级数据集，
后续步骤用 `{dataset:NAME}` 消费（浏览器命令步则用 `{"from":"dataset","key":"NAME"}`）：

```jsonc
{ "id": "produce", "adapter": "cli", "source": "demo-tool", "args": ["--query=widgets"],
  "signal": { "exit_ok": true },
  "returns": { "token": { "from": "stdout_regex", "pattern": "\"query\":\\s*\"([a-z]+)\"" } } }
{ "id": "consume", "adapter": "cli", "source": "demo-tool", "args": ["--query={dataset:token}"],
  "signal": { "exit_ok": true, "stdout_contains": "widget widgets" } }
```

加载期对账：`returns.NAME` 产者唯一、每个 `{dataset:NAME}` 必须真有产者；运行期缺失/陈旧 ⇒ 结构化
`needs_value`（不猜、不空串）。**注意**：需要本机服务的类型（如 ssh）在 `apps:suite` 里会自动做能力探测，
不可用则**如实跳过**（跳过 ≠ 通过）。

设计、契约与真实场景验收表见 [docs/APP_SUPPORTER_DESIGN.md](../docs/APP_SUPPORTER_DESIGN.md)。

## 六、探针集：把「线上能不能打开」也变成数据

测量型应用（探针）与旅程型应用共用一个 `pack.json`，只是声明的是 `probe` 块而不是 `journey`：

```jsonc
{
  "hosts": ["m.ctrip.com", "hotels.ctrip.com"],        // 声明 + 防泄漏门禁的输入
  "journey": [],
  "probe": {
    "date": "2026-10-05",
    "results_dir": "ctrip/results",
    "home":  { "id": "home", "label": "首页预热", "short": "www.ctrip.com", "url": "https://www.ctrip.com/" },
    "http":  [ { "id": "flight_list_cn", "label": "PC 机票列表", "short": "flights.ctrip.com",
                 "url": "https://flights.ctrip.com/online/list?depdate={date}" } ],
    "browser": ["flight_list_cn"],                      // 用真浏览器再验一次的 http 目标
    "repeat":  { "id": "flight_list_cn", "times": 5 },   // 重复请求（打掉"一次偶然"）
    "alts":    [ { "id": "itinerary-oneway", "url": "..." } ],
    "mobile":  [ { "id": "trip-hk-flight", "url": "...{date}" } ],
    "capture": [ { "id": "flights", "label": "…", "url": "...{date}&cabin=y_s" } ],
    "roles":   { "flight": "flight_list_cn", "hotel": "hotel_list_cn" },   // 判决引用目标用角色名
    "markers": { "gate_text": ["whaleguard"], "login_text": ["登录以查看会员价"], "price_re": "..." },
    "login":   { "hosts": ["passport.ctrip.com"], "paths": ["/login"], "titles": ["登录首页"] }
  }
}
```

**设备面**：只有手机版页面存在的站点（`touch.` 域）必须声明 `device`，否则桌面 UA/视口下 DOM 不同、
计划点名的目标不在元素池里，hint 必然落空——实测：`apps/qunar-live` 在桌面上下文里第一个子目标三次尝试都是
`low confidence 0.15`，声明 iPhone UA + 390×844 后同一份计划 **2/2 一次命中、全规则**：

```jsonc
"device": { "user_agent": "Mozilla/5.0 (iPhone; ...)", "viewport": {"width": 390, "height": 844},
            "is_mobile": true, "has_touch": true, "locale": "zh-CN", "timezone": "Asia/Shanghai",
            "device_scale_factor": 3 }
```

加载期校验（`src/probe-set.ts`）三条硬规矩：

1. **每个 URL 的主机必须在 `hosts` 里**——否则这个主机就在防泄漏门禁的覆盖范围之外，等于把站点知识藏起来；
2. 占位符只有四个（`{date}` / `{date_slash}` / `{checkout}` / `{checkout_slash}`，纯日历运算，不碰时钟），未知占位符报错；
3. `browser` / `repeat` / `roles` 只能指向声明过的 http 目标 id，未知键一律报错。

驱动只剩「怎么测」：`src/live-probe.ts`、`src/live-capture.ts`、`src/ota-probe.ts`、`src/qunar-probe.ts`、
`src/qunar-task.ts` 现在都**不含任何站点标识**，因此它们已进入共享层「核心」名单——
再往里面写死一个主机名，`npm run apps:matrix` 立刻报泄漏。

```bash
node --experimental-strip-types src/live-probe.ts                 # 携程可达性矩阵（写 ctrip/results/live_probe.json）
node --experimental-strip-types src/live-probe.ts --out /tmp/x.json
node --experimental-strip-types src/live-capture.ts --date 2026-10-08
node --experimental-strip-types src/live-capture.ts --out /tmp/dir # 快照与 summary.json 写到别处（复测不碰冻结语料）
node --experimental-strip-types src/ota-probe.ts --out /tmp/ota.json
node --experimental-strip-types src/qunar-probe.ts                # qunar 对照
node --experimental-strip-types src/qunar-task.ts                 # 抓取计划来自 apps/qunar-live/pack.json 的 journey
```

最近一次线上复测（8/8 用例、34/34 子目标、四个探针的逐项观测）：[bench/live-retest/REPORT.md](../bench/live-retest/REPORT.md)。

债计数的口径也升级了：除了"应用声明的标识出现在非核心文件里"，还**独立**扫描非核心文件里写死的
`http(s)://主机`（`localhost` / `example.com` 之类除外）——所以"藏在驱动里、应用还没声明"的站点知识
同样会出现在债那一栏，而不是只能看见自己已经承认的那些。当前：**债 0 处**。

### 演示一次就录成应用（`npm run learn`）

```bash
npm run learn                      # 零参数：连上你正开着的浏览器，用当前页；你做一遍，逐条 y/n 确认
npm run learn -- --url testpages/product.html --script actions.json --yes   # 无人值守（CI/Agent）
npm run agent -- --goal "把商品加入购物车" --url <页面>                        # 外层 Agent 的一次调用（--json --yes）
```

- **录什么**：每一步的稳定句柄（`data-test`/`id`/`name`；波动量拒收）、从"动作前/动作后"归纳的完成信号、结束态不变量候选。**不录 `when`/`retries`**（它们是运行时策略，不是演示出来的东西）。
- **不变量从哪来**：从**回放形状的那次运行**归纳，不是从人演示的那次——演示是一个连续会话（页面会累积状态），回放是每个子目标重新导航，两者结束态可以不同（实测过一次：角标在演示里走到 2、回放只走到 1）。
- **落盘门槛**：写文件前用规则模式重跑，要求 **0 次模型调用**且通过；`ok` 里有失败或复跑里不成立的不变量会被**明确剔除并写进 notes**（不静默改绿）。
- **血统**：包里 `recorded_from: {url, steps, sha256}`；页面变了下次回放会报 `recorded-flow drift`，重新演示即可。
- **边界**：只录「点击」与「填值」；`@ 敏感字段`只记形状不记明文；`--cdp` 挂到你自己的浏览器时**退出只断开、不关闭**。

### 不变量归纳：让跑通的旅程自己提出"什么必须成立"

```bash
npm run apps:induce -- --app ctrip-case --json     # 看它提出什么（含每条候选的对照态）
npm run apps:induce -- --app ctrip-case --write    # 追加进包里，然后立刻重跑验证
```

三道闸门：① **区分性**（结束后为真、**对照态**为假——对照态是"这条旅程少做最后一步"，不是首页，
否则会把城市输入框这类无关 UI 也收进来）；② **稳定句柄**（`data-test`/`id`/`name`，值不能是波动量）；
③ **复跑一致**（`--runs N` 取交集）。`--write` 只追加、不覆盖人的判断，并且**重跑不成立的候选会被撤掉**
（宁可少一条真断言，也不要一条会骗人的）。实测：某次归纳提出 4 条、重跑发现 1 条不可复现（`#ledger-table`
是否缺席不稳定）→ 自动撤掉 → 最终 19/19、3/3 成立。

### 探针基线：把"上次测出来的判决"记进包里

```bash
npm run probes:baseline -- --check                 # 门禁口径：包里的判决 vs 已入库的探测记录
npm run probes:baseline -- --write                 # 用记录刷新基线
npm run probes:baseline -- --from <新探针结果.json> --write   # 用一次新探测刷新
```

声明的是**输入**（URL / 风控词 / 登录墙特征），基线记的是**测出来的判决**（`BLOCKED` /
`LOGIN_REQUIRED` / `captured` …）。于是"站点变了"不再只能靠人再读一遍报告：`--check` 会红，
而且"有人手改了包"是同一个检查。只存标量观察，不存 `*_reason`（叙述留在冻结语料里，别造第二份散文）。

## 七、还没做的（诚实清单）

| 项 | 现状 |
|---|---|
| **数据腿 → 动作腿的绑定**（`bind: {slot: "source.selects.x.field"}`） | 没做。等出现第二个真实消费者再加语法（一个消费者不值得造一条语法） |
| **把每站点专用驱动迁进应用包** | 探针一族已迁完（债 0）：`ctrip-live` / `ota-live` / `qunar-live` 声明了全部 URL、站点特征与结果目录，5 个驱动进了核心层。剩下的站点知识都是**本地复刻站**（`ctrip/`、`transfer/` 下的 `file://` 页面与用例驱动），不是外部主机 |
| **交互式 TTY 工具**（`ssh` 提问、编辑器） | 明确不做。真需要人参与就走 `{"signal":{"manual":true}}` + 人工背书 |
| **阶段性不变量**（旅程中途的验收） | 没做。中间要求现阶段写成子目标信号；`invariants` 只长在浏览器结束状态上 |


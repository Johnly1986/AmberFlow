# 应用包独立复核报告（task-2）

- 复核人：`app-verifier`（独立测试与优化）
- 范围：**现有**应用 `demo-app` / `cli-report` / `repo-report` / `ctrip-live` / `ota-live` / `qunar-live`，以及应用层门禁 `apps:matrix`
- 方法：不看作者叙述，只跑命令、只读原始输出；每条断言给「题面 → 复现命令 → 原始观测 → 结论（confirmed / refuted / unverifiable）」
- 交付：
  - `tests/app-packs-verified.test.ts`（31 tests）
  - 本报告
  - 共享层 3 处收紧（`src/app-pack.ts` / `src/probe-set.ts`，见 §8；**先报告后改**，含改动前后的最小复现）
- 硬约束遵守：未改 `tools/apps_matrix.ts` / `tests/repo-integrity.test.ts` / `CLAUDE.md` / `README.md` / `apps/README.md` / 任何 `apps/<id>/pack.json`；未 `git commit` / `git push`；所有临时包都写在 `/tmp` 下。

## 0. 环境（观测）

```bash
node --version   # v22.23.2
npm --version    # 10.9.8
git --version    # git version 2.43.0
jq --version     # jq-1.7
```

结论：`repo-report` 需要的两个真实工具**都在**，所以它的 3/3 是"工具齐全"下的结论；缺工具的路径另见 §7-G-L。

## 1. 逐条复核

### 1.1 `npm run apps -- --app demo-app --no-model`（题面：5/5 + 2 条不变量）

命令与原始观测（关键行，完整输出见 `/tmp/appverify/demo-app.txt`）：

```text
$ npm run apps -- --app demo-app --no-model
=== app demo-app (应用包示范：…全部离线） ===
  journey: 5 step(s) [tool,web,web,web,web], roles: add-to-cart, open-cart, apply-coupon, checkout
  source demo-tool: 3 条 {"rows":3}
  [0] tool demo-tool: exit 0, signal held
  invariant on-thanks-page: held
  invariant no-error-banner: held
- 结果：**通过** ｜ 步骤 5/5 ｜ 用时 2s
| 0 | 把 TrailBottle 加入购物车 | done | 1 | - |
| 1 | 打开购物车页 | done | 1 | - |
| 2 | 在购物车输入优惠券 ACME10 并应用 | done | 1 | - |
| 3 | 结算，落到感谢页 | done | 1 | - |
| 0 | 先跑一次命令行工具… | demo-tool | 0 | signal held | 1 | - |
```

```text
exit code = 0   （/tmp/appverify/exits.txt: demo-app exit=0）
```

结论：**confirmed**。且"通过"是有证据的：4 个浏览器步全部 `done`、1 个工具步 `signal held`、2 条不变量 `held`（不是空转）。测试把它钉在
`tests/app-packs-verified.test.ts > 离线应用… > demo-app：5/5 + 2 条不变量成立，且每一步都有完成信号`。

### 1.2 `npm run apps -- --app cli-report --no-model --allow-dangerous`（题面：5/5）

```text
$ npm run apps -- --app cli-report --no-model --allow-dangerous
  [0] tool demo-tool: exit 0, signal held
  [1] tool demo-tool: exit 3, signal held
  [2] tool demo-tool: exit 2, signal held
  [3] tool demo-tool: exit 0, signal held
  [4] dry-run demo-tool: exit 0
  [4] tool demo-tool: exit 0, signal held
- 结果：**通过** ｜ 步骤 5/5 ｜ 用时 0.3s
```

```text
exit code = 0   （cli-allow exit=0）；产物 /tmp/layawebuse-apps/cli-report-artifact.txt 落地（argv 里有 --write=…）
```

结论：**confirmed**（5/5 + 危险步有干跑证据 + 产物落地）。该包**没有 invariants**，通过完全由 5 个工具步各自的 `done` 信号支撑 —— 测试显式断言 `pack.invariants === []` 且 5/5 步 `done`。

**但题面没说的半边（本节的重点）**：文档叙事里的"前两次失败、第三次成功 -> 真的重试 3 次"**在题面命令的默认输出目录下不可复现**。第一次按题面命令跑，第 4 步报的是 `attempts=1`（表格里"尝试"列 = 1），因为桩工具的失败计数 `--counter=/tmp/layawebuse-apps/retry-counter` 是**跨进程持久**的：

```text
$ cat /tmp/layawebuse-apps/retry-counter
5
```

也就是说，这条"幂等重试"的完成信号是 `exit_ok`，在计数器已经 ≥2 时第 1 次就成立。换成全新 `--out` 再跑，才看到真实的 3 次尝试：

```text
$ npm run apps -- --app cli-report --no-model --allow-dangerous --out /tmp/appverify/fresh
  [3] tool demo-tool: exit 1, signal not yet
  [3] tool demo-tool: exit 1, signal not yet (attempt 2)
  [3] tool demo-tool: exit 0, signal held (attempt 3)
- 结果：**通过** ｜ 步骤 5/5
```

结论：**confirmed（通过）+ 该子声明 refuted-by-state**（默认 `out_dir` 下"重试"不可复现，必须 `--out` 到干净目录；见 §7-G-K）。

### 1.3 `npm run apps -- --app cli-report --no-model`（不带 `--allow-dangerous`）

```text
$ npm run apps -- --app cli-report --no-model
  [4] dry-run demo-tool: exit 0
  [4] REFUSED (dangerous) 不可逆写入：先干跑，经确认后落盘一个产物文件
- 结果：**未通过** ｜ 步骤 4/5
| 4 | 不可逆写入… | demo-tool | - | **dangerous** | 0 | exit 0 |

exit code = 1                      （cli-deny exit=1）
$ ls /tmp/layawebuse-apps/cli-report-artifact.txt
ls: cannot access '…/cli-report-artifact.txt': No such file or directory   （artifact-ls exit=2）
```

（跑之前已 `rm -f` 该产物，所以"不存在"不是残留造成的。桩工具表里第 4 步 `code = -`，apply 根本没执行。）

结论：**confirmed**：危险步被**显式拒绝**（`refused: "dangerous"`，不是静默跳过），无产物落盘，退出码 1。

### 1.4 `npm run apps -- --app repo-report --no-model`（题面：3/3）

```text
$ npm run apps -- --app repo-report --no-model
  [0] tool git-log: exit 0, signal held
  [1] tool bench-cases-index: exit 0, signal held
  [2] tool bench-cases-shape: exit 0, signal held
- 结果：**通过** ｜ 步骤 3/3 ｜ 用时 0.1s
exit code = 0
```

原始 argv/输出（节选）：`git log --since=2026-09-04 --date=short --no-merges --pretty=format:%h|%an|%ad|%s` → `c46f615|Johnlyon|2026-10-04|…`；`jq -r .cases[].id bench/cases-live-long.json` → 3 个 id。

结论：**confirmed**（本机 git 2.43.0 / jq 1.7 都在）。该包同样**没有 invariants**，靠 3 个工具步的 `done` 支撑。工具缺失路径见 §7-G-L（**CLI 会崩，不会给出结构化结果**）。

### 1.5 `npm run apps:matrix` 尾部

```text
$ npm run apps:matrix
应用 9 个 ｜ 声明 917 行 ｜ 应用目录里的代码 0 行（期望 0：应用是数据，代码在共享层）
共享层文件 48 个（核心 26 个）｜ 应用声明的标识 20 个
泄漏检查：OK（核心层代码里没有任何应用声明的站点/工具标识）
exit code = 0
```

矩阵行（节选）：`cli-report code 0 / repo-report code 0 / demo-app code 0 / ctrip-live code 0 / ota-live code 0 / qunar-live code 0`；**没有打印"债"一节**（`debt=0` 时不打印）。

结论：**confirmed**：9 个应用、917 行声明、**0 行应用目录代码**、泄漏检查 OK、债 0。
测试额外用 `fs` 走遍 `apps/*`（跳过 `bin/`）断言没有任何 `.ts/.js/.mjs/.cjs` 文件，并断言 `matrix().leaks` / `matrix().debt` 都是 `[]`。

### 1.6 `loadProbeSet("ctrip-live")` 真的加载了声明的探针集

```text
$ node --experimental-strip-types -e 'import {loadProbeSet} from "/root/ML/LayaWebUse/src/probe-set.ts"; …'
{
 "app": "ctrip-live", "date": "2026-10-05", "resultsDir": "/root/ML/LayaWebUse/ctrip/results",
 "home": "home",
 "http": 6, "alts": 5, "mobile": 4, "capture": 2,
 "browser": 2, "repeat": { "id": "flight_mobile_cn", "times": 5 },
 "roles": 6, "markers": 10, "markerValues": 19,
 "login": { "hosts": 1, "paths": 1, "titles": 2 },
 "notes": 4
}
```

结论：**confirmed**（不是空壳：6 个 HTTP 目标 / 5 个替代入口 / 4 个手机区域目标 / 2 个抓取目标 / 2 个浏览器复验 / 5 次重复 / 6 个角色 / 19 个 marker 值 / 3 类登录特征）。
另两个探针集也都能加载（`ota-live` http=8；`qunar-live` http=2，journey 2 步）。

## 2. 坏包 / 坏探针集：加载期必须点名报错（本文件的核心）

复核用的加载路径就是生产路径：应用包 = `expandPack`（`runApp`/CLI 的第一步），探针集 = `loadProbeSet`。
每条都不只看"抛错"，而是断言**消息里的位置与原因**。

### 2.1 应用包（`expandPack` → `app pack <id> is invalid:`）

| 断言（题面） | 复现（临时副本，不改仓库包） | 原始消息（节选） | 结论 |
|---|---|---|---|
| 未知键 | `p.whatever = 1` | `whatever: unknown pack key (known: spec_version, …)` | confirmed |
| 未知角色 | `p.journey[1] = {role:"ghost"}` | `journey[1]: unknown role "ghost"` | confirmed |
| 未声明槽位（必填） | `p.required_slots = ["missing"]` | `required slot "missing" has no value` | confirmed |
| 未知 `{slot}` | `p.roles["add-to-cart"].desc = "把 {nope} 加入购物车"` | `unknown slot placeholder {nope}` | confirmed |
| `hosts` 不是列表 | `p.hosts = "m.ctrip.com"` | `hosts must be a list of strings (the leak gate iterates it)` | confirmed（**本次收紧**，§8.3） |
| 浏览器角色上写工具键 | `p.journey[1] = {role:"add-to-cart", args:["--ignored"]}` | `journey[1].args: tool-only key on a browser step` | confirmed（**本次收紧**，§8.1；改前静默丢弃） |
| 工具步上写浏览器键 | `journey[0].start_url = …`（无 role） | `journey[0].start_url: browser-only key on a tool step (source="demo-tool")` | confirmed（原本就有） |
| 角色模板混用两型键 | `p.roles["add-to-cart"].source = "demo-tool"` | `roles.add-to-cart.start_url: browser-only key on a tool step …` | confirmed（原本就有） |
| 未知信号算子 | `p.roles.checkout.signal = {magic_op:"x"}` | `unknown signal op 'magic_op'` | confirmed |

外层形状也断言了：消息以 `app pack demo-app is invalid:\n  - ` 开头（点名是哪个包）。

### 2.2 探针集（`loadProbeSet` → `probe set <path> is invalid:`）

| 断言（题面） | 复现（临时 `pack.json`） | 原始消息（节选） | 结论 |
|---|---|---|---|
| URL 主机没进 `hosts` | `hosts:["m.ctrip.com"]`, `url:https://evil.example/x` | `probe.http[0].url host "evil.example" is not declared in pack.hosts (the leak gate would miss it)` | confirmed |
| **`hosts` 为空也不许藏主机** | `hosts:[]` + 任意 URL | 同上（改前：**通过，0 问题**） | confirmed（**本次收紧**，§8.2） |
| 目标 id 悬空（browser） | `browser:["b"]` | `probe.browser: "b" is not an http target id` | confirmed |
| 目标 id 悬空（repeat） | `repeat:{id:"z",times:2}` | `probe.repeat.id "z" is not an http target id` | confirmed |
| 目标 id 悬空（roles） | `roles:{flight:"b"}` | `probe.roles.flight: "b" is not an http target id` | confirmed |
| 重复目标 id | 两个 `id:"a"` | `probe.http: duplicate target ids` | confirmed |
| 未知探针键 | `probe.magic = 1` | `probe.magic: unknown key (known: …)` | confirmed |
| 未知日期占位符 | `url:…?d={tomorrow}` | `unknown placeholder {tomorrow}` | confirmed |
| `hosts` 不是列表 | `hosts:"m.ctrip.com"` | `probe: hosts must be a list of strings (the leak gate iterates it)` | confirmed（**本次收紧**，§8.3） |
| `login.hosts` 没声明 | `login:{hosts:["elsewhere.example"]}` | `probe.login.hosts "elsewhere.example" is not declared in pack.hosts` | confirmed |

回归面：三个已提交探针集（ctrip-live / ota-live / qunar-live）与仓库里每个应用包在收紧后仍然 `validatePack` 零问题（测试断言）。

## 3. 主动证伪：把工作弄坏，退出码必须变 1

### 3.1 demo-app 不变量不可能成立（临时副本，不改仓库包）

```bash
# 把 apps/demo-app/pack.json 拷到 /tmp/appverify/clone/pack.json，改 invariant[0].signal
#   -> {"css_exists": "[data-test=definitely-absent]"}
$ npm run apps -- --app /tmp/appverify/clone/pack.json --no-model --quiet --out /tmp/appverify/clone/out
$ echo $?
1
$ python3 -c "import json;d=json.load(open('/tmp/appverify/clone/out/demo-app-result.json'));print(d['ok'],d['completed'],d['invariants'])"
False 5/5 [{'id': 'on-thanks-page', 'desc': 'FALSIFY: 这一条不可能成立', 'held': False}, {'id': 'no-error-banner', …, 'held': True}]
```

结论：**confirmed** —— 动作腿照跑（5/5），验收不成立 → `ok=false` → **退出码 1**。不变量是有牙齿的。

### 3.2 CLI `main()` 的退出码链路（临时 cli-report 包，破坏第 1 步信号）

```bash
# journey[0].signal = {"exit_code_equals": 99}（不可能成立）
$ node --experimental-strip-types src/app-runner.ts --app <tmp>/pack.json --no-model --quiet --out <tmpout>
$ echo $?
1   # result.json: ok=false, completed="3/5"（第 5 步未给 --allow-dangerous，按规矩被拒）
```

结论：**confirmed**（测试内以 `spawnSync` 复现，断言 `status === 1`）。

## 4. 隐藏项（题面没说、但决定"结论是否成立"的）

| # | 发现 | 最小复现 | 影响 | 处置 |
|---|---|---|---|---|
| G-A | **测量型应用经 `runApp` 是空转通过**：`ctrip-live` 无 journey、无 invariants | `npm run apps -- --app ctrip-live --no-model` → `结果：**通过** ｜ 步骤 0/0`，exit 0 | 这个 0 什么都证明不了（探针一个都没跑）；CLAUDE.md 说测量入口是各驱动，但运行器的"通过"没有区分 | 报告 + 测试显式钉住"0 步 / 0 不变量"形状（`tests/app-packs-verified.test.ts` 对应用例）；**未改行为** |
| G-B | **角色内联覆盖混用两种步型的键会被静默丢弃** | `expandPack({...demo-app, journey[1]={role:"add-to-cart",args:["--ignored"]}})` 改前返回 `steps[1].kind="browser"`、`args` 消失、`validatePack` 无问题 | 作者以为写了 args，实际没跑（"写了没用"，正是文件头承诺要防的） | **已修**（§8.1） |
| G-C | **`hosts` 为空/缺失时，探针 URL 的主机校验被跳过** | `validateProbeBlock({http:[{id:"a",url:"https://evil.example/x"}]}, undefined)` 改前 → `[]` | 探针可以打着任意主机而防泄漏门禁看不见（"声明了就覆盖到"单向失效） | **已修**（§8.2） |
| G-D | **`hosts` 写成裸字符串能通过校验** | `validateProbeBlock({…}, "m.ctrip.com")` 改前 → `[]` | `apps_matrix.declaredTokens` 用 `for (const h of pack.hosts)` 逐字符建 token（`m`/`.`/`c`…），既漏真主机又制造大量假泄漏；`\bm\b` 会命中无数文件 | **已修**（§8.3） |
| G-E | 跨列表重复 target id 不报（`http` 与 `alts` 同名） | `validateProbeBlock({http:[{id:"a",…}],alts:[{id:"a",…}]}, ["m.ctrip.com"])` → `[]` | `shortOf()` 只返回第一个匹配，判决短名可能张冠李戴 | 报告（低危，未改） |
| G-F | 非字符串 target id 被静默 `String()` | `{id:7}` → `loadProbeSet` 得到 `"7"` | 类型手误无声通过 | 报告（低危，未改） |
| G-G | 浏览器步没有 `start_url` 加载期放行 | `p.roles["add-to-cart"]` 删 `start_url` → `validatePack` 返回 `[]` | 运行期 `goto("")` 才失败；应用包承诺"加载期就炸"在这里漏了一条 | 报告（中低危，未改：`PlanningRules` 的 `require_start_url=false` 是共享选择，改动面大） |
| G-H | `max_subgoals` / `slots` / `sources` 的类型不校验 | `{...demo-app, max_subgoals:"8"}` / `slots:"ACME10"` / `sources:"demo-tool"` 都过 | `sources` 写成字符串时 `for…of` 逐字符 loadSource，报出 **9 条** `source "d" not found` 之类的误导错误（定位噪音） | 报告（低危，未改） |
| G-I | 重复的 invariant id 不报 | `invariants:[{id:"x",…},{id:"x",…}]` → `[]` | 报告里两条同名，人读会混 | 报告（低危，未改） |
| G-J | 坏包走 CLI 是**未捕获异常**（exit 1 + 栈），不是干净的 exit 2 | `npm run apps -- --app <bad-pack.json> --no-model` → `Error: app pack demo-app is invalid: - bogus_key: unknown pack key …` + stack，exit 1 | 消息精确、失败响亮（可接受），但没有 `app-runner` 自己的 usage/退出码约定；`--dry` 路径同理 | 报告（低危，未改；建议 `main()` 里 `validatePack` 后返回 2） |
| G-K | **`cli-report` 默认输出目录的 retry 计数是持久的** | `cat /tmp/layawebuse-apps/retry-counter` → `5`；重跑题面命令时"尝试=1" | 题面"重试 3 次"的证据在重复运行中不出现（见 §1.2） | 报告（文档/命令层面；建议演示命令带 `--out "$(mktemp -d)"`）；**未改 pack**（硬约束） |
| G-L | 工具二进制缺失 → `runApp` 抛 ENOENT，无结构化结果 | `env PATH=/nonexistent node --experimental-strip-types src/app-runner.ts --app repo-report --no-model --quiet --out /tmp/…` → `Error: spawnSync git ENOENT`（栈），exit 1，**没有** `repo-report-result.json` | 运维上"工具没装"与"运行器崩了"无法从产物区分；测试侧靠 `skipIf` 跳过 | 报告（中危，未改：需要新的 refused 语义，属行为变更，交 Lead 决定） |

## 5. 共享层改动（先报告后改，附改动前后最小复现）

改的文件只有两个：`src/app-pack.ts`、`src/probe-set.ts`（均不在硬约束禁改名单里）。三个改动都是"把已经写在注释里的承诺补成真校验"，且对现有 6 个应用包 / 3 个探针集零影响（§2 回归面）。

### 5.1 `src/app-pack.ts`：角色内联覆盖也要查两种步型的互斥键

**改动前**：

```text
$ node --experimental-strip-types /tmp/gapcheck.ts
[G1 expandPack(browser role + args)] OK -> ["tool","browser","browser","browser","browser"]
# => {role:"add-to-cart", args:["--ignored"]} 被当成浏览器步，args 静默丢弃，validatePack 无话
```

**改动后**：

```text
[G1 expandPack(browser role + args)] THROW -> app pack demo-app is invalid:
  - journey[1].args: tool-only key on a browser step
```

diff（`on a role-referenced journey entry` 分支新增 15 行）：

```diff
@@ -379,6 +385,21 @@ export function validatePack(pack: AppPack,
       for (const k of Object.keys(entry)) {
         if (!(STEP_KEYS as readonly string[]).includes(k)) p.push(`journey[${i}].${k}: unknown step key`);
       }
+      // 合并后两种步型的互斥键仍要查：角色模板走 checkStep，但**内联覆盖**以前只查键名，
+      // 于是 `{role: <浏览器角色>, args:[...]}` 会把 args 静默丢掉（"写了没用"），
+      // step 仍按浏览器步执行 —— 这正是不变量"两种步型互斥键加载期就报错"要防的事。
+      const tpl = roles[String(roleName)];
+      if (isDict(tpl)) {
+        const merged = { ...tpl, ...entry };
+        const tool = merged["source"] !== undefined;
+        for (const k of tool ? BROWSER_ONLY : TOOL_ONLY) {
+          if (merged[k] !== undefined) {
+            p.push(`journey[${i}].${k}: ${tool
+              ? `browser-only key on a tool step (source=${JSON.stringify(String(merged["source"]))})`
+              : "tool-only key on a browser step"}`);
+          }
+        }
+      }
     }
   });
```

### 5.2 `src/probe-set.ts`：探针 URL 的主机必须声明，`hosts` 为空也不例外

**改动前**：

```text
[G4 validateProbeBlock(no hosts, arbitrary url)] OK -> []
# => hosts 缺失/为空 = 后门
```

**改动后**：

```text
[G4 validateProbeBlock(no hosts, arbitrary url)] OK ->
  ["probe.http[0].url host \"evil.example\" is not declared in pack.hosts (the leak gate would miss it)"]
```

diff：

```diff
-  if (h !== null && hosts.size && !hosts.has(h)) {
+  if (h !== null && !hosts.has(h)) {
+    // **包括 `hosts` 缺失/为空时**：原来这里是 `hosts.size && !hosts.has(h)`，于是
+    // `hosts: []` 成了一道后门 …… "声明了就覆盖到"必须双向成立：没声明的主机就是错误。
     p.push(`${where}.url host ${JSON.stringify(h)} is not declared in pack.hosts (the leak gate would miss it)`);
   }
…
-        if (hosts.size && !hosts.has(hh)) {
+        if (!hosts.has(hh)) {
           p.push(`${where}.login.hosts ${JSON.stringify(h)} is not declared in pack.hosts`);
         }
```

### 5.3 `src/probe-set.ts` + `src/app-pack.ts`：`hosts` 必须是字符串列表

**改动前**（裸字符串被 `asList` 容忍，但门禁按字符遍历）：

```text
[G3 validateProbeBlock(hosts as string, url on that host)] OK -> []
$ node -e 'for (const h of "m.ctrip.com") process.stdout.write(JSON.stringify(h)+" ")'
"m" "." "c" "t" "r" "i" "p" "." "c" "o" "m"     # apps_matrix.declaredTokens 的迭代语义
```

**改动后**：

```text
[G3 validateProbeBlock(hosts as string, url on that host)] OK ->
  ["probe: hosts must be a list of strings (the leak gate iterates it)"]
# expandPack 路径同时给 "hosts must be a list of strings (the leak gate iterates it)"
```

diff：

```diff
+  if (pack.hosts !== undefined && (!Array.isArray(pack.hosts) || pack.hosts.some((h) => typeof h !== "string"))) {
+    p.push("hosts must be a list of strings (the leak gate iterates it)");
+  }
…
+  if (hostsRaw !== undefined && (!Array.isArray(hostsRaw) || hostsRaw.some((h) => typeof h !== "string"))) {
+    p.push(`${where}: hosts must be a list of strings (the leak gate iterates it)`);
+  }
```

完整 diff：

```bash
$ git -C /root/ML/LayaWebUse diff -- src/app-pack.ts src/probe-set.ts
# 2 hunks in src/app-pack.ts (hosts 类型 + 角色内联互斥键)
# 3 hunks in src/probe-set.ts (url 主机无条件校验 / hosts 类型 / login.hosts 无条件校验)
```

### 5.4 改动后的门禁

```text
$ npx tsc --noEmit                       -> exit 0
$ npx vitest run tests/probe-set.test.ts tests/apps.test.ts
  Test Files 2 passed (2) | Tests 59 passed (59)
$ npm run apps:matrix                    -> exit 0；0 代码行 / 泄漏 OK / 债 0（与 §1.5 相同）
```

## 6. 交付与自测门禁

```text
$ npx tsc --noEmit
exit 0
$ npx vitest run tests/app-packs-verified.test.ts
Test Files  1 passed (1)
Tests       31 passed (31)
$ npx vitest run                    # 全仓（收紧 src/** 之后）
Test Files  46 passed (46)
Tests       730 passed (730)
Duration    236.03s               # 含本次新增 31 条
```

覆盖映射（题面 → 用例）：
- 坏包加载期报错（9 条，含消息内容）→ `坏应用包：加载期失败，且消息点出是哪一处`
- 坏探针集加载期报错（10 条，含 `hosts` 空/裸串）→ `坏探针集：loadProbeSet 加载期失败…`
- `matrix()` leaks/debt 空 + 应用目录 0 代码行 → `门禁：apps:matrix…`
- 离线应用验收（demo-app / cli-report ×2 / repo-report / ctrip-live 空转形状）→ `离线应用：验收命令真的跑通…`
- 证伪（不变量 + CLI 退出码）→ `证伪：把工作弄坏，退出码必须变 1`

## 7. 未能验证 / 边界（诚实列出）

- **未在缺 git/jq 的机器上验证 repo-report "跳过"路径的产物**：本机两工具齐全（§0）。我实测的是相反方向——把它们从 `PATH` 移除后 CLI **崩在 `spawnSync git ENOENT`**、不写结果 JSON（§7-G-L）；测试里 `it.skipIf(!hasTool(...))` 会让用例静默跳过，这点必须在 CI 里明说（本报告即说明）。
- **未覆盖 `--profile` / 真实站点**：task-2 范围是离线应用；探针驱动打真实站点属 task-3/线上复测范围，本报告未发起任何真实网络请求。
- **`apps/ctrip-case` / `apps/ip-config` 在本报告 §1–§7 写就时还不存在**（task-2 只复核"现有应用"）；它们随后出现（00:33），复核见下面的 **§8 A1/A2 复核**。task-1 在板上仍是 `in_progress`，所以 §8 开头固定了被复核的 revision（sha256）。
- **G-A 的空转通过是"行为描述"而非 bug 判定**：运行器对"只有探针集、没有 journey"的包返回 `ok=true`；测量是否真的发生要看探针驱动。是否要让运行器对此报"无步骤可跑"是产品决定，本报告只记录 + 用测试钉住形状。
- **未对 `apps:matrix` 做"内容级"防漏验证**（如把某主机写进核心层再确认红）：那会改仓库文件，超出允许范围；现有 `apps.test.ts` 已用正则判据做过模拟验证，本报告只复核"当前为 0 泄漏/0 债"这一事实。

---

# 8. A1/A2 复核（task-3）

- 复核对象（**revision 固定**；task-1 板上仍 `in_progress`，被复核的是这一版）：

```text
3109f821210708b996400fdf8f8cd53364838727e8c661a9c5d449f04412f79b  apps/ctrip-case/pack.json
7ed32a0634b01fb463ef0ea79b0385b191f2913879db32572cec861af0ff98bc  apps/ip-config/pack.json
d94ea1d9e81d7586e1f9c92c1e68f90464c0a9d390851c2faae693ef720627ac  tests/app-packs-authored.test.ts
```

- 说明：两个 pack 的 mtime 停在 00:33、复核全程未变；作者的测试文件在 00:40 又被改过一次（新增「验收有牙齿」用例，hash 从 `108baa…` → `d94ea1…`），**pack 本身没变**，所以下面 §8.1–§8.10 的结论对这一版有效。随后作者按 §8.6 的建议又改了 `ip-config`（00:45），Lead 也改了 `src/app-runner.ts`（00:45）——**最终 revision 的复跑见 §8.11 / §8.12**（那里的 sha256 才是"最终代码"的凭证）。所有改动都在 `/tmp` 副本上做。

## 8.1 A1 `ctrip-case`：验收

```text
$ npm run apps -- --app ctrip-case --no-model --no-sources --out /tmp/verify-ctrip-case
- 结果：**通过** ｜ 步骤 19/19 ｜ 用时 11.6s
| 0..18 全部 done（尝试 1，障碍 -）|
| end-on-recorded-capped-hotel-list | 成立 |
| end-state-is-the-hotel-page | 成立 |
| hotel-results-not-empty | 成立 |
exit code = 0
```

结论：**confirmed**（19/19 + 3 条结束状态不变量成立，退出码 0）。

## 8.2 A1 逐字段对齐（独立脚本，不用作者的测试）

```bash
$ LAYA_TODAY=2026-10-02 node --experimental-strip-types /tmp/t3-compare.ts
== A1 pack.expandPack vs ctrip-task.flightSubgoals+hotelSubgoals: got 19 / want 19 ==
  -> ALL FIELDS EQUAL
emitPlan path=/tmp/t3-emit-XXXX/plan_ctrip.json
emitted checkin urls: …checkin=2026-10-08 (×3 hotel)
== A1 pack.expandPack vs emitPlan('ctrip'): got 19 / want 19 ==
  -> ALL FIELDS EQUAL
```

- 比较字段：`desc / start_url / target_hint / target_hints / signal / when / retries / slots`，逐条 `JSON.stringify` 相等；`start_url` 按 `app-runner.startUrl` 把包里的相对路径解析成 `file://` 后再比。
- 比对基准两套都跑了：`src/ctrip-task.ts` 的 `flightSubgoals(5 天) + hotelSubgoals("2026-10-08")`（冻结计划构造器），以及 `transfer-task.emitPlan("ctrip", loadSpec("ctrip"), …)`（Lead 说的独立导出路径；`LAYA_TODAY=2026-10-02` 固定时钟，导出的 checkin 正是 2026-10-08）。
- 形状与 Lead 的独立 dump 一致：**19 步 = 1 入口 + 5 天 × 3（筛时段/排序/记录）+ 3 酒店（上限/排序/记录）**；hints 都是 `a[data-test=…]` / `button[data-test=…]`；signals 都是 `css_text_contains`。

结论：**confirmed**（19/19 字段全等，两套基准都全等）。

## 8.3 A1 不依赖模型 + 不变量证伪

```text
$ node --experimental-strip-types /tmp/t3-asked.ts
[ctrip-case] ok=true completed=19/19 modelQuestions=19 byKey={"r":19}
# 只问了 19 次风险问题 r，`act`（选元素）= 0 次 => 19 步全部由 target_hint 规则命中

$ node --experimental-strip-types src/app-runner.ts --app /tmp/verify-falsify/ctrip-case.json \
    --no-model --no-sources --quiet --out /tmp/verify-falsify/out-ct   # 临时副本，invariant[0] 改成不可能成立
ctrip-case falsify exit=1
ok: False completed: 19/19 invariants: [end-on-recorded-capped-hotel-list: held False, 其余两条 True]
```

结论：**confirmed**（模型零参与；不变量有牙——动作腿 19/19 照跑，验收不成立即退出码 1）。

## 8.4 A2 `ip-config`：验收 + Lead note「第 4 行怎么处理」

```text
$ npm run apps -- --app ip-config --no-model --out /tmp/verify-ip-config
- 结果：**通过** ｜ 步骤 8/8 ｜ 用时 3.6s
| 0 | 打开 CAM-1001 … | done |
| 1 | 保存到 CAM-1001 | done |
| 2 | 打开 CAM-1002 … | done |
| 3 | 保存到 CAM-1002 | done |
| 4 | 打开 PTZ-2001 … | done |
| 5 | 保存到 PTZ-2001 | done |
| 6 | 打开 CAM-1003 … | done |
| 7 | 提交到 CAM-1003（规划表写的是 10.0.1.999） | done |
| end-on-the-rejected-device-page | 成立 |
| the-rejected-value-is-the-planned-one | 成立 |
| rejection-is-not-reported-as-success | 成立 |
exit code = 0
```

**Lead note #1 的答案**：第 4 行 `CAM-1003 / 10.0.1.999` 既没有被排除、也没有被静默跳过 —— 它是**显式的第 7 步**，完成信号就是设备页自己的拒绝文案（`[data-test=error]` 含「IP 地址格式错误」**且**含规划值 `10.0.1.999`，并要求 `save-ok` **不**含「已保存」）；不变量再确认一次"被拒绝的正是规划值"且"没有谎报成功"。所以这 8/8 里包含了一道设计好的失败，而不是绕开它。
（旁证：`10.0.1.999` 在整个 pack 的 journey 里只出现一次 —— 作者的用例 `设计好的拒绝没有被静默丢掉` 断言的就是这一点。）

原始日志里 4 次 `step 1.pre: fill required "10.0.1.11 / IP 地址"` 看着像"每行都填了第一行的值"，但那是**页面占位符**被当成了标签：`testpages/net_settings.html` 里 `<input data-test="ip" placeholder="10.0.1.11">`，executor 打印的是 `pe.label`（placeholder + 字段名），不是填入值。已用下面的正控制确认填入值确实是逐行的。

结论：**confirmed**。

## 8.5 A2 逐字段对齐

```bash
$ node --experimental-strip-types /tmp/t3-ip.ts
[row0-open] idx 0: fields equal      [row0-save] idx 1: fields equal, slots={"ip":"10.0.1.11",…}
[row1-open] idx 2: fields equal      [row1-save] idx 3: fields equal, slots={"ip":"10.0.1.12",…}
[row2-open] idx 4: fields equal      [row2-save] idx 5: fields equal, slots={"ip":"10.0.2.21",…}
[row3-open] idx 6: fields equal
row3-save .start_url equal = true ; .target_hint equal = true ; .slots equal = true ({"ip":"10.0.1.999",…})
row3-save .signal equal to frozen = false ; mentions rejection = true
TOTAL hard diffs (excl. intentional row3-save desc/signal) = 0
```

- 与 `buildPlan(row.序列号, row)` 对比：**前 7 步（rows 0..2 的 open/save + row3 的 open）逐字段全等**（含 slots；驱动里 slots 是计划级、包里挂在各自那一步，值逐字段相同）。
- 第 8 步（row3 的 save）有三处**有意偏差**，且都在 pack 的 `notes` 里声明：
  1. `signal`：驱动的完成信号是 `save-ok 已保存`，包里换成设备页的拒绝文案（这就是"显式表达拒绝"）；
  2. `desc`：包里写成 `…提交到 CAM-1003（规划表写的是 10.0.1.999）`，比驱动的 `…保存到 CAM-1003` 更具体（记录了规划值）；
  3. `slots`：包把行的 ip/mask/gw 放在这一步（驱动放在计划级）。
- 所以对 task-1 题面"逐字段对齐"的口径：**A1 是全等；A2 若要求 8/8 全等则 [7].desc / [7].signal 会被 refuted**，但这两处正是"设计好的失败要显式表达"的必要改动，作者自己的测试也只对第 8 步断言 `slots` 与 `signal`（不比对 desc），与声明一致。判定：**confirmed（有意偏差已声明，非静默）**，同时把这个口径差记在案。

## 8.6 A2 隐藏弱点（我额外发现的）+ 正控制

**弱点**：前三台设备的保存步完成信号只有 `css_text_contains [save-ok, "已保存"]`，**没有钉住本行自己的 IP**。页面把值回显在 `save-ok` 里（`已保存 <ip> / <mask> / <gw> 到 <sn>`），所以只要三台都"保存成功"，即使执行器把 4 行都填成同一台的值（同网段），8/8 + 三条不变量依然成立 —— 唯一真正钉住值的是 CAM-1003 的拒绝步。

**正控制（临时副本，把每行自己的 IP 写进 save 信号）**：

```bash
# journey[1] 追加 save-ok 含 "10.0.1.11"；journey[3] 含 "10.0.1.12"；journey[5] 含 "10.0.2.21"
$ node --experimental-strip-types src/app-runner.ts --app /tmp/verify-vals/pack.json --no-model --quiet --out /tmp/verify-vals/out
values exit=0
ok: True completed: 8/8
subgoal statuses: [done ×8]
```

结论：**逐行值确实按计划填入**（正控制通过），所以这不是 bug，而是一条**可收紧的验收**：建议把三个 save 步的信号加一条 `css_text_contains [save-ok, "<本行 ip>"]`（约 3 行 JSON/步），验收就从"保存成功"升级为"保存了正确值"。**未改 pack**（硬约束 + 那是作者的声明）。

## 8.7 A2 不依赖模型 + 不变量证伪

```text
[ip-config] ok=true completed=8/8 modelQuestions=8 byKey={"r":8}      # 0 次 act
$ node … --app /tmp/verify-falsify/ip-config.json --no-model --out …   # invariants 换成不可能成立
ip-config falsify exit=1   ok=False completed=8/8 invariants:[impossible held False]
```

作者新增的用例「验收有牙齿：把『被拒绝』谎报成『已保存』的不变量不成立 -> ok=false」也是同一方向的自证伪（跑通：10 passed）。

## 8.8 门禁 + 应用目录

```text
$ npm run apps:matrix
ctrip-case   pack  0  3  19  0  3  229  0  -
ip-config    pack  0  0   8  0  3  195  0  -
应用 11 个 ｜ 声明 1341 行 ｜ 应用目录里的代码 0 行（期望 0：应用是数据，代码在共享层）
共享层文件 48 个（核心 26 个）｜ 应用声明的标识 20 个
泄漏检查：OK（核心层代码里没有任何应用声明的站点/工具标识）
exit code = 0   （debt=0，未打印"债"一节）
$ find apps/ctrip-case apps/ip-config -type f
apps/ctrip-case/pack.json
apps/ip-config/pack.json          # 没有 .ts/.js/.mjs/.cjs（除 bin/ 外 0 代码文件）
```

结论：**confirmed**（0 代码行 / 0 泄漏 / 0 债；两个应用目录只有 pack.json）。

## 8.9 作者的回归测试真的会红吗（临时副本）

作者的 `tests/app-packs-authored.test.ts` 本身是绿的：

```text
$ npx vitest run tests/app-packs-authored.test.ts
Test Files 1 passed (1) | Tests 10 passed (10) | Duration 20.85s
```

**红态复现（机制级）**：把信号改坏后，用作者的同一条断言形式（`toEqual` / `runApp.ok`）在临时副本上验证：

```text
$ node --experimental-strip-types /tmp/t3-red.ts
[A1] alignment signal mismatches at idx: [3,6,9,12,15] (author's toEqual would FAIL)
[A1] runApp ok=false completed=14/19 blocked=5
[A2] alignment signal equal = false (author's toEqual would FAIL)
[A2] runApp ok=false completed=7/8 blocked=1
```

- A1：把 `roles["record-lowest"].signal` 的 `已记录` 改成 `WRONG` → 5 个 record 步的 signal 与冻结计划不等（作者的 `expect(g.signal).toEqual(f.signal)` 会红），且 runApp 14/19、5 步 blocked。
- A2：把 `journey[1].signal` 改坏 → 与 `buildPlan` 不等（对齐断言会红），runApp 7/8、1 步 blocked。

**局限性（诚实说明）**：我没有把作者的测试文件**本身**指向改坏的包执行 —— `loadPack("ctrip-case")` 按仓库 `apps/` 解析，而硬约束禁止改动仓库里的 pack；上面是在同一套公共 API 与同一断言形式上、用临时副本复现的红态。测试文件在复核期间还被作者改过一次（新增自证伪用例），结论对其当前 revision（`d94ea1…`）有效。

## 8.10 §8 新增的未能验证项

- 两条验收命令都需要 chromium；本机已装（本报告所有端到端都真跑了真浏览器），但"无浏览器时是否给出清晰失败"未验证。
- task-1 仍 `in_progress`：若作者随后再改 pack，本节结论只对上面 pin 住的 sha256 有效（重新 `sha256sum` 即可判断是否需要重跑）。
- 我未复核 `src/ip-config.ts` 驱动侧的 REJECTED 语义与 pack 语义是否一致（超出 task-3 范围；pack 的 notes 声明两者是同一件事的两种表达）。

## 8.11 最终 revision 与 sha256（Lead follow-up 1）

作者按 §8.6 的建议复作了 `ip-config`（00:45），Lead 也改了 `src/app-runner.ts`（00:45，针对 §4 的 G-A/G-J/G-L 三条 error path）。**最终 revision**：

```text
3109f821210708b996400fdf8f8cd53364838727e8c661a9c5d449f04412f79b  apps/ctrip-case/pack.json      （全程未变）
b1a814efaadb96ae245f617f06a43c1f314beba09c8c8dbb3773deac0a08e082  apps/ip-config/pack.json       （7ed32a06… -> b1a814ef…，+31 声明行）
9bc3b26cfc5b19f3b486b33c1e0cd0196a25bf71287f3f16b6180ec2010fc8a0  tests/app-packs-authored.test.ts（d94ea1d9… -> 9bc3b26c…）
84df2f6599eb0bbf748ba242c37c4c7f367f9445c30e941b1b40e90ed2755b3c  src/app-runner.ts              （+55/-4：G-A/G-J/G-L 三条 error path）
```

- **§8.1–§8.10 的 verdict 适用于第一版 `ip-config` = `7ed32a06…`**；**§8.12 的 verdict 适用于 `b1a814ef…`**（`ctrip-case` 两版 hash 相同，§8.1–§8.3 直接继续有效）。作者随后又在 00:50 把 `ip-config` 改成 `c46cf27f…`（**notes-only**，见 **§8.14**）——那条才是最终 shipping revision。
- **作者仍可能在 task-1 收尾时再改 `apps/ip-config/pack.json`**（Lead 已请他们应用 §8.6 的收紧，他们已应用；随后又补了 notes）。以 `sha256sum apps/ip-config/pack.json` 是否仍等于 **`c46cf27f…`** 判断本报告是否过期。`src/app-runner.ts` 同理（`84df2f65…`）。

## 8.12 最终复跑 delta（Lead follow-up 2）

命令（与题面逐字一致，输出在 `/tmp/appverify/final/`）：

```text
$ npm run apps -- --app ctrip-case --no-model --no-sources --out /tmp/final-ctrip-case   -> exit 0
$ npm run apps -- --app ip-config  --no-model              --out /tmp/final-ip-config    -> exit 0
$ npm run apps:matrix                                                                    -> exit 0
$ npx vitest run tests/app-packs-authored.test.ts tests/app-packs-verified.test.ts       -> 41 passed
```

**1) 变了什么**：
- `ip-config` 的 3 个 save 步信号按 §8.6 收紧成 `all_of[ "已保存", "<本行 ip>" ]`（10.0.1.11 / 10.0.1.12 / 10.0.2.21）——正是我正控制里建议的形状；声明行 195 → **226**，应用总声明 1341 → **1372**。逐字段对齐的含义随之变化：**4 个 save 步的 `signal` 不再与 `buildPlan` 相等**（3 个是"冻结叶子 ⊆ 包信号"的加强，`[7]` 仍是换成拒绝文案），open 步与 `desc/start_url/target_hint/slots` 仍全等（唯一例外仍是 `[7].desc`，见 §8.5）；作者的测试同步改成 `leaves` 必须 `containEqual` 冻结叶子 + 本行 IP 叶子。
- `src/app-runner.ts` 被 Lead 改了（+55/-4），是 G-A/G-J/G-L 的三条 error path。

**2) 没变什么**（首尾两次关键行一致）：
- `ctrip-case`：`结果：**通过** ｜ 步骤 19/19`、19 行 `done`、3 条不变量成立、exit 0；pack 字节未变。
- `ip-config`：`8/8`（含显式拒绝的第 7 步）、3 条不变量成立、exit 0。
- `apps:matrix`：**应用 11 个 ｜ 应用目录里的代码 0 行** ｜ `泄漏检查：OK` ｜ debt 0；两个目录仍只有 `pack.json`（`find` 无 `.ts/.js/.mjs/.cjs`）。
- 我的 31 条复核用例 + 作者的 10 条用例：**41 passed**（2 files）。

**3) 有没有回归**：**没有**。三处改动后两条验收命令退出码仍是 0、不变量仍全成立、门禁三项仍是 0；唯一变化是 `ip-config` 的验收**更强**（save 步现在钉住本行 IP，原本要我的临时正控制才能验到这层）。最终全仓门禁在 00:50:29 重跑：**46 files / 734 tests passed，exit 0**（`npx tsc --noEmit` 同批 exit 0）。

## 8.13 Lead 三条 robustness 修复的回归钉（task-3 δ）

`src/app-runner.ts`（最终 `84df2f65…`）关掉了我 §4 里的 G-A / G-J / G-L。这三条现在钉在 `tests/app-packs-verified.test.ts`
的 `CLI 错误路径：G-A / G-J / G-L 三条修复不得静默回归`（文件从 31 → **34** 条用例）：

| 断言 | 命令/调用 | 原始观测 | 结论 |
|---|---|---|---|
| **G-A** 探针应用经 CLI | `appMain(["--app","ctrip-live","--no-model"])` | `code = 2`；stderr = `app ctrip-live 是测量型应用（探针集，17 个目标），没有 journey：请用对应的探针驱动（src/live-probe.ts / live-capture.ts / ota-probe.ts / qunar-probe.ts），或用 \`npm run apps -- --app ctrip-live --dry\` 只看声明。`；无栈 | confirmed |
| **G-A** 库层语义不变 | `runApp(loadPack("ctrip-live"))` | `ok=true, completed="0/0", 0 步 / 0 不变量`（库的诚实"无事可做"）——两条断言并存，互不矛盾 | confirmed |
| **G-J** 坏包经 CLI | 临时 `demo-app` + `journey[0].bogus_key`；`appMain(["--app",<tmp>,"--no-model","--quiet","--out",<tmp2>])` 与 `appMain(["--app",<tmp>,"--dry"])` | 两次 `code = 2`；stderr 均含 `app pack … is invalid:` 与 `journey[0].bogus_key: unknown step key`；**均无 `\n  at ` 栈帧** | confirmed |
| **G-L** 命令起不来 | 临时 source（克隆 `apps/demo-tool/sources/demo-tool.json`，`transport.cli.bin="definitely-not-a-real-tool-xyz"`）→ `runToolStep(step)` | `refused="tool-unavailable"`、`done=false`、`code=null`、`stderr` 含 `ENOENT` 与二进制名；**不抛** | confirmed |

```text
$ npx vitest run tests/app-packs-verified.test.ts
Test Files  1 passed (1)
Tests       34 passed (34)      # 含上述 3 条；G-A/G-J/G-L 全部绿
```

意义：G-A/G-J/G-L 是"CLI 把失败说清楚"的三条契约；之前它们是 `通过 0/0` / 未捕获栈 / `spawnSync ENOENT` 抛栈，
现在都有 golden 断言，改动共享层时不会再静默退回。

## 8.14 Shipping revision（复核后作者又改了一次：notes-only）+ 最终验收复跑

`ip-config` 的 hash 在我 §8.12 复跑之后又变了一次（mtime `00:50:33`）。我查了原因：

```text
7ed32a06…  (00:33:25)  第一版（§8.1–§8.10 的对象）
b1a814ef…  (00:45:11)  应用 §8.6 的 save-signal 收紧（§8.12 的对象）
c46cf27f…  (00:50:33)  ← 最终：**notes-only**（作者把收紧写进了 notes[0]/[6]/[7]）
```

- **notes-only 的判据**：journey（8 步的 desc/start_url/target_hint/slots/signal）、invariants（3 条）、声明行数（226）与
  `b1a814ef…` 完全一致；改动只在 `notes`（新增 `保存步的完成信号比驱动更强：…再钉一条该行自己的 IP…`、把 notes[0]
  的"逐字段对齐"改成"desc/start_url/target_hint/slots 逐字段相同；保存信号是加强"，notes[7] 同步）。逐字段对齐重跑仍是
  `TOTAL hard diffs = 3`（= 3 个 save 步的 signal 加强，open 步与 desc/start_url/target_hint/slots 全等，`[7].desc` 仍是有意偏差）。

**最终 shipping revision 的 sha256**（Lead follow-up 的答案）：

```text
3109f821210708b996400fdf8f8cd53364838727e8c661a9c5d449f04412f79b  apps/ctrip-case/pack.json
c46cf27f4f6249d4c45960657b00d8e4ddf30624c9515cc116d66198a1799b08  apps/ip-config/pack.json      ← 最终（b1a814ef 已被 notes-only 取代）
9bc3b26cfc5b19f3b486b33c1e0cd0196a25bf71287f3f16b6180ec2010fc8a0  tests/app-packs-authored.test.ts
84df2f6599eb0bbf748ba242c37c4c7f367f9445c30e941b1b40e90ed2755b3c  src/app-runner.ts
```

**在这套最终代码上再跑一次两条验收**（输出 `/tmp/final2-*.txt`）：

```text
$ npm run apps -- --app ctrip-case --no-model --no-sources --out /tmp/final2-ctrip-case
- 结果：**通过** ｜ 步骤 19/19 ｜ 用时 6.1s ；19 行 done ；3 条不变量成立 ；exit 0
$ npm run apps -- --app ip-config --no-model --out /tmp/final2-ip-config
- 结果：**通过** ｜ 步骤 8/8 ｜ 用时 2s ；3 条不变量成立 ；exit 0
$ npm run apps:matrix
ctrip-case  pack 0 3 19 0 3 229 0 -
ip-config   pack 0 0  8 0 3 226 0 -
应用 11 个 ｜ 声明 1372 行 ｜ 应用目录代码 0 行 ｜ 泄漏检查：OK（debt 0） ；exit 0
```

**delta**：相对 §8.12 **无行为变化**（两次 hash 变化都在 `notes` 与非行为声明上）；19/19、8/8、三条不变量、门禁三项
全部保持。**没有回归**。最终全仓门禁：**46 files / 737 tests passed，exit 0**（本轮 34 条 my 文件 + 作者 10 条在内）。

**再次提醒**：作者在 task-1 收尾时仍可能改动 `apps/ip-config/pack.json`；上述 verdict 只对 `c46cf27f…` 有效，
重跑 `sha256sum apps/ip-config/pack.json` 即可判断是否需要重验。





---

# 9. 第 2 轮复核（camera-entry / transfer-voyagio / transfer-slowjet）

- 复核对象（**revision 固定**，packs 只存在于这一版；mtime 均为 2026-10-04 01:13）：

```text
5f397b1bdc3666287595dbeee0af0ebf054ea4d4c89e3a398ac1169b5c01548f  apps/camera-entry/pack.json
4614c0f86f6318c5eb6b177c34c0a5980409ce1d39e999c8940580c45c6a29a5  apps/transfer-voyagio/pack.json
5ca1da2b388e9561cd62a854d8d66d75d1123d7679752fb21b836a17d3e38ed9  apps/transfer-slowjet/pack.json
```

- 共享层（Lead 本轮加固后，复核时）：`src/app-pack.ts 6c7d7871…`、`src/probe-set.ts 9d37ddb3…`、`src/app-runner.ts 5ac3fc47…`。**本轮我未改 `src/**`**（只报告）。
- 方法同 §8：题 → 命令 → 原始观测 → confirmed/refuted/unverifiable；所有临时副本在 `/tmp`。

## 9.1 camera-entry（题面：Excel 类型列路由两套表单，空类型行 + CAM-12 被拒行都要显式）

```text
$ npm run apps -- --app camera-entry --no-model --out /tmp/v2-camera
- 结果：**通过** ｜ 步骤 4/4 ｜ 用时 9.1s
| 0 | 按规划表录入 CAM-1001（枪机）… | done | 1 |
| 1 | 按规划表录入 PTZ-2001（球机）… | done | 1 |
| 2 | 按规划表录入 PTZ-2002（类型列空）：行内证据是 PTZ 序列号 + 变倍/预置位，显式进入 PTZ 表单并提交 | done | 1 |
| 3 | 按规划表录入 CAM-12（枪机）：…序列号不合规由表单自己拒绝 | done | 1 |
| end-on-the-rejected-form | 成立 |
| rejection-not-reported-as-success | 成立 |
| end-state-is-the-fixed-form | 成立 |
exit code = 0
```

结论：**confirmed**（4/4 + 3 条不变量，退出码 0）。

**逐字段对比**：题面说"与 `src/camera-entry.ts` 的 `buildPlan` 对比"——该文件**没有 `buildPlan`**（它的 API 是 `FORMS` / `TYPE_TO_FORM` / `DEMO_ROWS` / `main(deps)`），所以这一条**按字面 unverifiable**。我改用真实可比的素材（`DEMO_ROWS` 4 行 × `TYPE_TO_FORM` × `FORMS` 选择器）逐行核对：

```text
$ node --experimental-strip-types /tmp/v2-camera.ts
journey steps = 4 ; DEMO_ROWS = 4
CAM-1001  sheet_type=枪机     -> form_a slots=OK entry_hint=OK submit_hint=OK
PTZ-2001  sheet_type=球机     -> form_b slots=OK entry_hint=OK submit_hint=OK
PTZ-2002  sheet_type=(blank) -> form_b slots=OK entry_hint=OK submit_hint=OK
CAM-12    sheet_type=枪机     -> form_a slots=OK entry_hint=OK submit_hint=OK
CAM-12 rejection explicitly expressed (error text + the exact value + page): true
blank-type row explicit step: YES ; desc="按规划表录入 PTZ-2002（类型列空）：行内证据是 PTZ 序列号 + 变倍/预置位，显式进入 PTZ 表单并提交"
TOTAL problems = 0
```

- 每行的 slots 与该行非空字段经 `FORMS[form].fields` 映射后的键值**逐项相同**；`target_hints[0]`/`[-1]` 正是该表单的 `entry`/`submit` 选择器（即 `TYPE_TO_FORM` 的字面映射落进计划）。
- **(a) 空 `device_type` 行**（PTZ-2002）：**显式成步**（step 2，`entry-ptz` + `b-*` slots），desc 说明"类型列空…显式进入 PTZ 表单"；不是静默跳过、也不是丢给模型赌。**confirmed**。
- **(b) CAM-12 被拒行**：**显式成步**（step 3），完成信号三件套 = `url_contains camera_a.html` + `a-error` 含「序列号格式错误」+ `css_value_equals a-serial = "CAM-12"`（该表单的错误文案是固定串、不回显值，所以把"拒绝发生在我们填入的那个值上"钉在输入框上）；不变量再确认一次"没有谎报成功"。**confirmed**，没有静默丢弃。

## 9.2 transfer-voyagio（题面：两页向导 24 步，与 spec 逐字段对齐）

```text
$ npm run apps -- --app transfer-voyagio --no-model --no-sources --out /tmp/v2-voyagio
- 结果：**通过** ｜ 步骤 24/24 ｜ 用时 33.6s
| end-on-recorded-stays-list | 成立 |  end-state-is-the-stays-page | 成立 |  recorded-for-the-frozen-checkin | 成立（2026-10-06）
exit code = 0

$ node --experimental-strip-types /tmp/v2-align.ts transfer-voyagio voyagio   # LAYA_TODAY=2026-10-02
got 24 / emitted 24 ; rolesUsed=["wizard-date","wizard-options","sort-fares","record-lowest"]
TOTAL diffs = 0 ; byField = {}
```

字段口径：`desc / start_url / target_hint / target_hints / signal / when / retries / slots`，`start_url` 按 `app-runner.startUrl` 解析后再比；基准是 `emitPlan("voyagio", loadSpec("voyagio"), …)` 展开的计划（24 步 = 1 入口 + 5 天 × 4（向导第1步/向导第2步/排序/记录）+ 3 酒店）。结论：**confirmed**（24/24 全字段全等，验收 24/24 + 3 不变量）。

## 9.3 transfer-slowjet（题面：冷启动重试 19 步）+ **retries 是否真被这条链路验证**

```text
$ npm run apps -- --app transfer-slowjet --no-model --no-sources --out /tmp/v2-slowjet
- 结果：**通过** ｜ 步骤 19/19 ｜ 用时 25.8s
| end-on-recorded-hotels-list | 成立 |  end-state-is-the-hotels-page | 成立 |  recorded-for-the-frozen-checkin | 成立（2026-10-07）
exit code = 0

$ node --experimental-strip-types /tmp/v2-align.ts transfer-slowjet slowjet   # LAYA_TODAY=2026-10-02
got 19 / emitted 19 ; rolesUsed=["filter-window","sort-flights","record-fare"]
TOTAL diffs = 0 ; byField = {}
```

结论（验收 + 对齐）：**confirmed**（19/19 全字段全等，19/19 + 3 不变量）。

**retries 真的被用到吗？——用原始观测回答：是。** 未改动的那次运行里，5 个 `record-fare` 步全是 **attempt 2**，日志有 5 条重试记录：

```text
| 3  | 记录 2026-10-05（周一）08:00-18:00 区间内最低价的航班 | done | 2 | - |
| 6  | 记录 2026-10-06（周二）… | done | 2 | - |
| 9  | 记录 2026-10-07（周三）… | done | 2 | - |
| 12 | 记录 2026-10-08（周四）… | done | 2 | - |
| 15 | 记录 2026-10-09（周五）… | done | 2 | - |
    -> retry 1/1: picked ref 'undefined' is not in the element pool on step 1     （×5）
# 尝试列统计：14 步 attempt=1，5 步 attempt=2
```

**证伪这一条**：临时副本把 `roles.record-fare.retries`（以及 journey 上任何 `retries`）删掉后重跑：

```text
$ node --experimental-strip-types src/app-runner.ts --app /tmp/v2-falsify/slowjet-noretry/pack.json \
    --no-model --no-sources --quiet --out /tmp/v2-falsify/out-noretry
slowjet-noretry exit=1
ok=False completed=14/19
blocked: (3,'记录 2026-10-05…','blocked',1,"picked ref 'undefined' is not in the element pool on step 1")
         (6/9/12/15 同上)
invariants: end-on-recorded-hotels-list=True, end-state-is-the-hotels-page=True, recorded-for-the-frozen-checkin=True
```

**判定**：**confirmed —— 这条链路真的在验证 `retries`**（去掉后 5 步在 attempt 1 全部 blocked，退出码 1）。**不是**"仍通过 ⇒ 没被验证"的那种情况。注意一个细节：这一轮 exit 1 来自**逐步 done**（14/19），三条**结束状态**不变量反而仍然成立（因为它们只看酒店页）。这正是 APPLY 的"不变量看不见中间要求"边界 —— 去掉重试后的失败由子目标信号抓住，不是由不变量抓住。

## 9.4 主动证伪：三包的不变量都不可能成立（临时副本）→ 必须 exit 1

```text
$ node --experimental-strip-types src/app-runner.ts --app /tmp/v2-falsify/<app>/pack.json --no-model [--no-sources] --quiet --out …
falsify-camera   exit=1   ok=False completed=4/4   invariants=[('impossible', False)]
falsify-voyagio  exit=1   ok=False completed=24/24 invariants=[('impossible', False)]
falsify-slowjet  exit=1   ok=False completed=19/19 invariants=[('impossible', False)]
```

结论：**confirmed** —— 三个包的动作腿都照跑（4/4、24/24、19/19），验收不成立 → `ok=false` → 退出码 1。

## 9.5 门禁与应用目录

```text
$ npm run apps:matrix
camera-entry      pack  0   0   4  0   3   221  0  -
transfer-slowjet  pack  0   3  19  0   3   233  0  -
transfer-voyagio  pack  0   4  24  0   3   283  0  -
应用 14 个 ｜ 声明 2154 行 ｜ 应用目录里的代码 0 行（期望 0：应用是数据，代码在共享层）
共享层文件 48 个（核心 26 个）｜ 应用声明的标识 20 个
泄漏检查：OK（核心层代码里没有任何应用声明的站点/工具标识）      exit code = 0（debt=0，未打印"债"一节）

$ find apps/camera-entry apps/transfer-voyagio apps/transfer-slowjet -type f
apps/camera-entry/pack.json
apps/transfer-voyagio/pack.json
apps/transfer-slowjet/pack.json
```

结论：**confirmed**（0 代码行 / 0 泄漏 / 0 债；三个新目录只有 `pack.json`，无 `.ts/.js/.mjs/.cjs`）。

## 9.6 Lead 本轮 5 项共享层加固（G-E/G-F/G-G/G-H/G-K）核验

（我只跑最小复现，不改 `src/**`；`src/app-pack.ts 6c7d7871…` / `src/probe-set.ts 9d37ddb3…` / `src/app-runner.ts 5ac3fc47…`）

| # | 最小复现 | 原始观测 | 结论 |
|---|---|---|---|
| G-E 跨列表重复 id | `validateProbeBlock({http:[{id:"a",…}],alts:[{id:"a",…}]}, ["m.ctrip.com"])` | `probe.alts[0]: duplicate target id "a" (already declared at probe.http[0]); ids are one namespace across the target lists` | confirmed 已修 |
| G-F 非字符串 id | `validateProbeBlock({http:[{id:7,url:…}]}, hosts)` | `probe.http[0].id must be a string (ids are referenced by roles/browser/repeat)` | confirmed 已修 |
| G-G 浏览器步无 `start_url` | `validatePack(demo-app，删掉 roles["add-to-cart"].start_url)` | `roles.add-to-cart: a browser step needs start_url (each subgoal re-navigates)` + `journey[1]: a browser step needs start_url (neither the role nor the override has one)` | confirmed 已修 |
| G-H 类型不校验 | `max_subgoals:"8"` / `slots:"ACME10"` / `sources:"demo-tool"` | `max_subgoals must be a positive integer` / `slots must be an object of slot -> value` / `sources must be a list of source names (a bare string would be read as a list of characters)` | confirmed 已修 |
| G-K retry 计数持久 | 同一 `--out` 目录连跑两次 `cli-report --allow-dangerous` | 两次都是 `step3 attempts = 3`；目录里出现两个不同的 `retry-counter-<run_id>` 文件（pack 已用 `--counter={out_dir}/retry-counter-{run_id}`） | confirmed 已修 |

G-K 的原始观测（修前是"第二次运行 attempts 变 1"，因为 `/tmp/layawebuse-apps/retry-counter` 持久）：

```text
$ for i in 1 2; do npm run apps -- --app cli-report --no-model --allow-dangerous --quiet --out /tmp/v2-gk; …; done
run1 exit=0   step3 attempts = 3 | ok = True
run2 exit=0   step3 attempts = 3 | ok = True
$ ls /tmp/v2-gk/retry-counter-*
retry-counter-mut2a499-2518009-4   retry-counter-mut2a53f-2518087-4
```

## 9.7 第 2 轮未能验证 / 边界

- **camera-entry 的"与 `buildPlan` 逐字段对比"按字面 unverifiable**：`src/camera-entry.ts` 没有 `buildPlan`（也没有 `settingsUrl`）。我改与 `DEMO_ROWS`/`TYPE_TO_FORM`/`FORMS` 逐行对比（0 问题），并单独确认了两条特殊行。若 Lead 期望的是另一个符号名，请指正。
- **两个 transfer 包的 `emitPlan` 基准用的是 `LAYA_TODAY=2026-10-02`**（与 §8 同一冻结时钟口径）；若不 pin，`nextWeekDates`/`bestOverall` 会随墙上时钟漂移，日期一变包就与 spec 不等——包里的日期因此是写死的（notes 已声明）。
- 我没有复核 `transfer/site5` / `site7` 的页面实现本身，只复核了"包展开的计划 == spec 展开的计划"与"验收真的跑通"。
- 三包 verdict 只对 §9 开头 pin 的 sha256 有效；若作者再改 pack，需重跑。

---

# 10. 第 3 轮复核（trekly / farehaven）

- 复核对象（**revision 固定**，mtime 均为 2026-10-04 08:30）：

```text
d29e5ac1661608e4d279fcd78fce8216322a7c22722c7aef6527c313e8b57b53  apps/transfer-trekly/pack.json
fed2a89ce5c1743d72ca37ffd13d5f459587579cda2772656ef6d3e9e70509fe  apps/transfer-farehaven/pack.json
```

- 本轮**未改 `src/**`**（只报告）；所有临时副本在 `/tmp`。方法同 §8/§9：题 → 命令 → 原始观测 → verdict。

## 10.1 transfer-trekly（题面：价格上限必须真的是 range 滑块 + 验收要体现"上限=300 / 结果收窄"）

```text
$ npm run apps -- --app transfer-trekly --no-model --no-sources --out /tmp/v3-trekly
- 结果：**通过** ｜ 步骤 19/19 ｜ 用时 26.5s        exit code = 0
| 16 | 打开 北京 2026-10-09 入住的酒店列表，并把价格上限设为 ¥300 | done | 1 |
| 17 | 把 北京 2026-10-09 入住的酒店列表按价格从低到高排序 | done | 1 |
| 18 | 记录当前显示的每一家酒店 | done | 1 |
| end-on-recorded-narrowed-stays-list | 成立 |
| the-slider-really-moved-off-its-default | 成立 |
| the-slider-narrowed-the-list-to-the-frozen-count | 成立 |
```

**range 滑块语义（四重证据，全部一致）**：

1. 页面本身就是滑块：`transfer/site3/hotels.html:20` → `<input type="range" id="max-price" name="cap" min="100" max="1500" step="50" value="1500">`，`#cap-state` 初值 `Max price: no limit`，`site3.js` 里 `slider.oninput = () => location.href = here({cap: v, sort})`、`#row-count` 按 `limit = Number(cap)` 过滤。
2. 包里点名的是滑块：step 16 `target_hint: "#max-price"`，`start_url` 是**不带 cap 的** `transfer/site3/hotels.html?checkin=2026-10-09`（所以必须靠 `fill` + `input` 事件导航）。
3. 运行日志走的是 fill 路径：`step 1: type text into input "1500 / Max price per night" (filled, rule:match, conf=1.00)` —— `input[type=range]` 没有单独动作，`locator.fill()` 设值并触发 `input`（CLAUDE.md 记录的实测）。
4. 验收的事实不是"某一步 done"，而是**结束状态**上的三个事实：`#cap-state` 含 `¥300`（滑块离开默认值，`not … "no limit"`）、`.stay-row` 非空、**`#row-count` 含 `12 stays`**（冻结数据 32 家 → cap=300 后 12 家）。第三条正是"结果收窄"的硬事实，且它确实在 e2e 里成立。

逐字段对齐：

```text
$ node --experimental-strip-types /tmp/v2-align.ts transfer-trekly trekly    # LAYA_TODAY=2026-10-02
got 19 / emitted 19 ; rolesUsed=["filter-window","sort-flights","record-lowest"]
TOTAL diffs = 0 ; byField = {}          # desc/start_url/target_hint(s)/signal/when/retries/slots 全等；when=0、retries=0
```

verdict：**confirmed**（滑块语义 + 收窄事实 + 19/19 全字段对齐）。

## 10.2 transfer-farehaven（题面：`when` 必须保留 5 条；e2e 必须真的出现 skipped）

```text
$ npm run apps -- --app transfer-farehaven --no-model --no-sources --out /tmp/v3-farehaven
- 结果：**通过** ｜ 步骤 24/24 ｜ 用时 26s          exit code = 0
（表格：20 行 done + 4 行 skipped）
| 5  | 如果 2026-10-06（周二）的机票页弹出了促销遮罩，就先关掉它 | skipped | 1 | - |
| 9  | 如果 2026-10-07（周三）的机票页弹出了促销遮罩，就先关掉它 | skipped | 1 | - |
| 13 | 如果 2026-10-08（周四）的机票页弹出了促销遮罩，就先关掉它 | skipped | 1 | - |
| 17 | 如果 2026-10-09（周五）的机票页弹出了促销遮罩，就先关掉它 | skipped | 1 | - |
| end-on-recorded-hotels-list / end-state-is-the-hotels-page / recorded-for-the-frozen-checkin | 均成立 |
```

**`when` 如实保留 = 5 条**（展开后的计划）：

```text
$ node --experimental-strip-types /tmp/v3-when.ts
transfer-farehaven: subgoals=24 when=5 retries=0
   [1]  {"css_exists":["#promo-modal"]}  如果 2026-10-05（周一）…
   [5]  … [9] … [13] … [17]              （每天一条）
transfer-trekly:    subgoals=19 when=0 retries=0
```

第 1 条（10-05）**done**：`window.FAREHAVEN.promoDates = ["2026-10-05","2026-10-06","2026-10-07"]`，但 `site6.js` 用 `localStorage.fh_promo_handled` 记住"已处理"——第一次关掉后，同一次运行里后续日期（含另两个 promo 日）不再渲染 `#promo-modal`，`when` 为假 → **4 条 skipped**。所以"部分页面才有遮罩"这件事被如实表达成 `done ×1 + skipped ×4`，不是"全都 done"也不是"全都跳过"。

逐字段对齐：

```text
$ node --experimental-strip-types /tmp/v2-align.ts transfer-farehaven farehaven
got 24 / emitted 24 ; rolesUsed=["dismiss-promo","filter-window","sort-flights","record-lowest"]
TOTAL diffs = 0 ; byField = {}          # 含 when：5 条逐字段与 spec 展开一致
```

**证伪 `when` 的区分度**：临时副本删掉 `roles.dismiss-promo.when`（journey 无内联 when）后重跑：

```text
$ node --experimental-strip-types src/app-runner.ts --app /tmp/v3-falsify/farehaven-nowhen/pack.json \
    --no-model --no-sources --quiet --out /tmp/v3-falsify/out-nowhen
farehaven-nowhen exit=1
ok=False completed=20/24
[5]  blocked attempts=1 obstacle=picked ref 'undefined' is not in the element pool on step 1
[9]  blocked attempts=1 obstacle=…
[13] blocked attempts=1 obstacle=…
[17] blocked attempts=1 obstacle=…      # 恰好是没有遮罩的那 4 天
invariants 仍全部成立（它们只看酒店结束状态）
```

verdict：**confirmed** —— 删掉 `when` 后**阻塞在恰好 4 个没有浮层的日期上**，所以这条 `when` 在当前数据下**是被区分性地验证**的（不是"有没有它都一样"）。与 §9.3 的 `retries` 同型：exit 1 来自**逐步 done**（20/24），不变量本身仍成立。

## 10.3 证伪：不变量换成不可能成立（临时副本）→ exit 1

```text
falsify-trekly    exit=1  ok=False completed=19/19 invariants=[('impossible', False)]
falsify-farehaven exit=1  ok=False completed=24/24 invariants=[('impossible', False)]
```

verdict：**confirmed**（动作腿照跑，验收不成立即退出码 1）。

## 10.4 门禁与应用目录

```text
$ npm run apps:matrix
transfer-trekly     pack  0  3  19  0  3  235  0  -
transfer-farehaven  pack  0  4  24  0  3  272  0  -
应用 16 个 ｜ 声明 2661 行 ｜ 应用目录里的代码 0 行（期望 0：应用是数据，代码在共享层）
泄漏检查：OK（核心层代码里没有任何应用声明的站点/工具标识）      exit code = 0（debt=0）

$ find apps/transfer-trekly apps/transfer-farehaven -type f
apps/transfer-trekly/pack.json
apps/transfer-farehaven/pack.json        # 只有 JSON，没有 .ts/.js/.mjs/.cjs
```

verdict：**confirmed**（0 代码行 / 0 泄漏 / 0 债；两目录只有 `pack.json`）。

## 10.5 第 3 轮未能验证 / 边界

- trekly 的"结果收窄"事实绑在**冻结数据集**上（`12 stays`）：数据集一换，不变量里的 12 就要跟着改——packs 的日期/cap 都是写死的，这是与 §8/§9 同一条"冻结语料"约定。
- 我没有复核 `transfer/site3` / `site6` 的生成器（`transfer/data3.ts` / `data6.ts`）本身，只复核了"包展开 == spec 展开"、"验收真的跑通"、以及两页的行为文件（`site3.js` / `site6.js`）。
- 两个 verdict 只对 §10 开头 pin 的 sha256 有效；作者若再改 pack 需重验。

---

# 11. 第 4 轮复核（skybook / flyquest）

- 复核对象（**revision 固定**，mtime 均为 2026-10-04 09:08）：

```text
d0b2d13d8dc1128954ebf85942520c6af9c3b2d06928acf2c4f486639b16bf59  apps/transfer-skybook/pack.json
e5723bd160546009ce837f5c449eb05bdb9e7c4c0798922232510eeb8b390ab8  apps/transfer-flyquest/pack.json
```

- 本轮**未改 `src/**` / `tools/**`**（只报告）；临时副本在 `/tmp`。方法同 §8–§10：题 → 命令 → 原始观测 → verdict。

## 11.1 transfer-skybook（题面：23 步；角色覆盖率 + 信号是否彼此独立）

```text
$ npm run apps -- --app transfer-skybook --no-model --no-sources --out /tmp/v4-skybook
- 结果：**通过** ｜ 步骤 23/23 ｜ 用时 31.1s        exit code = 0（23 行 done）
| end-on-recorded-second-page | 成立 |
| the-second-page-was-really-selected | 成立 |
| end-state-is-the-hotels-page | 成立 |
```

**角色覆盖率**（包的 `roles` + journey）：23 步里 **5 个角色模板覆盖 19 步**，其余 4 步内联（无 role）：

```text
$ python3 -c "…role coverage…"
roles: [filter-window, sort-flights, record-lowest, select-all, record-selected]
filter-window 5 | sort-flights 5 | record-lowest 5 | select-all 2 | record-selected 2 | (inline) 4
inline（无 role）步：0 入口 / 16 酒店设上限 / 17 酒店排序 / 20 翻到第 2 页
```

（spec 里有 8 个 role；包把 entry / set_cap / 酒店 sort / next_page 这 4 个只出现一次的步骤直接内联，把"真正重复的形状"留成模板 —— 与 §8 的口径一致：内联不等于丢字段，逐字段对齐证明这一点。）

**信号是否彼此独立**（在 23 步展开计划上按 `signal` 分组）：

```text
$ node --experimental-strip-types /tmp/v4-signals.ts
subgoals = 23 ; distinct signals = 8 ; duplicate groups = 5
  x5 idx=[1,4,7,10,13] pages=["flights.html"]  {"css_text_contains":["#window-state","08:00-18:00"]}
  x6 idx=[2,5,8,11,14,17] pages=["flights.html","hotels.html"]  {"css_text_contains":["#sort-state","price (low to high)"]}
  x5 idx=[3,6,9,12,15] pages=["flights.html"]  {"css_text_contains":["#last-record","Recorded"]}
  x2 idx=[18,21] pages=["hotels.html"]  {"css_text_contains":["#selection-count","Selected"]}
  x2 idx=[19,22] pages=["hotels.html"]  {"css_text_contains":["#hotel-recorded","Recorded"]}
```

读法（诚实区分两种重复）：
- **同角色、按日期/页码重复**（预期内）：筛时段 ×5、记录最低价 ×5、勾选 ×2、记录 ×2 —— 它们是同一步骤模板在 5 个日期 / 2 页上的实例，信号相同是因为**角色相同**，不是"抄了别人的信号"。
- **跨页面重复 1 组（值得记下）**：`#sort-state` + "price (low to high)" 共 6 次 = 机票排序 ×5 + **酒店排序 ×1**（idx 17）。也就是说这个 done-signal 本身**不能区分"机票排好了"与"酒店排好了"**；之所以不产生歧义，是因为每个子目标都先重新 `goto` 到自己的页面（执行器每步重启、状态在 URL 里），信号是在正确的页面上求值的。若将来有人把这两步合并到同一页面上，这个信号就会失去区分度。
- 其余 3 组都是"同角色不同实例"，无跨角色抄用。

逐字段对齐：

```text
$ node --experimental-strip-types /tmp/v2-align.ts transfer-skybook skybook    # LAYA_TODAY=2026-10-02
got 23 / emitted 23 ; rolesUsed=["filter-window","sort-flights","record-lowest","select-all","record-selected"]
TOTAL diffs = 0 ; byField = {}
```

verdict：**confirmed**（23/23 + 3 不变量；5 角色覆盖 19 步 + 4 内联；信号 8 种，重复组 5 个，其中 1 个跨页面 —— 已如实记录）。

## 11.2 transfer-flyquest（题面：结果页只能由**提交表单**产生 → 那一步必须是有序 `target_hints`）

```text
$ npm run apps -- --app transfer-flyquest --no-model --no-sources --out /tmp/v4-flyquest
- 结果：**通过** ｜ 步骤 19/19 ｜ 用时 33.4s        exit code = 0（19 行 done）
| end-on-recorded-stays-list | 成立 |
| end-state-is-the-stays-page | 成立 |
| recorded-for-the-frozen-checkin | 成立 |
```

**那一步确实是"先填表单再提交"的有序列表**（`roles.search-form`，覆盖 5 个日期）：

```text
{"desc": "打开 2026-10-05（周一）…并把出发时段筛选为 08:00-18:00",
 "start_url": "transfer/site4/search.html",              ← 不带任何查询串
 "target_hints": ["#date", "#window", "#search-btn"],    ← 有序：填日期 → 选时段 → 提交
 "signal": {"css_text_contains": ["#window-state", "08:00-18:00"]},
 "slots": {"date": "2026-10-05"}}
```

后面的排序/记录步的 `start_url` 才是 `fares.html?...`（结果页），即结果页只能由这次表单提交产生；`search.html` 本身不是结果页。

**退化证伪**：临时副本把该 role 的 `target_hints` 换成单个 `target_hint: "#date"` 后重跑：

```text
$ node --experimental-strip-types src/app-runner.ts --app /tmp/v4-falsify/flyquest-singlehint/pack.json \
    --no-model --no-sources --quiet --out /tmp/v4-falsify/out-singlehint
flyquest-singlehint exit=1
ok=False completed=14/19
[1]  blocked attempts=1 obstacle=picked ref 'undefined' is not in the element pool on step 2
[4]  blocked attempts=1 obstacle=…    （[7] [10] [13] 同）
invariants 仍全部成立（只看酒店结束状态）
```

5 个 `search-form` 步在**第 2 个动作**上卡住（obstacle 明确写着 `on step 2`）：单 hint 在填了 `#date` 之后仍然权威，同一个元素被再选 → inert/forbidden → 落到模型而脚本模型答不出 `act` → blocked。**判定：有序 `target_hints` 是被区分性验证的**（删掉就红，且红的正是那 5 步）。与 §9.3 `retries`、§10.2 `when` 同型：exit 1 来自逐步 done，不变量本身仍成立。

逐字段对齐：

```text
$ node --experimental-strip-types /tmp/v2-align.ts transfer-flyquest flyquest
got 19 / emitted 19 ; rolesUsed=["search-form","sort-fares","record-cheapest"]
TOTAL diffs = 0 ; byField = {}          # 含 target_hints 两条（search-form 3 元素 / 酒店 cap 2 元素）
```

verdict：**confirmed**。

## 11.3 证伪：不变量换成不可能成立（临时副本）→ exit 1

```text
falsify-skybook   exit=1  ok=False completed=23/23 invariants=[('impossible', False)]
falsify-flyquest  exit=1  ok=False completed=19/19 invariants=[('impossible', False)]
```

verdict：**confirmed**。

## 11.4 门禁与应用目录

```text
$ npm run apps:matrix
transfer-flyquest  pack  0  3  19  0  3  252  0  -
transfer-skybook   pack  0  5  23  0  3  282  0  -
应用 18 个 ｜ 声明 3197 行 ｜ 应用目录里的代码 0 行（期望 0：应用是数据，代码在共享层）
泄漏检查：OK（核心层代码里没有任何应用声明的站点/工具标识）      exit code = 0（debt=0）

$ find apps/transfer-skybook apps/transfer-flyquest -type f
apps/transfer-skybook/pack.json
apps/transfer-flyquest/pack.json         # 只有 JSON
```

verdict：**confirmed**（0 代码行 / 0 泄漏 / 0 债；两目录只有 `pack.json`）。

## 11.5 全量套件 `npm run apps:suite`（题面：现在应是 12 个离线旅程应用）

```text
$ npm run apps:suite
应用                  步骤  完成     跳过  不变量  用时     结论
camera-entry        4   4/4    0   3/3  7.3s   通过
cli-report          5   4/5    0   0/0  0.5s   待放行(未执行)
ctrip-case          19  19/19  0   3/3  7.3s   通过
demo-app            5   5/5    0   2/2  2.1s   通过
ip-config           8   8/8    0   3/3  2.4s   通过
repo-report         3   3/3    0   0/0  0.2s   通过
transfer-farehaven  24  24/24  4   3/3  28s    通过
transfer-flyquest   19  19/19  0   3/3  30.7s  通过
transfer-skybook    23  23/23  0   3/3  23.3s  通过
transfer-slowjet    19  19/19  0   3/3  23.2s  通过
transfer-trekly     19  19/19  0   3/3  21.5s  通过
transfer-voyagio    24  24/24  0   3/3  28.2s  通过

跳过（不是豁免：它们要真网络，另有验收口径）：
  - ctrip-live（测量型应用：只声明 probe，要真网络）
  - ota-live（测量型应用：只声明 probe，要真网络）
  - qunar-live（线上旅程：start_url 是 http(s)，要真网络）

应用套件：11/12 通过，1 个待显式放行（危险步未执行）  ← 离线旅程型应用没有红项
  - cli-report：危险步未执行（验收命令要带 --allow-dangerous）
exit code = 0
```

verdict：**confirmed**（12 个离线旅程应用都在表里；3 个需要真网络的应用**明着跳过**；`cli-report` 因为危险步没放行而记「待放行(未执行)」——既不算绿也不算红，与 CLAUDE.md 的口径一致）。本轮是我自己跑的，`transfer-skybook` / `transfer-flyquest` 的 23/23、19/19 与 §11.1/§11.2 的单独验收一致。

## 11.6 第 4 轮未能验证 / 边界

- skybook 的 `#sort-state` 跨页面重复（flights ×5 + hotels ×1）**依赖"每个子目标先重新 goto 到自己的页面"才不产生歧义**；如果将来把机票/酒店的排序并到同一页面，这条 done-signal 需要拆开。
- 我只统计了"信号文本相同"的重复组，**没有**逐条评估"这个信号是否只在正确页面上才可能成立"（那需要给每一步注入错误页面的反事实运行，超出本轮范围）。
- flyquest 的退化实验只做了 `target_hints → target_hint("#date")` 这一种退法；退化成 `target_hint("#search-btn")`（直接提交、不填日期）预期也会红（信号要求 `#window-state` = 08:00-18:00），但**未实测**。
- 两个 verdict 只对 §11 开头 pin 的 sha256 有效；`apps:suite` 的表是那一刻仓库状态的整体快照。

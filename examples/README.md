# AmberFlow 离线示例（v3 M0 onboarding）

> **这些示例不是仓库内置应用。** AmberFlow 仓库仍然不内置任何 `app`：运行器只在
> `$AMBERFLOW_HOME/apps`（缺省 `~/.amberflow/apps`）发现应用。`examples/apps/**` 只是
> **可读、可校验、可直接抄的源材料**——复制到用户作用域之后才成为可运行应用。

## 为什么有 `examples/`

- flow 应用只有一种格式：`$AMBERFLOW_HOME/apps/<id>/app.mjs`，导出 `meta(kit)` 与 `flow(ctx)`。
- 新作者（以及替你写脚本的 Agent）需要一组最小、正确、**可以在离线环境验证**的样板：
  声明面长什么样、完成信号怎么写、敏感槽位怎么处理、人工步怎么表达。
- 这些示例的价值在于**离线校验**：不开浏览器、不调模型、不联网，就能证明"脚本能加载、
  调用序列/信号/命令/槽位声明合法"。真实页面会不会成立是另一回事（见下面的边界）。

## 示例清单

| 示例 | 演示什么 |
|---|---|
| `01-basic-step` | 最小 `ctx.arrive` + `ctx.step` + DOM 完成信号 + `invariants`；验证步用零动作命令 `skip` |
| `02-slots-and-signals` | `slots` / `requiredSlots`（值只来自声明）+ `all_of` / `not` 组合信号 + 槽位绑定命令 |
| `03-secret-slots` | `meta.secretSlots: ["password"]`：产物 / report / stdout / dry 输出一律掩码 `***` |
| `04-manual-verify` | `ctx.manual` 人工步（登录 / 2FA）；非 TTY 返回 `needs_human`，不假装有人 |

## 离线校验（推荐先跑这个）

在 checkout 根目录：

```bash
node --experimental-strip-types tools/examples-check.ts
# 门禁里的等价命令：npm run examples-check（跑的就是上面这条 node 命令）
```

脚本（`tools/examples-check.ts`，纯 Node，无新依赖）做的事：

1. 建**临时** `AMBERFLOW_HOME`，把 `examples/apps/*` 复制到 `<tmp>/apps/`（不污染真实 `~/.amberflow`）；
2. 逐个跑 `apps check <id>`，断言 exit 0；
3. 逐个跑 `apps explain <id> --json`，断言 exit 0 且 `problems` 为空；
4. 逐个跑 `app-runner --app <id> --dry`，断言 exit 0、`dry_run=true`、`problems` 为空；
5. 对 `03-secret-slots`：写一次性 canary 到 `--slot-file`（JSON，`chmod 600`）再 dry，
   断言 stdout 含 `***`、且 canary 在 stdout+stderr **零命中**；
6. 全过打印 `PASS` 与示例数、exit 0；任何一项失败打印命令与输出、exit 1
   （临时 home 保留在 `/tmp/amberflow-examples-*` 便于排查）。

注意：`apps check` / `--dry` 的绿只证明「脚本能加载、调用序列/信号/命令/槽位声明合法」，
**不证明真实页面状态会成立**。真跑需要 `npx playwright install chromium`。

## 复制到用户作用域并运行

```bash
export AMBERFLOW_HOME="${AMBERFLOW_HOME:-$HOME/.amberflow}"
mkdir -p "$AMBERFLOW_HOME/apps"
cp -R examples/apps/01-basic-step "$AMBERFLOW_HOME/apps/"
```

在 checkout 里 `npx amber …` 会挂住（bin 没链进 `node_modules/.bin`），用等价形式：

```bash
node --experimental-strip-types src/cli/main.ts apps check 01-basic-step
node --experimental-strip-types src/cli/main.ts apps explain 01-basic-step
node --experimental-strip-types src/cli/main.ts run 01-basic-step --dry-run --json
# 真跑（需要 chromium）：
node --experimental-strip-types src/cli/main.ts run 01-basic-step
```

`npm link` 之后可把 `node --experimental-strip-types src/cli/main.ts` 换成 `amber`。
`npm run apps -- --app 01-basic-step` 是同一运行器的另一种入口。

换真实项目时要注意：

- `01-basic-step` / `04-manual-verify` 指向公开的 `https://example.com/`，装好 chromium 后可以真跑；
  `04` 的人工步需要交互 TTY，headless 下要让人操作页面请加 `--headful`（无显示器用 `xvfb-run` + VNC）。
- `02-slots-and-signals` / `03-secret-slots` 是**声明面示例**：页面角色和选择器是占位形状
  （`#search-input`、`#password-input`），真跑前用 `amber inspect --url <你的页面> --json`
  换成验证过的页面与锚点；离线 dry 校验不需要改。
- `apps check` 在加载期要求 `requiredSlots` 的槽位在 `meta.slots` 里有默认值（可以是空串），
  否则会报 `required slot "…" has no value`——示例里 `password: ""` 就是为此存在的占位，
  **不是**建议把密码写进脚本。

## `03-secret-slots`：敏感槽位演示

`meta.secretSlots: ["password"]` 声明后，该槽位的值在 result JSON / report / stdout / dry 输出里
一律掩码为 `***`。值不要写进 `app.mjs`；用一次性 `--slot-file`（JSON 对象）或环境变量 / 本机配置：

```bash
SLOT_FILE="$(mktemp)"
printf '{"password":"%s"}' "CANARY-demo-not-a-real-credential" > "$SLOT_FILE"
chmod 600 "$SLOT_FILE"
node --experimental-strip-types src/app/app-runner.ts --app 03-secret-slots --dry --slot-file "$SLOT_FILE"
# stdout 里应看到 "password": "***"，且不应出现 canary 明文
rm -f "$SLOT_FILE"
```

（`--slot k=v` 的明文会进进程参数 / 桥 argv；敏感值别用它。）

## 边界与纪律

- 示例里不放真实凭据、Cookie、token；校验脚本的 canary 每次随机生成，随临时目录一起删除。
- `examples/` 不是仓库内置应用的存放处：升级/重装 checkout 不会保留你复制到用户作用域的应用，
  反过来也不要指望仓库里的 `examples/apps/**` 被运行器发现。
- 运行产物、截图、DOM 不进仓库；真实站点记录按证据敏感性处理。
- 应用脚本是进程内任意代码：信任边界 = 「用户作用域 + 不放仓库」，引擎不沙箱化脚本。

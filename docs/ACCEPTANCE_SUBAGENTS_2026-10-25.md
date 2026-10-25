# 子代理独立验收记录（2026-10-25，HEAD `0ed6087` 验收 → 修复批）

> 目的：让**不带有本次实现上下文**的独立代理按"使用者/审计者"视角验收"至 L3 所有功能项"，
> 只认命令与原始输出。验收完成后再由 Lead 逐条复现并修复。本文记录派发方式、各代理结论、
> 缺陷清单与修复状态——**不隐藏失败**（有一个代理本身运行失败，已记录并安排复验）。

## 1. 派发方式

- 4 个**全新上下文**的子代理（不是 fork，避免继承实现者的自我确认），同一仓库、只读约束：
  - 不改 tracked 文件、不 git 写操作；临时文件只写 `/tmp/accept-*`；
  - 不跑全量 `bench/smoke.sh` / `npm run verify` / `npm test`（终端门禁由 Lead 另跑）；
  - 必须给「检查项 / 命令 / PASS|FAIL / 证据」与可复现缺陷。
- 分工：
  - **A 用户旅程**：CLI 发现/按 id/脚手架/dry-run/emit/remove/旗标；
  - **B ctx API**：ctx 成员、三实现一致性、trace/replay、policy；
  - **C L3 打包**：pack.json 删除、app.mjs、apps:gen/migrate/matrix/parity、suite 两臂；
  - **D 破坏性审计**：静默失败/假绿/错误可行动性/NO_SCRIPTS 安全边界。

## 2. 结果概览

| 代理 | 结果 | 关键结论 |
|---|---|---|
| A 用户旅程 | 11/12 PASS | 发现 1 个 P1：`apps explain` 对坏脚本报 INTERNAL/exit 1（应为 exit 2）；另有 3 个 UX/文档问题 |
| B ctx API | 主路径 PASS，4a FAIL | 发现 7 条：dry hosts 漏检、`ctx.arrive` 漂移、`ctx.command` 无 id、`ctx.url` 三实现不一致、dry 允许 done 两次、cli retries 纪律绕过、`sameEventStructure` 忽略 result |
| C L3 打包 | **复验通过** | 首轮代理进程失败；二轮复验（§6）全项 PASS，另指出 5 条文档口径问题（§7） |
| D 破坏性审计 | 13 项 PASS / 5 项 FAIL | 发现 8 条，最重：**flow 不调 `ctx.done()` 却 ok=true/套件"通过"**、dry hosts、flow 不变量 signal 不校验、NO_SCRIPTS 挡不住 explain/emit 的 import |

## 3. 缺陷清单与修复状态（已全部修复并有回归测试）

| # | 严重度 | 缺陷（最小复现要点） | 修复 |
|---|---|---|---|
| 1 | 高 | flow 声明 invariants 但从不调 `ctx.done()`：`run` ok=true，suite 打"0/1 不变量 · 通过" | `runScriptApp`：无 done 事件且声明了不变量 → `missing_done`、ok=false；suite 随之 failed |
| 2 | 高 | dry 的 hosts 信封只守 `open`；`openPage`/`arrive`/`step(url)` 在 check 期绿、真跑 `host_not_allowed` | `createDryCtx.assertHost`：四条导航入口用与真实同一份 `resolveCtxUrl + disallowedHost` |
| 3 | 高 | flow 的 web 不变量 signal 从不校验（`url_containz`/空 signal check 全绿） | `validatePack`：`invariants[].signal` 走 `validateSignalSpec`（flow 空 journey 也走） |
| 4 | 高 | `AMBERFLOW_NO_SCRIPTS=1` 挡不住 `apps explain/emit` 的 `import()`：脚本顶层副作用照跑 | `loadScriptApp` 入口硬拒（env 置位即不 import） |
| 5 | 高 | `ctx.arrive` 误走 step 路径：记录成 `step`、还可能 `no_model_runtime`，replay 必 mismatch | 真实 `arrive` = goto + 轮询 done 信号，记录 `arrive`（不做元素选择/不花模型） |
| 6 | 中 | `ctx.command()` 不带 id：dry 报错 / 真实静默丢弃命令 | `normalizeCommandIds` 补稳定 id（`cmd<N>_<op>`）；kit.command 支持显式 id |
| 7 | 中 | `ctx.url()` 在相对 `open` 后：dry 留原始串、真实解析 file://、replay 用原串 | dry/replay 统一用 `resolveCtxUrl`/trace URL；三处一致 |
| 8 | 中 | flow 的 cli 工具步 `retries>0` 未要求 `idempotent`（声明式有，flow 绕过） | dry 与真实 ctx 都拒绝（与适配器同一纪律） |
| 9 | 中 | dry 允许 `ctx.done()` 两次，真实 config_error | dry 也报 `ctx.done called twice` |
| 10 | 中 | `sameEventStructure` 完全忽略 result（文档称含"结果"） | 纳入 result（剥离每次都会变的 `elapsed_ms`） |
| 11 | 中 | 同时导出 `app` 与 `flow` 静默取 flow，另一个永不校验 | 加载期报错（二者只能选一） |
| 12 | 中 | `apps explain` 对加载失败的脚本报 INTERNAL/exit 1 | 改为 `usageError`（exit 2 + 原因 + 下一步） |
| 13 | 低 | 手写 flow 在 `apps list --json` 的 label 为空 | label 回退目录名 |
| 14 | 低 | 最小脚本缺 `label` 被 `label is required` 拒 | `label` 回落 `id` |
| 15 | 低 | DOM 未知信号算子不列 known（tool/command 都列） | `DOM_SIGNAL_GRAMMAR.listKnown = true` |
| 16 | 低 | `--force-hints off` 在 `--dry-run` 下静默 exit 0 | guard 提前到 dry 分支之前 |
| 17 | 低 | `ctx.done()` 语义文档未覆盖 `missing_done`/`arrive_signal_not_held` | 作者指南错误码表补齐 |

回归测试：`tests/acceptance-fixes.test.ts`（18 条，覆盖上表 1–16）+ `script-cli-ux` / `script-policy` /
`ctx-site` / `signal-grammar` 的相应扩展。

## 4. 代理指出的"既有测试断言太弱"（已采纳的理由，未全改）

- `ctx-site` 一致性只比 `call/desc` 不比 `url` → 已新增 `ctx.arrive`/URL 解析专用用例（覆盖该盲区）。
- `apps-suite-script` 只有 happy path → 已新增 missing_done 的失败路径（`acceptance-fixes` #1）。
- `script-cli-ux` 的 `--emit-trace` 只查 argv → 暂不扩（该用例目的就是旗标翻译，端到端 trace 由
  `tests/ctx.test.ts`/`ctx-site.test.ts` 覆盖）。
- `script-cli-ux` 对合法脚本只断言 exit 0 → 已新增"坏脚本 explain exit 2"用例强化。

## 5. 未修复 / 接受为残余（记录，不假装）

1. **语法错误无行号**：problem 只有 `Unexpected token '}'`（有脚本路径头）。需要 source-map 整形，收益中等。
2. `run --dry-run --json` 在**加载失败**时 envelope 无 `problems`（message/hint 有真实原因）。
3. `amber doctor --help` 混入其它命令的旗标（registry 的通用 flags 组装问题，历史遗留）。
4. `ctx.openPage` 指向仓库内不存在的文件时 dry 仍绿（真跑 `ERR_FILE_NOT_FOUND`；可静态 stat，未做）。
5. flow 应用在 `apps:suite` 的 `hint 覆盖` 列恒 0/0（hint 是运行期参数，静态数不出来；文档已说明）。
6. 脚本沙箱未做（信任边界仍是"用户作用域 + `AMBERFLOW_NO_SCRIPTS=1` + `script_sha256`"）。
7. ~~代理 C 运行失败~~ → **已复验**（见 §6）；复验暴露的文档口径问题已在 §7 修正。


## 6. 二轮复验（2026-10-25，修复提交后）

| 复验者 | 范围 | 结果 |
|---|---|---|
| **C2（新派）** | L3 打包/门禁 | 17 项 PASS：pack.json=0、app.mjs=21、8 个 `src/app/*`、apps:gen 8/8、migrate 21/21（仓库口径）、probes 3/3、nominate OK、parity 67/67、matrix 21 declarative/0 code/0 logic/0 leaks/0 debt、loadPack 同步读、suite 两臂、修复回归 18 条、ctx 三测 16 条 |
| **E（新派，红队）** | 修复复核 + 残留假绿 | 必测 A1–A6 全 PASS（missing_done、dry hosts 四入口、invariant signal、NO_SCRIPTS 8 入口无 import、arrive 轨迹+replay、command/retries/done 纪律）；另跑回归 44 条全绿。**但指出 9 条残留 R1–R9** |

**二轮残留（已修，见 §3 修复批 2）**：R1 吞掉 done 失败仍报绿；R2 302 落地主机未校验/`ctx.url()` 撒谎；
R3 dry 不覆盖静态可判定声明错误；R4 失败轨迹重放报"通过"；R5 replay.arrive URL 漂移；R6 NO_SCRIPTS 错误
不可行动；R7 用户作用域 flow 脚本打红 `apps:gen/migrate`；R8 done 后仍可动作；R9 套件无"步骤失败"列（接受）。

修复后回归：`tests/acceptance-fixes.test.ts` 30 条（R1–R8 每条都有反例），`tests/ctx-pilots.test.ts`
按解析后 URL 归一化；`bash bench/smoke.sh` 复跑见提交记录。

## 7. 二轮复验指出的文档口径问题（已修）

1. **应用数量口径**：仓库内是 **21** 个应用（21 个 `app.mjs`、删除 21 个 `pack.json`）；此前多处写 22
   （把用户作用域的 `dsh-learn-probe` 算进去了）。本计划已改为「仓库 21；用户作用域应用另计」。
2. **README 绝对化**："一个应用 = `apps/<id>/app.mjs`" 会让人误以为纯数据源目录（`bench-cases` /
   `demo-tool` / `git-log` / 保留 flow.json 的模板应用）也是这种形态——已限定为"**旅程型**应用"。
3. **suite 默认臂文档过期**：`apps/README.md` 与 `tools/apps_suite.ts` 的 usage 仍写"默认臂=脚本桩 /
   `--real-model`"；实际默认=真模型、`--ablate`=消融臂。已同步。
4. **等价性声明的口径**：`apps/README.md` 仍写"与既有 `pack.json` 逐字段 0 diff"；pack.json 已删，
   `loadPack("apps/x/pack.json")` 实际解析到 `app.mjs`。已改为"与迁移前的历史包 0 diff"。
5. **matrix/migrate 的 22/22**：依赖用户作用域；文档统一标注口径（仓库 21/21；含用户作用域时 22/22）。

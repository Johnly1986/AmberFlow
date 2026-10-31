# Changelog

AmberFlow（冻结计划的浏览器自动化中间件）的显著变更。本文件格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

## [2.0.0] - 未发布

2.0.0 是一次结构性重构：仓库从「决策任务流引擎 + 声明式应用 + 离线夹具/复刻站」收敛为
**冻结计划的浏览器自动化中间件**——单一执行循环、单一应用作者模型（`meta` + `flow(ctx)` 脚本）、
真实站点线上套件与可验证的执行证据。本版本尚未 npm 发布、未打 git tag；下列内容即当前工作树的
未发布摘要，发布形态见文末「发布形态（待定）」。

### 新增

- 应用唯一格式：`$AMBERFLOW_HOME/apps/<id>/app.mjs` 的 `meta` + `flow(ctx)` 脚本；配套
  `amber apps new/list/show/check/explain/path/remove` 命令面，`apps check` / `apps explain`
  只做加载与 dry 调用序列校验（不开浏览器、不调模型）。
- `amber inspect`：只读观察真实页面元素与候选 hint；`amber record`：演示一次并归纳完成信号，
  零模型调用回放不通过就不落盘。
- 真实站点测试声明层 `online/`（`sites/*.json` 与 `cases/{smoke,core,deep,probe}/*.json`）：
  退出码 0/1/2/3 语义、`--require-all`、证据写 `$AMBERFLOW_HOME/online-runs/` 且不入库。
- `amber schema ctx` 自描述语义契约与 `dist/schema/ctx.json` 快照（`--check` 做漂移门）。
- 统一执行循环 `BrowserMiddleware.run`：完成信号语言（9 算子 + 组合器 + `manual`）、
  元素池以 AX 可访问性树为主源、结构化停因与 trace / replay（`script_sha256`）锚点。
- 人工步（`ctx.manual`）与可配置运行节奏（`meta.pace`）；非 TTY 不假装有人。
- 决策源统一：线上三件套 `AMBERFLOW_DECISION_BASE_URL` / `_MODEL` / `_API_KEY`；无地址用本地
  `laya-onnx`（`AMBERFLOW_DECISION_MODEL=english|multilingual` 选 checkpoint）。
- DSH 桥（`integrations/dsh-bridge/`，9 个 model-facing 工具）与仓库根 bundle 安装门
  （`dsh-bundle.yml`）：`dsh plugin add github:Johnly1986/AmberFlow` 即可接入。
- `npm run check` PR 门禁：`typecheck` + 配置示例一致性 + schema 快照漂移 + 提示词/信号一致性 +
  线上用例声明校验。

### 变更

- 线上套件 npm 入口由 `online` 更名为 `test`（`npm run test -- --tier smoke|core|deep|probe`）。
- 配置收敛为单一 schema 声明（`configs/amberflowrc.example.json` 由 schema 生成并做一致性检查）；
  移除 provider 配置键与命令行模型旗标，`--provider` 只用于本次实验/消融。
- 应用作者模型收敛为 flow 脚本：仓库不再是「决策任务流引擎」，`flow.json` / `pack.json`
  声明式应用与语义模板被 `app.mjs` 取代。

### 移除

- `pack.json`、声明式数据脚本、语义模板等旧应用格式。
- 离线夹具、复刻测试页、内置应用与真实站点冻结证据；`vitest` 单测与 parity 工具链。
- 历史报告 / 基准 / 应用清单等过时文档（当前事实以 `AGENTS.md`、`ARCHITECTURE.md`、`docs/` 为准）。

### 安全

- 完成只认信号，模型 done 票仅 advisory；值只来自计划/观察，缺值返回 `needs_value`。
- 凭据只允许 `{{env:NAME|default}}` 占位符；明文凭据不得进入用例/计划/产物/仓库，本机配置
  `configs/amberflowrc.json` 已被 gitignore。
- 不绕过反爬（不伪造指纹、不轮换代理、不规避风控/速率限制，风控拦截按 `blocked` 停止）；
  验证环节（登录/2FA/验证码等）可在用户授权下代过。

### M0 基础设施（2026-10-31，未发布）

- CI `checks.yml`：check job 在 `npm run check` 之前生成 `dist/schema/ctx.json` 快照（该文件是
  构建产物、已被 gitignore 排除），干净 checkout 不再因 `SCHEMA_SNAPSHOT_MISSING` 变红。
- CI `checks.yml`：online job 改用真实入口 `npm run test -- --tier smoke --require-all`
  （原 `npm run online` 在 v2 更名后已不存在）；保留定时/手动触发与证据上传语义。
- CI `bridge.yml`：删除调用已不存在的 `tests/*.spec.ts` + `vitest` 的 job，改为干净 checkout 可
  离线复现的校验——桥 TypeScript 源解析（`node --experimental-strip-types --check`）+ 生成的仓库根
  client bundle 与 `client.js` 同步、根 `exports` 导出门禁。
- npm 可发布元数据：移除 `private:true`；补 `license: Apache-2.0`、`repository` / `homepage` /
  `bugs`、`files` 白名单（含 `bin/`、`src/`、`tools/`、`configs/`、`scripts/`、`docs/`、`online/`
  与 DSH 桥运行必需文件；排除 `models/`、构建产物与 `node_modules`）；修复 `description` 乱码为
  正确 UTF-8；保留 `engines`（Node ≥ 22.6）。未改动 `exports` 结构。
- README 定位统一为「冻结计划的浏览器自动化中间件 / 可验证的浏览器执行内核」，并补充
  `npx amber` 在 checkout 内会挂住、就地改用 `node --experimental-strip-types src/cli/main.ts` 的说明。
- 新增本 CHANGELOG；不创建 git tag（发布形态与 tag 由后续决定）。

### M0 凭据/产物安全（2026-10-31，未发布）

- `meta.secretSlots`：显式声明敏感槽位（加载期校验必须是已声明槽位）；`result`/`report`/`stdout`/dry JSON 中
  敏感槽位一律掩码为 `***`。名称启发（password/token/api_key/...）作为兜底，只对已声明槽位生效。
- 深扫兜底 `scrubSecrets`：敏感值被流程写进 `logs`/`step_traces`/trace 等其它字段时也会被抹掉；
  `--emit-trace` 写盘前同样脱敏。
- `--slot-file FILE`：从 JSON 对象读槽位，避免敏感值进 argv/进程列表；与 `--slot` 同名时 `--slot` 优先；
  文件对 group/other 可读会告警，建议 `chmod 600`。`--slot` 敏感键会告警。
- `tools/secret-scan.ts`：一次性 canary 扫 `result.json`/`report.md`/dry JSON/scrub 后的 result/trace，
  断言零命中；接入 `npm run check`（`npm run secret-scan`）。
- 本机配置写入后 chmod `0600`（Windows 无 POSIX 模式时忽略失败）；新增 `SECURITY.md` 写凭据模型、
  证据脱敏、信任边界、反爬/验证边界与已知缺口。

### 提示词系统补全（2026-10-31，未发布）

- 层 3 覆盖闭环：`STOPCODE_MEANING` 补 `max_steps` / `noul_unverified` / `no_progress` /
  `space_empty` / `nominated_family_empty|mismatch`；prompt-hit 改**双向**断言
  （STOP_NEXT ⊆ schema 且 schema ⊆ STOP_NEXT ∪ EXEMPT），并新增 executor `StopCode`
  union ↔ 契约/内部码边界（`EXECUTOR_ONLY_STOPCODES`，逐条理由）闭环——覆盖率不再只是
  对手写表的自我证明。
- 豁免收紧：`needs_human`、`frame_not_allowed`、`popup_not_allowed`、`manual_signal_not_held`、
  `action_unsupported`、`target_not_found`、`target_ambiguous`、`hint_matched_no_target`、
  `step_names_no_target` 晋升为可执行 next（STOP_NEXT 28 条 / EXEMPT 3 条）；
  **停手规则改为失败即输出**（stdout/report.md/report.html），不再依赖 next 是否存在。
- 层 1 真正进桥：`OVERVIEW_TEXT` 接进 `amberflow_status` 工具描述头部（prompt-hit 断言接线）；
  概述措辞修正为「模型只做选择/风险/完成票（完成票仅 advisory）」。
- 层 2 补全：`amber help --json`（无命令名）输出结构化命令清单；registry `when` 改由
  help-map 单源投影；`run` 帮助补 `--slot-file` / `--confirm-unsafe` 并修正 `--confirm-safe`
  语义描述；首页「下一步」改由 help-map `HOME_NEXT` 单源渲染。
- `amber schema ctx --check --topic <节>` 修复：快照按同 topic 切片比较（此前切片 vs
  全量必然 drift，为既有缺陷，本版修复）。
- 停手规则进 `docs/APP_SCRIPT_AUTHORING.md` 逐字块（prompt-hit doc 组断言）。

### M0 可用性（2026-10-31，未发布）

- **默认安全**：应用批量运行的 `confirmFn` 缺省从「一律放行」翻转为按干跑证据拒绝破坏性浏览器动作；
  `--confirm-unsafe` 或 `AMBERFLOW_CONFIRM_SAFE=0` 显式恢复旧行为。配置 schema 的默认值同步改为 `1`，
  示例配置重新生成。
- **HTML 证据报告 v0**：`amber run` 在 `-result.json` / `-report.md` 之外写 `-report.html`（结论、脱敏槽位、
  步骤/不变量/证据锚点；全部值经 HTML 转义），并打印落盘路径。
- `npm run check` 增加 `secret-scan`（凭据/敏感槽位产物零命中门）。
- 离线示例：`examples/apps/` 4 个零网络/零模型样板 + `tools/examples-check.ts`；`npm run examples-check`
  接入 `npm run check`，`examples/` 随 npm 包分发。


### 发布形态（M0 决定）

- **M0 决定：首次 npm 发布采用单包 `amberflow`**——`bin/` + 引擎 `src/`；DSH 集成继续走
  git-install（`dsh plugin add github:Johnly1986/AmberFlow`），不单独发 npm 包。
- 根 `exports` 暂保持指向 DSH 桥（兼容 git-install）；**首次发布不承诺** `import 'amberflow'`
  的引擎 API（消费面以 CLI 为准）。
- 拆分（`amberflow` 引擎包 + `@deepseek-ai/dsh-amberflow-bridge` 集成包）列为 v3 M1+ 工作项；
  拆分前需解决「bin 依赖 `--experimental-strip-types` 运行 `.ts`」与「`exports` 指向 `.ts`」两处
  对普通消费者不友好的形态。
- `npm run check` 在干净 checkout 上会先由 `precheck` 生成缺失的 `dist/schema/ctx.json`（构建产物）；
  快照已存在时 `schema:check` 仍做严格漂移比较。

## [1.0.0] - 2026-10-03

首个 TypeScript 单一技术栈可用版本（当时名 LayaWebUse）：冻结计划 + 本地决策模型执行，
验证依赖离线夹具 / 复刻测试页（`testpages/`、`tests/`、`bench/`）。已被 2.0.0 取代。

[2.0.0]: https://github.com/Johnly1986/AmberFlow/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Johnly1986/AmberFlow/releases/tag/v1.0.0

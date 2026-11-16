# P2 决策请求包（Readiness / 待项目方拍板）

> **状态**：**已批准，等待 ③ 收尾**（2026-11-17 回执：D1=A/D2=先完成/D3=#4→#2→#3/D4=接受建议）。P0/P1 已完成；P2 前置 ①②④⑤ 已满足，唯一剩余 ③ = INTERVENTION 默认切换（实现中）。
> **复核记录**：2026-11-17 连续 3 轮复核（goal round 4/5/6），①③④⑤ 事实均未变化；仓库保持 P0/P1 已交付 + 证据 lane 夜间运行，未启动任何 `run()`/编排改造。
> **目的**：把「缺什么」变成可勾选的决定，避免 P2 在缺少发布/改造窗口授权时动最高 churn 文件（`executor.ts` 6139 行、`app-runner.ts` 2854 行、`ctx.ts` 1799 行）。
> **依据**：`docs/IMPROVEMENT_PLAN.md` §0/§6.3、`docs/IMPROVEMENT_PLAN_REVIEW.md`（架构评审 B1/B5、红队 C2）、`docs/MAINLINE.md` §4 seam 冻结表、`docs/INTERVENTION_RESCUE_MODULE.md` §8。

---

## 0. 已经就绪的资产（不需要决策）

| 资产 | 证据 |
|---|---|
| 门禁基线 | `npm run check` 含 maintain 五组 / prompt-hit 九组 / examples golden / split-check / 用例校验；`maintain --self-test` 22 负向 + 7 正例 |
| 等价证据 lane | `examples-check` canonical golden（5 示例）、`split-check` 3 manifests（40+83+36 符号 hash）、`verify:offline` 4 夹具页（非门禁，夜间 job 已接入 `.github/workflows/checks.yml`） |
| 主线与 seam | `docs/MAINLINE.md`：依赖分层 L0–L6+L1.5、执行阶段 S0–S5、入口三类、seam 冻结表（`BrowserMiddleware.run` / RunOptions / buildMiddleware / DecisionProvider / prompt / Ctx / 结果包络 / 恢复链） |
| 规模基线 | >1000 行 6、≥300 行函数 6、mw 真实构造 1、`src/index.ts` importer 0；ratchet 只降不升 |
| 历史与注释 | CHANGELOG `## Decisions`（D1–D12）；注释禁止类 0；日期/批次/历史措辞 ratchet |
| P0/P1 提交 | `git log --oneline 2dc7a50..89a72d2`（P0 9 批 + P1 1.1–1.5 共 17 个提交） |

---

## 1. 前置事实（2026-11-17 复核）

| # | P2 条件 | 当前事实（证据） | 缺口 |
|---|---|---|---|
| ① | 2.0 发布/特性冻结决策已定 | `README.md:67,94`：「2.0.0 未发布，正在从可运行走向可交付」；无 freeze 决策记录 | 需要项目方选择发布窗口与是否冻结 |
| ② | 0.8 等价 lane 可重复 | ✅ 已满足（见 §0） | — |
| ③ | INTERVENTION 步 4/5 与默认切换完成 | `docs/INTERVENTION_RESCUE_MODULE.md:3`：实施中——步 0-3 + 步 5 桥半边已实施；步 4（texts 生成/schema/docs 接线）与默认切换未见完成记录 | 需排期/授权完成步 4/5，或书面豁免 P2 的此依赖 |
| ④ | BACKLOG #2/#3/#4 顺序决策 | `docs/BACKLOG.md`：#2 open（候选契约）、#3 open（窗口递增，依赖 #2）、#4 open（RunCtx+evidence collector，P1 裁定） | 需要确认顺序与是否允许 4d 先行 |
| ⑤ | 声明 freeze window | 未声明 | 需要起止日期 + 允许改动范围 + 停手规则 |

---

## 2. 需要拍板的四个决定

### D1 发布/冻结策略（单选）

| 选项 | 内容 | 代价/风险 | 建议 |
|---|---|---|---|
| **A（推荐）** | 先声明 **2 周 feature-freeze**（只接受 P2 重构 PR + 关键 bugfix + 证据 lane），期间完成 2.0 发布物料准备；P2 结束后再决定发布 | P2 会触碰最高 churn 文件，需要冻结窗口；2 周内功能迭代暂停 | ✅ 与评审 B1/B5、C2 的结论一致 |
| B | 先发 2.0，P2 延后到下个版本 | executor 仍会继续增长，未来拆分成本更高 | 可选，需接受技术债继续累积 |
| C | 无冻结直接做 P2 | 与评审结论冲突；拆分 PR 与功能批持续 rebase，最坏停在半拆状态 | ❌ 不建议 |

**需要回答**：选 A/B/C；若 A，freeze 起止日期与允许改动范围（建议：`src/engine/executor.ts`、`src/app/app-runner.ts`、`src/app/ctx*.ts` 只接受 P2 批次与关键 bugfix；其它目录正常开发）。

### D2 INTERVENTION 收尾（工程排期）

- 剩余：步 4（texts 生成接线：`prompt-hit --fix`、schema 快照、`MANUAL_STEPS_AND_PACE.md`/`AGENT_INTERFACE.md`/CHANGELOG）与步 5 默认切换（桥 schema 扩 `rescue` 键等）。
- P2 的 W1-c 以「步 4/5 完成」为前置（`docs/MAINLINE.md` §4.1 文件预留）。
- **需要回答**：P2 前完成步 4/5（推荐），还是接受 P2 的 `run()` 拆分与 INTERVENTION 文件区互斥的书面豁免？若选前者，请给排期窗口。

### D3 BACKLOG #2/#3/#4 顺序（单选）

| 顺序 | 理由 | 风险 |
|---|---|---|
| **#4 → #2 → #3（推荐）** | #4（RunCtx+evidence collector → 4c/4d）是 W1-c 前置；#4 的 4d 与 #2 改同一段 `run()`，先 4d 可避免二次冲突；#2 候选契约独立文件面；#3 依赖 #2 契约 | 需先投入 #4 的 2.0 批次（3–5 天） |
| #2 → #4 → #3 | 候选契约更急时；但 4d 要在 #2 落地后重排，W1-c 延后 | 两次动 `run()` 同一段，冲突成本高 |
| #3 先 | 与 #2 契约依赖矛盾，不建议 | — |

**需要回答**：顺序；是否允许 4d 先行（与 #2 排他）。

### D4 freeze window 参数（建议值，可改）

- 建议每个 4d 阶段一个 **3 个工作日**窗口（共约 6–8 个窗口内的批次），窗口内 `executor.ts`/`ctx*.ts`/`app-runner.ts` 只接受 P2 PR 与关键 bugfix。
- 停手触发器（方案 §5.3）：T1 冲突 ≥3 次/周或 PR >5 工作日 → 停该批改机会主义；T2 门禁误报 ≥3 次 → 降 warn；T3 任一未声明行为差异 → 回滚并冻结后续批次。
- **需要回答**：是否接受建议值；若否给参数。

---

## 3. 若批准，P2 首批执行清单（避免二次确认）

1. **2.0 RunCtx + evidence collector**（BACKLOG #4 前置；3–5 天，单 PR 可回滚）：四组记账闭包收敛为 run context 对象；evidence collector 收行锚/帧/DRF 证据为单点。
2. **2.1 run() 九阶段**（`runSetup` / `runFrameGate` / `runPoolGate` / `runDeclaredTargets` / `runModelPick` / `runActionPhase` / `runPostAction` / `reportTail`），每阶段独立提交；携带 StateCursor、钩子顺序不变；阶段函数 ≤400 行例外入 baseline。
3. **2.2 `runExecution` 内核 + 三个源适配器 + 套件聚合器**（flow/plan/suite-case），ctx 行为矩阵 + `tools/ctx-conformance.ts`。
4. **2.3 公共面清理**（index internal、extension 删除、picker deprecated、exports 锁定）+ 站点知识出引擎 + 扩展演练（5 项）。
5. 每批：`npm run check` + examples golden + split-check 必绿；运行期批次额外跑 `verify:offline` 与一个 core case trace 对比（有网络/模型时）。

**预计**：P2 12–20 人日（条件启动；按评审重估）；若 D1 选 B 则 P2 暂缓。

---

## 4. 决策回执（项目方填写）

| 决定 | 选择 | 日期/参数 |
|---|---|---|
| D1 发布/冻结 | ☑ A（2026-11-17） | freeze：2026-11-17 起 2 周；范围：executor/ctx/app-runner 只收 P2 PR + 关键 bugfix + 证据 lane |
| D2 INTERVENTION 收尾 | ☑ P2 前完成 | 剩余 = 步 2 默认切换（`--rescue` 真实 result.rescue 生产路径）；首批实现中 |
| D3 BACKLOG 顺序 | ☑ #4→#2→#3 | 4d 先行：☑ 是 |
| D4 freeze window 参数 | ☑ 接受建议 | 每阶段约 3 个工作日；整体 2 周 |

> 未收到回执时：P2 保持关闭，仓库继续 P0/P1 已交付状态 + 证据 lane 夜间运行；不启动任何 `run()`/编排改造。

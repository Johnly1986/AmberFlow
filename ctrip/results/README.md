# ctrip/results 目录说明

| 文件 | 是什么 | 怎么产生 |
|---|---|---|
| `CTRIP_RESULT.md` | **正式结果报告**：机票五天最低价表 + 出发当日 ≤¥300 酒店表 + 判分明细 | `node --experimental-strip-types src/ctrip-task.ts` |
| `ctrip_records.json` | 原始记录（站点账本）+ 独立判分 + 逐步 trace + 审计结论 | 同上 |
| `live_probe.json` | 携程线上可达性实测（每个 URL × 三种客户端 × 真浏览器；含重复请求序列与结论字段） | `node --experimental-strip-types src/live-probe.ts` |
| `ablation-nohints/` | **消融**：去掉全部 `target_hint`，每步交给 laya 选 → 第 1 个子目标即 BLOCKED（conf 0.13 < 0.25），0/7 | `src/ctrip-task.ts --no-hints --out ctrip/results/ablation-nohints` |
| `ablation-nohints-route/` | **消融**：同上 + `laya.Router` 逐页选 checkpoint（正确判成 multilingual）→ conf 0.24，仍 < 0.25，0/7 | `src/ctrip-task.ts --no-hints --route --out ctrip/results/ablation-nohints-route` |

两个消融目录里的 `CTRIP_RESULT.md` 是**失败**记录（表是空的、判定为 ❌），故意保留：
它们和正式结果一起构成"hint 在中文页面上是承重结构"这条结论的证据，别当成正式产物。

> 上表的命令是本仓库当前的 TS 入口；这些产物的**原始记录**（Python 版命令与输出）保存在历史 bundle 里，见 [BACKUP.md](../../BACKUP.md)。

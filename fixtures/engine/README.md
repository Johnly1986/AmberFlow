# fixtures/engine — 引擎 CI fixture 页面集

引擎侧验收断言的本地确定性资产（评审决议：活站点不可作自动回归）。全部为**零依赖静态页面**：
无滚动漂移、无懒加载（F3 除外——懒加载正是被测对象）、无网络请求、hydration 零漂移，
保证"同一页面状态"可复现。

## 页面清单

| 页面 | 服务批次 | 断言锚点 |
|---|---|---|
| `ambiguity-order.html` (F1) | 批次一 E2 | 12 个视觉/文案/类名完全相同的「订票」按钮（`class="btn btn-book"`，无 id/aria，`data-marker="slot-1..12"` 仅供断言取值）。同 hint 连续 ≥3 次 act（`on_ambiguous:"act"`）全部命中 `slot-1`（DOM 序首个）。 |
| `filter-bar.html` (F2) | 批次二 E1-c / 批次三 E1-b | 复刻携程结构：≈30 个无 id 导航壳按钮 + class-only 筛选栏（`li#filter_item_airline` 等，无 role 有 id）+ 12 个 class-only 订票按钮。`#filter_item_airline` 可作为 act hint 命中；壳元素不因配额调整被逐出池。 |
| `lazy-list.html` (F3) | 批次二 E5 | 初始 7 行，滚动到底每次追加 1 行至 12 行停止（`?infinite=1` 恒可追加）。初始态 `css_count_equals(.lazy-row, 7)`；收敛后断 12 且 `scroll_settled=true`；infinite 模式 `scroll_settled` 恒 false。 |
| `overlay.html` (F4) | 批次二 E4 | 打开 2.5s 后弹全屏遮罩（role=dialog，label「温馨提示」，关闭按钮「我知道了」），覆盖待点击按钮。被遮点击 → act 失败且错误证据含 `overlay_detected/overlay_label/overlay_dismiss_hint`；`?overlay=0` = 无遮罩对照（成功路径错误证据无 overlay 字段）。 |
| `upload.html` (L1) | 运行期等价 lane | 单个可见 `input[type=file]`：`op:"upload"` 的 `setInputFiles` 分支（证据：files 数/MIME；不记路径）。 |
| `scroll.html` (L2) | 运行期等价 lane | 锁定几何容器 `#scroller`（120/400 ⇒ max scrollTop 280）+ 底部按钮 `#deep-btn`：`op:"scroll" to:"bottom"` 容器滚动与 moved/delta 几何证据。 |
| `range.html` (L3) | 运行期等价 lane | `input[type=range]`（fill 族）：`op:"fill"` 现有执行路径写值 70；值事实读回。 |
| `pool-dedup/dup-parent-label.html` | 一区域一候选 | 父子同 label 两形态：默认留父剔子（region-a 的 button 让位，why=label-dup）；监听章在子 → 留子剔父（region-b 的 div 让位，why=listener-child）。 |
| `pool-dedup/deco-child.html` | 一区域一候选 | 自绘按钮 div 与文本 span 同盒同文案、双方带监听章 → 留父剔子（why=label-dup）。 |
| `pool-dedup/empty-child.html` | 一区域一候选 | 页签 li 与空 label 图标 i → 剔子留父（why=empty-child）；i 必须有非零盒（可见性过滤在前）。 |
| `pool-dedup/card-independent.html` | 一区域一候选 | 卡片与卡内独立按钮 label 不同 = 不同操作，两者都留（误杀守卫）；ref 序 = DOM 先序。 |
| `pool-dedup/long-list-64.html` | 池容量 | 61 控件全在首屏网格：64 帽全入池、item-50 可达（40 帧下被挤出窗口）。 |

## 通用验收纪律

- 每个断言 = fixture + 确定性重放（同一页面状态重复 ≥3 次结果一致）。
- 真实携程页面仅作一次性人工走查（验收演示），不进自动回归；如纳入巡检按 live-tier 管理
  （blocked/unreachable 不计失败）。
- 运行产物不提交仓库。

## 非门禁定位（唯一消费方：`tools/verify-offline.ts`）

`fixtures/engine/` 是**等价验证**资产，不是测试套件，**不进 `npm run check`**：

- 只服务非门禁等价 lane：`tools/verify-offline.ts`（抽取面）与 `tools/verify-runtime-offline.ts`（运行期面；本地/定时跑，需要 chromium；PR 门禁保持纯离线、不启浏览器）。
- 页面必须保持**零外部网络请求**：verify-offline 会把任何外部请求判红，并把空清单写入基线。
- 基线在 `tools/golden/offline/**`：默认比对，`--record` 显式更新；随机端口已归一为 `<LOCAL>`。
- 观测口径（确定性、与时机无关）：title / 元素计数 / 文本前缀 + 引擎元素池的稳定字段
  （ref/scan/tag/label/role/id/data_test/href）+ 代表性 hint 的候选计数、档位、裁决。
- `lazy-list` 只记录「加载后自稳定」的行数（滚动收敛计数受行高/视口像素差异影响，
  跨机器会假红，故不纳入基线）；`overlay` 记录遮罩出现态与 `?overlay=0` 对照态。
- 页面/引擎行为变化导致基线不一致时：先确认是预期变更，再 `--record` 更新，并在 PR 说明。
- AGENTS.md「仓库是什么」的离线夹具表述以本节为准（非门禁、仅等价验证）。

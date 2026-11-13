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

## 通用验收纪律

- 每个断言 = fixture + 确定性重放（同一页面状态重复 ≥3 次结果一致）。
- 真实携程页面仅作一次性人工走查（验收演示），不进自动回归；如纳入巡检按 live-tier 管理
  （blocked/unreachable 不计失败）。
- 运行产物不提交仓库。

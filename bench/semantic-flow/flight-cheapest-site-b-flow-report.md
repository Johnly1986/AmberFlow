# 语义流运行报告：flight-cheapest @ site-b（Fareport 复刻站 B（data-test + 英文，不同页名/结构））

- 目标：订{date_label} {from}到{to}价格最低的机票
- 决策面：laya=scripted ｜ escalate=scripted
- 结果：**通过** ｜ 步骤 5/5 ｜ 用时 1.7s
- 解析级：rule 4 · laya 0 · escalate 0 (written back 0) · list 1 · blocked 0
- 站点档案：`/root/coding/AmberFlow/sites/site-b.profile.json`

| # | 语义步 | 级 | 状态 | 解析方法 | 尝试 | 已学hint | 回填 | 障碍 |
|---|---|---|---|---|---|---|---|---|
| 0 | 进入机票预订频道 | browser | done | rule:match | 1 | ✓ | - | - |
| 1 | 在出发地填入昆明、到达地填入北京，然后点击搜索 | browser | done | rule:match | 1 | ✓ | - | - |
| 2 | 选择出发日期5月18日 | browser | done | rule:match | 1 | - | - | - |
| 3 | 判断最低价机票并选中最低价的航班 | list | done | list | 1 | - | - | - |
| 4 | 点击购买提交订单 | browser | done | rule:match | 1 | ✓ | - | - |

<details><summary>list_step 细节（抽取列与选中行）</summary>

- pick-cheapest: {"rows":5,"op":"min","by":"price","chosen":{"price":"980 CNY","flight":"F3"},"chosen_index":2,"values":[1280,1150,980,1330,1060],"settled_after":"120ms"}

</details>

## 验收（结束状态不变量）

| 不变量 | 结论 |
|---|---|
| {"all_of":[{"url_contains":"fare-done.html"},{"url_contains":"order="}]} | 成立 |

# 线上应用验收：`apps/qunar-live`（2026-10-04，真网络 + 真模型）

```bash
npm run apps -- --app qunar-live --out /tmp/a7-qunar3
```

## 原始观测

```text
  step 1: click div "北京" (clicked, rule:match, conf=1.00)
  step 1: click button "搜索" (clicked, rule:match, conf=1.00)
- 结果：**通过** ｜ 步骤 2/2 ｜ 用时 46.5s
| 0 | 打开出发城市选择器 | done | 1 | - |
| 1 | 点击搜索，跳转航班列表页 | done | 1 | - |
```

exit code = **0**；两步都 `rule:match`，用时 46.5 s。

## 这道题暴露的 schema 缺口（已修）

同一份计划在**桌面**上下文里三次尝试全部失败：

```text
| 0 | 打开出发城市选择器 | blocked | 3 | low confidence 0.15 < floor 0.25 on step 1 |
```

原因不是"站点变了"：`touch.qunar.com` 是**手机版页面**，桌面 UA/视口下 DOM 不同，计划点名的 `div "北京"`
根本不在元素池里 —— hint 落空，laya 在中文页面上又只有 0.15（CLAUDE.md 记录的 CJK 塌陷）。
修法是把"设备面"变成**声明**（`apps/qunar-live/pack.json` 的 `device`：iPhone UA + 390×844 + touch +
locale/timezone/DPR），`browserSession(headless, device)` 会为它开一个带这些参数的上下文。
声明后同一份计划 **2/2 一次命中**（`click div "北京" (clicked, rule:match, conf=1.00)`）。

结论：应用包必须能表达"这个站点只有手机版"——设备是站点知识，不是运行参数。

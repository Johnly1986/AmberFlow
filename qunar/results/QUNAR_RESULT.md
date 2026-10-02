# qunar 迁移测试结果

- 目标：`touch.qunar.com/h5/flight/`（真实站点）· 判分 **4/4**
- 首页：首次加载 13 个可交互元素（probe.json，执行器 criteria 视图正常）；末次加载降级为 3 个（反爬降级，见判分明细第 4 行）

## 判分明细

| 检查项 | 期望 | 记录 | 判定 |
|---|---|---|---|
| 首次加载的表单可交互（执行器按规则命中计划点名目标 div 北京） | 子目标1 done 且 method=rule:* | done=True methods=['rule:match'] | ✅ |
| 交互：出发城市选择器被打开（URL hash 信号） | url_contains #cityselect | https://touch.qunar.com/h5/flight/#cityselect | ✅ |
| 动作：搜索跳转列表页（URL 信号，SPA 自建请求） | url_contains ncs/page/flightlist?depCity= | https://touch.qunar.com/ncs/page/flightlist?depCity=%E5%8C%97%E4%BA%AC&arrCity=% | ✅ |
| 边界：列表数据门如实复现（touchInnerList 1999；末次加载表单降级为 3 元素） | 1999/没有查询到符合条件的航班 | api_seen=1 banner=True | ✅ |

## 实测边界（数据腿，非用例失败而是环境约束）

- `touchInnerList` 对自动化浏览器一律 `code:1999`（北京→上海也拒，有头/无头同判）；
- 请求体带 SPA 自产 Bella token 仍被拒——`chloroFp` 指纹 SDK 在自动化 chromium 里 CORS 失败；
- 城市选择器建议列表不出现（同族 SDK 失败）→ 改城市不可自动化；
- 与 ctrip 线上站的 432（出口 IP 门）同型：**流程骨架可迁移，数据腿被客户端指纹门拦住**。

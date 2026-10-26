# 线上测试用例

`online/` 是仓库唯一的测试声明层。它不包含离线夹具、复刻站或冻结结果；每个 case 直接指向真实 `http(s)` 页面。

## 层级

| tier | 用途 | 是否门禁 |
|---|---|---|
| `smoke` | 单页可达 + 关键地标 | 是（手动/定时） |
| `core` | 2–6 步短流程 | 是（手动/定时） |
| `deep` | 有状态长流程 | 是（较慢，按需） |
| `probe` | 风控/可达性观测 | 否；只记录 `blocked` / `unreachable` / `login_required` / `captured` |

## 文件

```
online/sites/<site>.json          # hosts / home / locale / device / 风控与登录标记
online/cases/<tier>/<case>.json   # 用例
```

## Case 字段

```jsonc
{
  "id": "books-next-page",
  "site": "books",
  "tier": "core",
  "goal": "从首页打开目录第二页",
  "start_url": "https://books.toscrape.com/",
  "timeout_ms": 60000,
  "model": "english",                // 可选；本地模式用，线上 provider 由配置决定
  "slots": {},
  "subgoals": [
    {
      "desc": "点击 next",
      "start_url": "https://books.toscrape.com/",
      "target_hint": "next",
      "signal": { "url_contains": "page-2.html" },
      "retries": 2
    }
  ],
  "invariants": [
    { "id": "second-page", "desc": "停在第二页", "signal": { "url_contains": "page-2.html" } }
  ],
  "oracle": { "kind": "css_count", "selector": "article.product_pod", "min": 1 }
}
```

- `start_url` 只能是 `http(s)://`；主机必须在 site 的 `hosts` 里。`file://`、旧夹具路径会被拒绝。
- 日期：`{{today}}`、`{{today+7d}}`、`{{next_monday}}`。
- 凭据：`{{env:NAME}}` 或 `{{env:NAME|default}}`；不要写明文。
- `target_hint` / `target_hints` 是站点特定测试的一部分，允许使用。
- 非 probe 至少一条结束态 `invariant`；`oracle` 是可选的独立检查（`css_count` / `text_order` / `text_set` / `attr_equals` / `url_contains`）。

## 运行

```bash
npm run online:validate
npm run online -- --tier smoke
npm run online -- --tier core
npm run online -- --tier deep
npm run online -- --tier probe
npm run online -- --case books-next-page --headed
```
undefined用 JSON，不要解析人类可读表格：

```bash
npm run online -- --validate --json
npm run online -- --list --json --tier all
npm run online -- --tier smoke --json
```

`--list --json` 返回 `{ tier, cases: [{ id, site, tier, goal, tags }] }`；
`--validate --json` 返回 `{ ok, sites, cases, valid }`；`--tier … --json` 返回 suite 摘要与 `evidence_dir`。
证据写 `$AMBERFLOW_HOME/online-runs/<run-id>/` 或 `--out`；不要提交。退出码 `0/1/2/3`，跳过不等于通过。

## 站点选择

优先公开、无需登录/支付、结构稳定的站点。需要登录的演示站使用公开 demo 账号；真实账号只允许通过环境变量注入。遇到风控/验证码按 `blocked` 记录并停止，不绕过。

## 新增一个 case

1. 在 `online/sites/` 声明主机与页面标记。
2. 在对应 tier 写 case，先 `npm run online:validate`。
3. 先跑 `--case <id> --headed` 确认动作与信号；再跑两次确认稳定。
4. 失败时看 `cases/<id>-failure.png` / `.html`，修 selector/signal，不添加 golden 快照。

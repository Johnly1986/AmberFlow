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
  "id": "books-category",
  "site": "books",
  "tier": "core",
  "goal": "从 Books to Scrape 首页打开 Travel 分类",
  "start_url": "https://books.toscrape.com/",
  "subgoals": [
    {
      "desc": "点击 Travel 分类链接",
      "start_url": "https://books.toscrape.com/",
      "target_hint": "a[href~travel_2]",
      "signal": { "url_contains": "travel_2" },
      "retries": 2
    }
  ],
  "invariants": [
    {
      "id": "category-page",
      "desc": "分类页标题是 Travel 且仍有商品",
      "signal": {
        "all_of": [
          { "css_text_contains": ["h1", "Travel"] },
          { "css_exists": "article.product_pod" }
        ]
      }
    }
  ]
}
```

可选字段（上面示例未用到的）：`timeout_ms` / `model` / `slots` / `oracle` / `expect`。

- `start_url` 只能是 `http(s)://`；主机必须在 site 的 `hosts` 里。`file://`、旧夹具路径会被拒绝。
- 日期：`{{today}}`、`{{today+7d}}`、`{{next_monday}}`。
- 凭据：`{{env:NAME}}` 或 `{{env:NAME|default}}`；不要写明文。
- `target_hint` / `target_hints` 是站点特定测试的一部分，允许使用。
- 非 probe 至少一条结束态 `invariant`；`oracle` 是可选的独立检查（`css_count` / `text_order` / `text_set` / `attr_equals` / `url_contains`）。

## 运行

```bash
npm run test:validate                  # 离线校验全部 site/case（PR 门禁）
npm run test -- --tier smoke           # 快速可达性
npm run test -- --tier core            # 短流程
npm run test -- --tier deep            # 长流程
npm run test -- --tier probe           # 探针，非门禁
npm run test -- --case books-category --headful
npm run test -- --list
```

机器可读输出用 `--json`，不要解析人类可读表格：

```bash
npm run test -- --validate --json
npm run test -- --list --json --tier all
npm run test -- --tier smoke --json
```

`--list --json` 返回 `{ tier, cases: [{ id, site, tier, goal, tags }] }`；
`--validate --json` 返回 `{ ok, sites, cases, valid }`；`--tier … --json` 返回 suite 摘要与 `evidence_dir`。
证据写 `$AMBERFLOW_HOME/online-runs/<run-id>/` 或 `--out`；不要提交。退出码 `0/1/2/3`，跳过不等于通过。

## 站点选择

优先公开、无需登录/支付、结构稳定的站点。需要登录的演示站使用公开 demo 账号；真实账号只允许通过环境变量注入。遇到风控/验证码按 `blocked` 记录并停止，不绕过。

## 新增一个 case

1. 在 `online/sites/` 声明主机与页面标记。
2. 在对应 tier 写 case，先 `npm run test:validate`。
3. 先跑 `--case <id> --headful` 确认动作与信号；再跑两次确认稳定。
4. 失败时看 `cases/<id>-failure.png` / `.html`，修 selector/signal，不添加 golden 快照。

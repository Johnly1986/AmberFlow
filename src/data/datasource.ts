/**
 * 数据源引擎 — `datasource.py` 的 TypeScript 逐语义移植。
 *
 * 把"从站点取数"变成**配置**（`<site>/sources/*.json`）而不是脚本：URL 模板、
 * 日期参数怎么算、从哪取行、每个字段的路径与算子、时间窗、选优规则、报告列与
 * 说明，全部是配置。引擎自己**不认识任何站点**（离线自检：读本文件源码、
 * 剥掉块注释后 grep 站点词应无命中）。
 *
 * 结构（与 Python 版一一对应）：
 *   - 传输：`curl` 走子进程、`httpx` 走 Node 18+ 全局 fetch；
 *   - 路径语言 `resolve`：`a.b` / `[0]` / `[-1]` / `[]`（对列表逐项继续）；
 *   - 七算子 `applyOps`：`time|join:<sep>|len|len-1|int|str|strip`；
 *   - 两个抽取器：`jsonInScript`（HTML 里的 `var/window.X = {...}`）与
 *     `htmlRegex`（`split` 分组 + 每字段单捕获组）；
 *   - 日期表达式 `date|day_offset|weekday_cn`、`date±Nday`、`nextWeekDates`、
 *     `defaultDates`；`urlFor` / `fetchSource` / `blocked`；
 *   - `inWindow` / `matches` / `selectBest` / `countRows` / `auditRows`；
 *   - `reportMarkdown` / `runSource` / `main`(CLI)。
 *
 * ## 为什么 curl 仍然是子进程（不换成 fetch/浏览器）
 *
 * m.ctrip.com 的 WhaleGuard 按**客户端指纹**打分，实测同一 URL：
 * curl（默认 UA）200、curl+iPhone UA 200、curl+Chrome UA 432、httpx 432、
 * Chromium / Playwright `context.request` 432。所以"能取到页面"这件事恰好只
 * 发生在 curl 的默认指纹上 —— 这是站点事实，但**传输实现本身是通用的**：
 * 引擎只知道"有一种客户端叫 curl"。`httpx` 那一档在 Node 里就是全局 fetch
 * （Python 版是 `httpx.get(..., follow_redirects=True)`，Node fetch 默认跟随重定向）。
 *
 * ## 与 Python 的有意偏差（详见 parity 报告）
 *
 * 1. 仓库根由 `support/paths.ts` 向上查找 package.json 得出（Python 的 `HERE` 就是仓库根）。
 *    两者都用"发现制"扫描仓库根下每个站点目录里的 sources 子目录，语义相同。
 * 2. ESM 里 `import.meta.url` 一定是绝对路径，所以 `_path` / `listSources` 路径是绝对
 *    路径；Python 用 `python3 datasource.py` 调用时给的是相对路径。语料生成器把两边的
 *    `_path` 都固定成仓库相对串，避免路径形态污染对拍。
 * 3. `JSON.parse` 不接受 `NaN` / `Infinity` 字面量，而 Python `json.loads` 接受。
 *    真实 fixture 不含这两者。
 * 4. JS number 不区分 int/float：`str(1.0)` 在 Python 是 `"1.0"`、在这里是 `"1"`；
 *    超过 2^53 的整数也会掉精度。配置里的字段都是字符串或小整数，不受影响。
 * 5. Python `\d`/`\w`/`\s` 默认匹配 Unicode；JS 正则的 `\d` 只匹配 ASCII 数字，
 *    `\s` 集合略有差异。配置文件里的正则都只用 `\d` 匹配 ASCII 数字。
 * 6. `str.format` 只实现了 `{name}`、`{name!r}`、`{name!s}` 与 `{{`/`}}` 转义；
 *    位置参数、属性/下标访问与 `:format_spec` 未实现（配置模板未用到）。
 * 7. Python `re.escape` 与本地 `escapeRegExp` 转义集合不同（都保证字面量语义）。
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./source-validate.ts";
/* 实现按稳定纯区拆分（公共导出面与调用点不变）：types.ts / transport.ts / extract-ops.ts /
   source-validate.ts。本文件只保留文件头、既有 re-export 与 CLI 直跑入口，并显式 re-export 原符号。 */
export { ValueError, FileNotFoundError, KeyError } from "./types.ts";
export type { Row, Source, Page, Rendered, DateEntry, RunResult, Client, CliObservation, DateLike, RunOptions } from "./types.ts";
export { curlGet, httpxGet, CLI_KEYS, cliBinOf, cliRunDetailed, cliRun, cliVersion, checkVersion, CLIENTS, TRANSPORTS, transportClient, fetchSource, blocked } from "./transport.ts";
export { resolve, EXTRACT_KINDS, OPS, DATE_EXPRS, applyOps, fieldValue, rowOf, EXTRACTORS, extract, todayIso, dateExpr, dateParams, nextWeekDates, parseDatesValue, defaultDatesSlotNames, defaultDates, urlFor, inWindow, matches, selectIndex, selectBest, auditRows, countRows } from "./extract-ops.ts";
export { sourceDirs, renderAndSnapshot, loadSource, listSources, countGroups, validateSource, runSource, main } from "./source-validate.ts";

// py 语义小工具（pyStr/pyTruthy/getOr/pyCompareTuple/pyJsonDumpsIndent 等）已收敛到
// support/pystr.ts（F7）；这里 re-export 维持既有导出面不变（`export * as datasource` 的
// 外部消费方零改动）。datasource 本体继续 import 同一份实现。
export {
  pyJsonDumps, pyJsonDumpsIndent, pyTruthy, pyStr, pyRepr, strOrEmpty, pyInt, pyLen,
  pyStrCmp, pyCompareTuple, hasOwn, getOr,
} from "../support/pystr.ts";
// 报告视图区（PreviewTable/previewTable/reportMarkdown）拆到 report-view.ts（F7）；
// 这里 re-export 维持既有导出面不变（index.ts `export * as datasource` 与既有调用方零改动）。
export { previewTable, reportMarkdown, type PreviewTable } from "./report-view.ts";

/* 直接 `node --experimental-strip-types src/data/datasource.ts --list` 时执行。 */
const ARGV1 = process.argv[1];

if (ARGV1 && fileURLToPath(import.meta.url) === path.resolve(ARGV1)) {
  main().then((code) => { process.exitCode = code; });
}

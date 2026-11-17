/**
 * 数据腿的公共类型与三个语义错误（ValueError/FileNotFoundError/KeyError）。
 *
 * 叶子模块：不 import 引擎/应用层，供 transport / extract-ops / source-validate 共用。
 */

/* ---------------------------------------------------------------- 类型 */

export type Row = Record<string, unknown>;

/**
 * 一份数据源配置（`<site>/sources/<name>.json`），加 `_path`。
 *
 * **字段映射属于配置，不属于机制**（数据/报表引擎不认具体业务字段）：
 *   - `selects[].sort_by`        排序键；未配 = 不排序、取第一行（通用回退）
 *   - `selects[].value_field`    报告加粗/主值字段；缺省 = `sort_by[0]`
 *   - `selects[].value_fields`   槽位回写主值候选顺序；缺省 = `value_field` / `sort_by`
 *   - `selects[].detail_fields`  跨日期结论的描述字段顺序；缺省 = []（不渲染描述）
 *   - `report.value_fields`      报告行标识列候选顺序；缺省 = 行内首个非空标量
 *   - `report.currency_field`    加货币前缀的字段；缺省不加上缀
 *   - `report.detail_fallback_fields` 跨日期结论标识回退链；缺省 = 通用回退
 *   - `filters.time_field`       报告时间列字段；未配 = 不渲染
 *   - `report.preview.columns`   报告预览列（既有字段，保持不变）
 */
export interface Source {
  name?: string;
  label?: string;
  transport?: Record<string, any>;
  constants?: Record<string, any>;
  default_dates?: unknown;
  date?: { params?: Record<string, any> };
  extract?: Record<string, any>;
  filters?: Record<string, any>;
  counts?: Array<Record<string, any>>;
  audits?: Array<Record<string, any>>;
  selects?: Array<Record<string, any>>;
  report?: Record<string, any>;
  _path?: string;
  [k: string]: unknown;
}

/** 抽取结果：日期、可点日期条、行。 */
export interface Page {
  date: unknown;
  strip: unknown;
  rows: Row[];
}

export interface Rendered {
  elements: number;
  snapshot: string;
  text?: string;
  title: string;
}

export interface DateEntry {
  url: string;
  page_date?: unknown;
  strip?: unknown;
  rows?: Row[];
  counts?: Record<string, number>;
  audits?: Record<string, number>;
  selects?: Record<string, Row | null>;
  error?: string;
}

export interface RunResult {
  source: unknown;
  fetched_at: string;
  dates: Record<string, DateEntry>;
  rendered: Record<string, unknown>;
  /** 只在配了 `transport.version_pin` 时出现：实测工具版本（curl/httpx 那一档不带）。 */
  tool_version?: string;
}

/* ---------------------------------------------------------------- 错误（对齐 Python 异常类型） */

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/* ---------------------------------------------------------------- 传输 */

export type Client = (url: string, timeout?: number, source?: Source) => Promise<[number, string]>;

/* ------------------------------------------------- 传输：命令行工具（cli） */

/**
 * 一次命令行调用的完整观察结果 —— 动作腿（`tools`）的完成信号就长在这个形状上：
 * 退出码、stdout/stderr（分开，才分得清"报错"和"结果"）、实际 argv（审计用）、cwd。
 */
export interface CliObservation {
  code: number;
  /** 退出码是否在 `transport.cli.exit_ok` 里 */
  ok: boolean;
  stdout: string;
  stderr: string;
  argv: string[];
  cwd: string;
  exit_ok: number[];
}

/* ---------------------------------------------------------------- 日期与 URL */

export type DateLike = string | Date;

export interface RunOptions {
  today?: DateLike | null;
  saveRaw?: string | null;
  render?: boolean;
  verbose?: boolean;
}

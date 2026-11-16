/**
 * 数据腿传输层：curl 子进程 / httpx(全局 fetch) / cli 三类取数客户端，以及按声明挑客户端。
 *
 * 站点知识只在配置里；本模块只知道"客户端名"和"HTTP 结果码/正文"的形状。
 */
import { spawnSync } from "node:child_process";
import { REPO } from "../support/paths.ts";
import * as path from "node:path";
import { pyTruthy, pyStr, pyRepr, hasOwn, isDict } from "../support/pystr.ts";
import { ValueError, KeyError } from "./types.ts";
import type { Source, CliObservation, Client } from "./types.ts";

/**
 * 用 curl 子进程取页面。
 *
 * **不要换成 fetch/浏览器**：WhaleGuard 按客户端指纹打分，实测同一 URL ——
 * curl（默认 UA）200、curl+iPhone UA 200、curl+Chrome UA 432、httpx 432、
 * Chromium / Playwright `context.request` 432。传输实现本身是通用的：引擎只知道
 * "有一种客户端叫 curl"，为什么必须是它写在注释里，而不是写进代码分支。
 */
export async function curlGet(url: string, timeout = 60.0): Promise<[number, string]> {
  const res = spawnSync(
    "curl",
    ["-s", "-o", "-", "-w", "\n%{http_code}", "--max-time", String(Math.trunc(timeout)), url],
    { encoding: "utf8", maxBuffer: 1 << 28, timeout: (timeout + 10) * 1000 },
  );
  if (res.error) throw res.error;                  // 对应 Python TimeoutExpired / FileNotFoundError
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  // Python: body, _, code = stdout.rpartition("\n")
  const idx = stdout.lastIndexOf("\n");
  const body = idx === -1 ? "" : stdout.slice(0, idx);
  const codeStr = idx === -1 ? stdout : stdout.slice(idx + 1);
  const code = codeStr === "" ? 0 : Number(codeStr);
  if (!Number.isFinite(code) || !Number.isInteger(code)) {
    throw new ValueError(`invalid literal for int() with base 10: ${pyRepr(codeStr)}`);
  }
  return [code, body];
}

/** httpx 那一档在 Node 里就是全局 fetch（默认跟随重定向）。 */
export async function httpxGet(url: string, timeout = 60.0): Promise<[number, string]> {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeout * 1000) });
  return [r.status, await r.text()];
}

/** `transport.cli` 允许的键；未知键在加载期就报错（不是静默忽略）。 */
export const CLI_KEYS = ["bin", "argv", "env_allow", "cwd", "exit_ok", "stdin"] as const;

/** `transport.cli.bin`：只用于日志/报告，不跑进程。 */
export function cliBinOf(source: Source): string {
  const tr = (source["transport"] as Record<string, any> | undefined) || {};
  const spec = tr["cli"];
  return isDict(spec) ? pyStr((spec as Record<string, any>)["bin"]) : "";
}

function cliSpec(source?: Source): Record<string, any> {
  const tr = ((source ?? {})["transport"] as Record<string, any> | undefined) || {};
  const spec = tr["cli"];
  if (!isDict(spec)) {
    throw new ValueError("transport.cli is required for client 'cli' (bin + argv)");
  }
  return spec as Record<string, any>;
}

/** argv 里能用的占位符：`{url}`（引擎已按日期参数拼好的目标）与配置里的 `constants`。 */
function cliParams(source: Source | undefined, url: string): Record<string, unknown> {
  return { ...(((source ?? {})["constants"] as Record<string, unknown>) || {}), url };
}

/**
 * argv 的占位符替换：**只替换已知键，其余花括号原样保留**。
 *
 * 为什么不直接用 `pyFormat`（url_template 用的那个 Python `.format` 口径）：工具参数里
 * 到处是花括号——`jq '[.cases[] | {id: .id}]'`、`--data '{"a":1}'`、模板字符串——严格口径
 * 会把它们当成缺失的格式字段并报 MissingKey。url_template 继续用严格口径（缺参数要响亮
 * 报错，且有对拍语料钉着），argv 用这条宽松口径，两者各自写在注释里。
 */
function cliFormat(text: string, params: Record<string, unknown>): string {
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k: string) => (k in params ? pyStr(params[k]) : m));
}

/**
 * 子进程的环境变量：`env_allow` 是白名单。
 *
 * 给了 `env` 就**完全替换**子进程环境，所以 `PATH` 永远保留——否则连可执行文件都找不到
 * （Node 的 spawn 查 PATH 用的是子进程环境）。不给白名单就整体继承，与 curl 那一档一致。
 */
function cliEnv(spec: Record<string, any>): NodeJS.ProcessEnv | undefined {
  const raw = spec["env_allow"];
  if (raw === undefined || raw === null) return undefined;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
  for (const k of raw as string[]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function cliCwd(spec: Record<string, any>): string {
  const raw = spec["cwd"];
  if (raw === undefined || raw === null || pyStr(raw) === "") return REPO;
  const c = pyStr(raw);
  return path.isAbsolute(c) ? c : path.join(REPO, c);
}

/**
 * 跑一个命令行工具，把它的退出码映射成引擎的「状态码」。
 *
 * **为什么是 argv 数组而不是命令字符串：永不过 shell。** `spawnSync(bin, argv)` 默认
 * `shell: false`，每个参数原样交给进程——槽位/模板里的 `;`、`$(...)`、`|`、空格都只是
 * 普通字符。这是 CLI 面与 DOM 面最大的安全差异（页面上误点最多点错，字符串拼接能执行），
 * 也是它必须写成数组的原因。
 *
 * 退出码语义按配置：`exit_ok`（默认 `[0]`）里的码算成功 → 200；其它码原样向上抛给
 * `blocked()`（它只看"非 200"），于是 audits/counts/selects/report 一行都不用改。
 * stderr 并进响应体，好让 `block_markers` 认出「要登录/被限流」这类失败。
 *
 * 超时、二进制不存在、argv 非法都**抛错**而不是静默返回空——和 curl 那一档同口径。
 */
export async function cliRunDetailed(
  url: string, timeout = 60.0, source?: Source, extraArgs: readonly string[] = [],
): Promise<CliObservation> {
  const spec = cliSpec(source);
  const bin = pyStr(spec["bin"]);
  const argvTpl = spec["argv"];
  if (!Array.isArray(argvTpl) || !argvTpl.length) {
    throw new ValueError("transport.cli.argv must be a non-empty list (an argv array, never a shell string)");
  }
  // 逐步追加的参数（动作腿用）：与 argv 同样只替换已声明的键，其余花括号原样保留
  const params = cliParams(source, url);
  const argv = [...argvTpl, ...extraArgs].map((a) => cliFormat(pyStr(a), params));
  const exitOk = Array.isArray(spec["exit_ok"]) ? (spec["exit_ok"] as unknown[]).map(Number) : [0];
  const cwd = cliCwd(spec);
  const res = spawnSync(bin, argv, {
    cwd,
    env: cliEnv(spec),
    encoding: "utf8",
    maxBuffer: 1 << 28,
    // 子进程拿到的就是调用方给的墙钟预算（`timeout` 是秒）。curl 那一档多给 10 s 宽限是因为
    // HTTP 有连接/重定向的开销；命令行工具的预算是它自己的事，超时就杀掉并抛错。
    timeout: Math.max(250, Math.round(timeout * 1000)),
    input: spec["stdin"] === undefined || spec["stdin"] === null ? undefined : pyStr(spec["stdin"]),
  });
  if (res.error) throw res.error;          // ENOENT / ETIMEDOUT：响亮地失败
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  const stderr = typeof res.stderr === "string" ? res.stderr : "";
  const code = res.status === null ? 1 : res.status;
  return { code, ok: exitOk.includes(code), stdout, stderr, argv, cwd, exit_ok: exitOk };
}

/**
 * 跑一个命令行工具，把它的退出码映射成引擎的「状态码」。
 *
 * **为什么是 argv 数组而不是命令字符串：永不过 shell。** `spawnSync(bin, argv)` 默认
 * `shell: false`，每个参数原样交给进程——槽位/模板里的 `;`、`$(...)`、`|`、空格都只是
 * 普通字符。这是 CLI 面与 DOM 面最大的安全差异（页面上误点最多点错，字符串拼接能执行），
 * 也是它必须写成数组的原因。
 *
 * 退出码语义按配置：`exit_ok`（默认 `[0]`）里的码算成功 → 200；其它码原样向上抛给
 * `blocked()`（它只看"非 200"），于是 audits/counts/selects/report 一行都不用改。
 * stderr 并进响应体，好让 `block_markers` 认出「要登录/被限流」这类失败。
 *
 * 超时、二进制不存在、argv 非法都**抛错**而不是静默返回空——和 curl 那一档同口径。
 */
export async function cliRun(url: string, timeout = 60.0, source?: Source): Promise<[number, string]> {
  const obs = await cliRunDetailed(url, timeout, source);
  return [obs.ok ? 200 : obs.code, obs.stdout + obs.stderr];
}

/** 版本探针的原始输出（第一行）。没配 pin 就返回 null，不跑子进程。 */
export function cliVersion(source: Source): string | null {
  const tr = (source["transport"] as Record<string, any> | undefined) || {};
  if (!pyTruthy(tr["version_pin"])) return null;
  const spec = tr["cli"] as Record<string, any>;
  const argvRaw = tr["version_argv"] === undefined || tr["version_argv"] === null
    ? ["--version"] : (tr["version_argv"] as unknown[]);
  const res = spawnSync(pyStr(spec["bin"]), argvRaw.map(pyStr), {
    cwd: cliCwd(spec),
    env: cliEnv(spec),
    encoding: "utf8",
    maxBuffer: 1 << 24,
    timeout: 30_000,
  });
  if (res.error) throw res.error;
  const text = `${typeof res.stdout === "string" ? res.stdout : ""}`
    + `${typeof res.stderr === "string" ? res.stderr : ""}`;
  return text.split("\n").map((s) => s.trim()).find((s) => s) ?? "";
}

/**
 * 工具版本是「冻结语料不能依赖墙上时钟」的同型问题：同一个命令的输出会随版本漂移，
 * 所以 pin 不住就**响亮地失败**，而不是抽出一堆看起来对的数据。返回实测版本（进报告）。
 */
export function checkVersion(source: Source): string | null {
  const pin = ((source["transport"] as Record<string, any> | undefined) || {})["version_pin"];
  if (!pyTruthy(pin)) return null;
  const seen = cliVersion(source) ?? "";
  if (!seen.includes(pyStr(pin))) {
    throw new ValueError(`tool version mismatch: expected ${pyRepr(pyStr(pin))}, got ${pyRepr(seen)}`);
  }
  return seen;
}

export const CLIENTS: Record<string, Client> = { curl: curlGet, httpx: httpxGet, cli: cliRun };

/* ---------------------------------------------------------------- 算子 */

export const TRANSPORTS = ["curl", "httpx", "cli"] as const;

/** Python `transport.client` 的默认值语义（键存在时即使为 null 也不算默认）。 */
export function transportClient(source: Source): unknown {
  const tr = (source["transport"] as Record<string, unknown> | undefined) || {};
  return hasOwn(tr, "client") ? tr["client"] : "curl";
}

export async function fetchSource(source: Source, url: string, timeout = 60.0): Promise<[number, string]> {
  const client = transportClient(source);
  const fn = CLIENTS[pyStr(client)];
  if (!fn) throw new KeyError(pyRepr(client));
  return fn(url, timeout, source);
}

/**
 * HTTP 非 200，或响应体开头命中该 source 配置的 `transport.block_markers`。
 *
 * 哪个特征词代表「被风控挡住」是站点知识，归配置；引擎只做通用判断（非 200 即挡）。
 */
export function blocked(source: Source, code: number, body: string): boolean {
  const tr = (source["transport"] as Record<string, unknown> | undefined) || {};
  const raw = (tr["block_markers"] as unknown) || [];
  const markers = Array.isArray(raw) ? raw : [];
  const low = (body || "").slice(0, 400).toLowerCase();
  return code !== 200 || markers.some((m) => low.includes(pyStr(m).toLowerCase()));
}

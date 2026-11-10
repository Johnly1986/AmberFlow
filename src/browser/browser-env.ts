/**
 * Cross-platform chromium resolution — the TS twin of `browser_env.py`.
 *
 * Keeps the original behaviour (try the playwright-managed browser first, fall
 * back to a pre-installed chromium) and adds `--no-sandbox` when running as root.
 * The Python version exists because four scripts hardcoded a Windows-only
 * fallback; the port keeps the same discovery order so both runtimes can share
 * one browser install.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function glob(pattern: string): string[] {
  // Segment-by-segment expansion (the patterns below use `*` at any depth).
  // `path.parse().root` keeps the drive on Windows ("C:\\"): a drive-absolute
  // pattern does NOT start with `path.sep`, so splitting on the separator would
  // emit "C:" as an ordinary segment and resolve it against "." (".\\C:") —
  // measured: candidates() was always empty on Windows, browsers or not.
  const root = path.parse(pattern).root;
  const parts = (root ? pattern.slice(root.length) : pattern).split(path.sep).filter((p) => p !== "");
  let bases: string[] = root ? [root] : ["."];
  for (const part of parts) {
    const next: string[] = [];
    if (!part.includes("*")) {
      for (const b of bases) {
        const p = path.join(b, part);
        if (fs.existsSync(p)) next.push(p);
      }
    } else {
      const re = new RegExp("^" + part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
      for (const b of bases) {
        if (!fs.existsSync(b)) continue;
        for (const n of fs.readdirSync(b)) if (re.test(n)) next.push(path.join(b, n));
      }
    }
    bases = next;
  }
  return bases;
}

function browserRoots(): string[] {
  const roots: string[] = [];
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (env) roots.push(env.replace(/^~/, os.homedir()));
  if (process.platform === "win32") {
    const ld = process.env.LOCALAPPDATA ?? "";
    if (ld) roots.push(path.join(ld, "ms-playwright"));
  } else {
    roots.push(path.join(os.homedir(), ".cache", "ms-playwright"));
  }
  return roots.filter((r) => r && fs.existsSync(r));
}

/** Absolute paths of usable chromium binaries, newest revision last. */
export function chromiumCandidates(): string[] {
  const patterns =
    process.platform === "win32"
      ? ["chromium-*/chrome-win*/chrome.exe",
         "chromium_headless_shell-*/chrome-headless-shell-win*/chrome-headless-shell.exe"]
      : process.platform === "darwin"
        ? ["chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium"]
        : ["chromium-*/chrome-linux*/chrome",
           "chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell"];
  const found: string[] = [];
  for (const root of browserRoots()) {
    for (const pat of patterns) found.push(...glob(path.join(root, pat)));
  }
  // Full chrome wins over the headless shell; then highest revision number.
  const rank = (p: string): [number, string] => [path.basename(p).includes("headless") ? 1 : 0, p];
  return [...new Set(found)].sort((a, b) => {
    const [ha, pa] = rank(a);
    const [hb, pb] = rank(b);
    return ha - hb || (pa < pb ? -1 : pa > pb ? 1 : 0);
  });
}

export interface LaunchOptions {
  headless?: boolean;
  extensionDir?: string | null;
  [k: string]: unknown;
}

/* ---- task-21/D-1：启动事实记账（env.browser 一等证据的来源） ----
 * 记录**最后一次**启动的 {binary_basename, headless, persistent_profile}——browserSession()
 * 创建会话后读取挂到 session.envBrowser 上（只增字段；sessionFactory 注入的会话没有）。 */

export interface BrowserLaunchFacts {
  binary_basename: string;
  headless: boolean;
  persistent_profile: boolean;
}

let lastLaunchFacts: BrowserLaunchFacts | null = null;

function recordLaunchFacts(executablePath: string, headless: boolean, persistent: boolean): void {
  lastLaunchFacts = {
    binary_basename: path.basename(executablePath),
    headless,
    persistent_profile: persistent,
  };
}

/** 读最后一次启动事实（没启动过 = null——调用方缺省省略）。 */
export function lastBrowserLaunchFacts(): BrowserLaunchFacts | null {
  return lastLaunchFacts;
}

/* ---- task-43：浏览器通道选择面（env > meta > default 三层的解析出处） ----
 * env 层（AMBERFLOW_BROWSER_CHANNEL，部署/CI 的机器级覆盖）在这里读一次、所有调用路径共用；
 * meta 层（meta.policy.browser，应用作者的站点知识）由 run 面解析后经参数传入 launchKwargs。
 * 优先级 env > meta：env 设了就盖掉 meta（部署级覆盖机器差异）。default = 现行二进制解析
 * （headless 缺省即 headless-shell）。channel 与 executablePath 在 Playwright 里互斥；
 * channel 与 extensionDir 互斥（MV3 持久化路径保持自己的"必须完整 chromium"解析）。 */

export type BrowserChannel = "chrome" | "headless-shell";

/** env 层通道（未设/未知值 = null——未知值不炸，走缺省链；apps check 面的闭集只管 meta）。 */
export function channelFromEnv(): BrowserChannel | null {
  const v = process.env.AMBERFLOW_BROWSER_CHANNEL;
  return v === "chrome" || v === "headless-shell" ? v : null;
}

/** kwargs for `chromium.launch()` (playwright's own option names). */
export function launchKwargs(
  headless = true,
  extensionDir: string | null = null,
  metaChannel: BrowserChannel | null = null,
): LaunchOptions {
  const kw: LaunchOptions = { headless };
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    kw.args = ["--no-sandbox", "--disable-dev-shm-usage"];   // containers
  }
  const cands = chromiumCandidates();
  // ---- task-39/43：通道选择面。env(AMBERFLOW_BROWSER_CHANNEL) > metaChannel > 缺省解析。
  // 缺省（都未设）原路径逐字节不变。channel 路径不解析本地二进制；无系统 Chrome 由
  // launch 抛错并在上层如实报（不静默回退——要回退请删 env/meta）。
  const channel = channelFromEnv() ?? metaChannel;
  if (channel !== null && !extensionDir) {
    if (channel === "chrome") {
      kw.channel = "chrome";
      return kw; // channel 路径不解析本地二进制；无系统 Chrome 由 launch 抛错并在上层如实报
    }
    const shell = cands.filter((c) => path.basename(c).includes("headless"));
    if (shell.length) kw.executablePath = shell[shell.length - 1];
    return kw;
  }
  if (extensionDir) {
    // MV3 extensions only load in the full chromium (new headless or headed).
    const full = cands.filter((c) => !path.basename(c).includes("headless"));
    if (!full.length) {
      throw new Error("extension tests need a full chromium build (chrome-linux*/chrome), "
        + "but only the headless shell was found. Run `playwright install chromium`.");
    }
    if (headless) {
      kw.headless = false;
      kw.args = [...(kw.args as string[] ?? []), "--headless=new"];
    }
    kw.executablePath = full[full.length - 1];
    kw.args = [...(kw.args as string[] ?? []),
      `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`];
  } else if (cands.length) {
    if (!headless) {
      // 有头窗口只能由完整 chromium 提供：headless shell 不显示窗口，用它启动有头模式只会
      // 得到一句和"缺显示器"无关的费解错误，所以在这里点名缺什么、怎么补。
      const full = cands.filter((c) => !path.basename(c).includes("headless"));
      if (!full.length) {
        throw new Error("有头运行（--headful）需要完整 chromium，但本机只有 headless shell："
          + "跑 `npx playwright install chromium`，或把 PLAYWRIGHT_BROWSERS_PATH 指向含 chromium-*/ 的目录。");
      }
      kw.executablePath = full[full.length - 1];
    } else {
      kw.executablePath = cands[cands.length - 1];
    }
  }
  return kw;
}

export interface BrowserLike {
  newContext(opts?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Launch a browser through the same resolution order as the Python layer. */
export async function launch(
  pw: { chromium: { launch(opts: LaunchOptions): Promise<unknown>; executablePath?(opts?: Record<string, unknown>): string } },
  headless = true,
  extensionDir: string | null = null,
  metaChannel: BrowserChannel | null = null,
): Promise<BrowserLike> {
  const kw = launchKwargs(headless, extensionDir, metaChannel);
  if (!("executablePath" in kw) && !("channel" in kw)) {
    throw new Error("no chromium binary found. Run `playwright install chromium`, or set "
      + "PLAYWRIGHT_BROWSERS_PATH to a directory containing chromium-*/.");
  }
  // task-21/D-1：启动事实记账（env.browser 一等证据——渲染退化判定的第一块事实）。
  // task-39 A/B 旁路：channel 路径没有本地 executablePath，用 Playwright 自己的
  // executablePath() 解析出真实二进制（解析失败如实记 channel 名，不编路径）。
  let binaryForFacts = String((kw as { executablePath?: string }).executablePath ?? "");
  if (binaryForFacts === "" && typeof pw.chromium.executablePath === "function") {
    try { binaryForFacts = pw.chromium.executablePath(kw as Record<string, unknown>); }
    catch { binaryForFacts = `channel:${String((kw as { channel?: string }).channel ?? "?")}`; }
  }
  recordLaunchFacts(binaryForFacts, headless, false);
  return (await pw.chromium.launch(kw)) as BrowserLike;
}

/** True if chromium actually launches with the default kwargs. */
export async function probe(pw: { chromium: { launch(opts: LaunchOptions): Promise<{ close(): Promise<void> }> } }): Promise<boolean> {
  try {
    (await pw.chromium.launch(launchKwargs())).close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Persistent-context twin of `launch()` — the TS port of
 * `browser_env.launch_persistent_context`.
 *
 * Load-bearing for MV3: `chromium.launch()` passes Playwright's own
 * `--disable-extensions`, which beats `--load-extension` and leaves the service
 * worker unregistered (measured while porting the extension e2e test). The
 * persistent path is the one that actually loads an unpacked extension.
 */
export async function launchPersistentContext(
  pw: { chromium: { launchPersistentContext(userDataDir: string, opts?: Record<string, unknown>): Promise<unknown> } },
  userDataDir: string,
  headless = false,
  extensionDir: string | null = null,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const kw = launchKwargs(headless, extensionDir) as Record<string, unknown>;
  const args = (kw.args as string[] | undefined) ?? [];
  delete kw.args;
  if (!("executablePath" in kw)) {
    throw new Error("no chromium binary found. Run `playwright install chromium`, or set "
      + "PLAYWRIGHT_BROWSERS_PATH to a directory containing chromium-*/.");
  }
  // task-21/D-1：持久化 profile 的启动事实（persistent_profile:true）。
  recordLaunchFacts(String(kw.executablePath), headless, true);
  return pw.chromium.launchPersistentContext(userDataDir, { ...kw, args, ...extra });
}

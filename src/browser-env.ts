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
  const parts = pattern.split(path.sep).filter((p) => p !== "");
  let bases: string[] = pattern.startsWith(path.sep) ? [path.sep] : ["."];
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
      ? ["chromium-*/chrome-win*/chrome.exe"]
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

/** kwargs for `chromium.launch()` (playwright's own option names). */
export function launchKwargs(headless = true, extensionDir: string | null = null): LaunchOptions {
  const kw: LaunchOptions = { headless };
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    kw.args = ["--no-sandbox", "--disable-dev-shm-usage"];   // containers
  }
  const cands = chromiumCandidates();
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
    kw.executablePath = cands[cands.length - 1];
  }
  return kw;
}

export interface BrowserLike {
  newContext(opts?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Launch a browser through the same resolution order as the Python layer. */
export async function launch(
  pw: { chromium: { launch(opts: LaunchOptions): Promise<unknown> } },
  headless = true,
  extensionDir: string | null = null,
): Promise<BrowserLike> {
  const kw = launchKwargs(headless, extensionDir);
  if (!("executablePath" in kw)) {
    throw new Error("no chromium binary found. Run `playwright install chromium`, or set "
      + "PLAYWRIGHT_BROWSERS_PATH to a directory containing chromium-*/.");
  }
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
  return pw.chromium.launchPersistentContext(userDataDir, { ...kw, args, ...extra });
}

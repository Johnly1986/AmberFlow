/**
 * browser-env tests: the cross-platform resolution order, the MV3-safe kwargs,
 * the persistent-context twin the extension path needs, and the headed/`--headful` contract
 * (a window only exists with the full chromium — and the missing piece is named when it doesn't).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import {
  chromiumCandidates, launch, launchKwargs, launchPersistentContext, probe,
} from "../src/browser-env.ts";

describe("chromium resolution (browser_env.py twin)", () => {
  it("finds the installed full chromium before the headless shell", () => {
    const cands = chromiumCandidates();
    expect(cands.length).toBeGreaterThan(0);
    const first = path.basename(cands[0]!);
    expect(first).not.toContain("headless");
  });

  it("adds --no-sandbox when running as root (containers)", () => {
    const kw = launchKwargs();
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      expect(kw.args).toContain("--no-sandbox");
    }
    expect(kw.executablePath).toBeTruthy();
  });

  it("switches to the full chromium + new headless for extensions", () => {
    const kw = launchKwargs(true, "/tmp/some-extension");
    expect(kw.headless).toBe(false);                       // forces --headless=new on the full binary
    expect(kw.args).toContain("--headless=new");
    expect(kw.args).toContain("--load-extension=/tmp/some-extension");
    expect(kw.args).toContain("--disable-extensions-except=/tmp/some-extension");
    expect(String(kw.executablePath)).not.toContain("headless_shell");
  });

  it("headed picks the full chromium — a window needs it, the headless shell has none", () => {
    const kw = launchKwargs(false);
    expect(kw.headless).toBe(false);
    expect(String(kw.executablePath)).not.toContain("headless_shell");
  });

  it("headed names the missing binary when only the headless shell is installed", () => {
    // 把解析面收窄到"只有 headless shell"的假浏览器目录（browserRoots 认 HOME 与 env）。
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-headonly-"));
    const shell = path.join(home, ".cache", "ms-playwright", "chromium_headless_shell-1234",
      "chrome-headless-shell-linux", "chrome-headless-shell");
    fs.mkdirSync(path.dirname(shell), { recursive: true });
    fs.writeFileSync(shell, "");
    const savedHome = process.env.HOME;
    const savedEnvPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.HOME = home;
    try {
      expect(() => launchKwargs(false)).toThrow(/有头运行.*headless shell/s);
      // 同一天花板下 headless 照常可用：报错只针对"有头但没有完整 chromium"。
      expect(String(launchKwargs(true).executablePath)).toContain("headless_shell");
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedEnvPath !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = savedEnvPath;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("actually launches (and probe() agrees)", async () => {
    expect(await probe({ chromium } as never)).toBe(true);
    const b = (await launch({ chromium } as never)) as unknown as { close(): Promise<void> };
    await b.close();
  }, 60_000);

  it("provides a persistent context (what MV3 extension loading requires)", async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "laya-profile-"));
    const ctx = (await launchPersistentContext({ chromium } as never, profile, true)) as {
      pages(): unknown[]; close(): Promise<void>;
    };
    try {
      expect(ctx.pages().length).toBeGreaterThanOrEqual(1);
    } finally {
      await ctx.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }, 60_000);
});

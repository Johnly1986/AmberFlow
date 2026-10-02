/**
 * The parity clock must not be the wall clock.
 *
 * Round 5 found a time bomb: the frozen cross-runtime corpora carry a human-readable
 * 「执行日期」line, so the ctrip byte-comparison silently expired at midnight — the gate
 * went 10/10 -> 9/10 on 2026-10-03 purely because the reference corpus was generated on
 * 2026-10-02. The corpus is a Python artifact and stays untouched; the CLOCK is what
 * gets pinned (`LAYA_TODAY`), and the parity tool pins it to the day its corpus was made.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextWeekDates, todayIso } from "../src/datasource.ts";
import { REPO } from "../src/flow.ts";

const prev = process.env.LAYA_TODAY;
afterEach(() => {
  if (prev === undefined) delete process.env.LAYA_TODAY;
  else process.env.LAYA_TODAY = prev;
});

describe("todayIso is pinnable", () => {
  it("an explicit override wins, and so does the env pin", () => {
    expect(todayIso("2020-01-02")).toBe("2020-01-02");
    process.env.LAYA_TODAY = "2020-03-04";
    expect(todayIso()).toBe("2020-03-04");
    expect(todayIso("2021-05-06")).toBe("2021-05-06");     // explicit beats env
  });

  it("a malformed pin is IGNORED, not trusted (never crash the clock)", () => {
    process.env.LAYA_TODAY = "yesterday";
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayIso()).not.toBe("yesterday");
  });

  it("nextWeekDates derives from the pin, so it is deterministic too", () => {
    process.env.LAYA_TODAY = "2026-09-30";                  // a Wednesday
    expect(nextWeekDates()).toEqual([
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09",
    ]);
  });
});

describe("the frozen corpus is reproducible under its own pinned day", () => {
  it("pinning LAYA_TODAY to the corpus day reproduces the corpus dates", () => {
    const corpus = JSON.parse(
      fs.readFileSync(path.join(REPO, "tools", "ctrip-corpus.json"), "utf-8"),
    ) as { dates: string[]; report: string };
    const frozenDay = /执行日期：(\d{4}-\d{2}-\d{2})/.exec(corpus.report)?.[1];
    expect(frozenDay).toBeTruthy();
    process.env.LAYA_TODAY = frozenDay!;
    expect(nextWeekDates()).toEqual(corpus.dates);
  });

  it("without the pin it tracks the WALL clock — which is why the corpus needs one", () => {
    delete process.env.LAYA_TODAY;
    const d = new Date();
    const p = (n: number): string => String(n).padStart(2, "0");
    const realToday = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    expect(todayIso()).toBe(realToday);
  });
});

/**
 * 语义流测试的共享夹具面（复核发现 10 的处置）。
 *
 * 为什么现在抽：第三个夹具出现（S3 强制测试要一份"按钮页"夹具）——此前每个夹具自带一份
 * `PAGE` + mkdtemp + flow.json/authored-profile 落盘样板是"为两个实例搭抽象"，现在不是了。
 *
 * 约定：
 *   - `makeFlowApp` 只造**静态**部分（目录 + 页面 + flow.json + authored 档案）；
 *     flow 需要 pagesDir 里的 start_url，所以收一个 `flowFor(pagesDir, site)` 工厂；
 *   - 学习档案目录（profileDir）与 authored 档案（flowDir/sites/<site>.profile.json）是
 *     **两个不同文件**——测试要种"学到的映射"时写前者，别写后者（复核抓到过这个混用）；
 *   - 需要反复改写 flow 的用例拿 `flowPath` + `writeJson` 自己重写。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PAGE = (body: string, lang = "zh"): string =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

export const tmpDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const writeJson = (p: string, obj: unknown): void => {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
};

export interface FlowApp {
  appsDir: string;
  site: string;
  /** 学习档案目录（runFlow 的 profileDir；与 authored 档案分家）。 */
  profileDir: string;
  pagesDir: string;
  flowPath: string;
  authoredProfilePath: string;
}

export function makeFlowApp(opts: {
  prefix: string;
  id: string;
  site?: string;
  /** 页面文件名 → HTML。 */
  files: Record<string, string>;
  /** flow.json 内容工厂（拿 pagesDir 拼 start_url）。 */
  flowFor: (pagesDir: string, site: string) => Record<string, unknown>;
  /** authored 站点档案（<id>/sites/<site>.profile.json）。 */
  authoredProfile: Record<string, unknown>;
}): FlowApp {
  const site = opts.site ?? "site-x";
  const appsDir = tmpDir(`${opts.prefix}-app-`);
  const pagesDir = tmpDir(`${opts.prefix}-pages-`);
  const dir = path.join(appsDir, opts.id);
  fs.mkdirSync(path.join(dir, "sites"), { recursive: true });
  for (const [name, html] of Object.entries(opts.files)) {
    fs.writeFileSync(path.join(pagesDir, name), html, "utf-8");
  }
  const flowPath = path.join(dir, "flow.json");
  writeJson(flowPath, opts.flowFor(pagesDir, site));
  const authoredProfilePath = path.join(dir, "sites", `${site}.profile.json`);
  writeJson(authoredProfilePath, opts.authoredProfile);
  const profileDir = tmpDir(`${opts.prefix}-prof-`);
  return { appsDir, site, profileDir, pagesDir, flowPath, authoredProfilePath };
}

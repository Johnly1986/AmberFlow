/**
 * 结构守卫：**凡是会起浏览器 / 载决策 provider / 读产物路径或 LLM 端点的 npm-script 入口，
 * 必须接线 `applyRcToEnv()`**。
 *
 * 起因（2026-10-20 实测）：第一版只接了 5 个"主要"入口，`providers:baseline` 没接——
 * 用户在 configs/amberflowrc.json 里填好的 key 对那条命令不可见，报"缺 API key"。
 * 这正是本仓库反复点名的缺陷形状："同一个问题，只开了一半的门"。
 * 守卫口径（可判定，不靠自觉）：入口文件**直接** import 这些承重模块，或**直接**读白名单
 * 环境变量 ⇒ 源码里必须出现 applyRcToEnv。离线冻结语料对拍（*-parity、apps:matrix、
 * arch-metrics）刻意不碰环境，不在射程内。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, RC_GROUPS } from "../src/support/rcfile.ts";

const scripts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")).scripts as
  Record<string, string>;
const entryFiles = [...new Set(Object.values(scripts)
  .map((v) => (v.match(/node (?:--experimental-strip-types )?([^\s]+\.(?:ts|mjs))\b/) || [])[1])
  .filter((f): f is string => Boolean(f)))];

// 承重模块：import 它们 = 这条命令的运行结果会受机器配置影响
const LOADS_CONFIG = /(model-artifacts|decision-provider|decision-tokenplan|decision-jevk5|decision-bailian|browser-env|executor)\.ts/;
const KNOWN_KEYS = RC_GROUPS.flatMap((g) => g.keys);
// 策略线：这一族对**冻结语料**做静态比对，刻意不碰机器配置（时钟由 tools/frozen-today.ts
// 的代码常量钉死，provider 由脚本注入）——给它们接 rc 反而会把对拍变成"随机器漂移"。
const OFFLINE_FAMILY = /-parity\.[a-z]+|(apps_matrix|arch-metrics|spec-to-pack|probe-baseline|gate-signals|model-contribution)\.ts/;

function loadsConfig(file: string, seen = new Set<string>()): string | null {
  if (seen.has(file)) return null;
  seen.add(file);
  const src = fs.readFileSync(file, "utf-8");
  for (const m of src.matchAll(/from "([^"]+)"/g)) {
    const spec = m[1]!;
    if (!spec.startsWith(".")) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (LOADS_CONFIG.test(spec) && fs.existsSync(target)) return spec;
    if (fs.existsSync(target) && loadsConfig(target, seen)) return spec;
  }
  return KNOWN_KEYS.find((k) => src.includes(`env.${k}`)) ?? null;
}

describe("入口接线守卫：读配置的入口必须接 rc", () => {
  const offenders = entryFiles
    .filter((f) => !OFFLINE_FAMILY.test(f))
    .filter((f) => {
      const abs = path.join(REPO_ROOT, f);
      if (!fs.existsSync(abs)) return false;
      return loadsConfig(abs) !== null;
    })
    .filter((f) => {
      const src = fs.readFileSync(path.join(REPO_ROOT, f), "utf-8");
      if (src.includes("applyRcToEnv")) return false;
      // 间接也算达标：入口只是 main() 的薄壳，且它 import 的实现文件里接了线
      const imported = [...src.matchAll(/from "(\.[^"]+\.ts)"/g)].map((m) => path.resolve(path.dirname(path.join(REPO_ROOT, f)), m[1]!));
      return !imported.some((p) => fs.existsSync(p) && fs.readFileSync(p, "utf-8").includes("applyRcToEnv"));
    });

  it.each(offenders.length ? offenders : ["(无漏接入口)"])(
    "入口 %s 要么不读机器配置，要么接 applyRcToEnv", (f) => {
      if (f === "(无漏接入口)") return;                 // 全绿：0 个违例者，断言即通过本条
      expect(fs.readFileSync(path.join(REPO_ROOT, f), "utf-8")).toContain("applyRcToEnv");
    });

  it("守卫本身确实在看：抽样验证已接线的入口与承重模块非空", () => {
    // 防止守卫退化成"永远通过"：承重面判定命中过的文件里，至少有一个确实 import 了 rcfile
    const sampled = ["src/cli/bench.ts", "src/model/model-fetch.ts", "tools/provider-baselines.ts"];
    for (const f of sampled) {
      expect(fs.readFileSync(path.join(REPO_ROOT, f), "utf-8"), f).toContain("applyRcToEnv");
    }
    expect(entryFiles.length).toBeGreaterThan(20);      // scripts 解析本身别瞎
    // 豁免名单不是空转：离线家族确实命中了 scripts 里的入口，且承重入口也在射程里——
    // 否则"filter 全放行"会让守卫静默失去牙齿。
    const exempted = entryFiles.filter((f) => OFFLINE_FAMILY.test(f));
    expect(exempted.length).toBeGreaterThan(2);
    expect(entryFiles.filter((f) => !OFFLINE_FAMILY.test(f) && loadsConfig(path.join(REPO_ROOT, f)) !== null).length)
      .toBeGreaterThan(8);
  });
});

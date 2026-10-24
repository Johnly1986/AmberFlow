/**
 * L3.1 迁移闸门：`pack.json → app.mjs` 必须**无损**。
 *
 * 这是 L3 的关键杠杆：只要迁移后的脚本 `expandPack` 与来源包逐字段一致，六层对拍的
 * 冻结语料就**不需要重冻**（输出相同）。本测试对仓库里全部应用包跑一遍
 * （生成到临时目录 → 用真实 `loadScriptApp` 读回 → 对照 steps/invariants/slots/rolesUsed/声明面）。
 */
import { describe, expect, it } from "vitest";
import { listPacks, loadPack } from "../src/app/app-pack.ts";
import { verifyMigration } from "../tools/apps_migrate.ts";

describe("L3.1：pack.json → app.mjs 无损迁移", () => {
  const packs = listPacks();

  it("仓库里至少发现 10 个应用包（防止空跑假绿）", () => {
    expect(packs.length).toBeGreaterThanOrEqual(10);
  });

  it.each(packs.map(([id, , p]) => [id, p] as const))("%s：脚本展开 == 来源包展开", async (id, p) => {
    const pack = loadPack(p);
    const { problems } = await verifyMigration(pack);
    expect(problems, id).toEqual([]);
  });
});

/**
 * L2 ctx：**站点面** API —— `meta.site.pages`（openPage）与 `meta.site.listExtract`（extract），
 * 以及 `ctx.read.attr`。
 *
 * 为什么站点知识必须声明：openPage 的 role 与 extract 的行/字段选择器都是站点相关数据，
 * 写进共享代码就是泄漏；声明在应用自己的 meta 里，ctx 只做机械解析。
 *
 * dry 模式下观察类 API 返回占位值（null/0/[]），所以断言只在"有真值时"生效；
 * 真正的验收由真实运行 + replay 完成。
 */
export const meta = (kit) => ({
  id: "flow-site-api",
  label: "L2 flow：站点面（openPage / read.attr / extract）",
  goal: "用 meta.site 的页面角色与命名行抽取走一遍站点面 API",
  model: "english",
  hosts: [],
  slots: {},
  site: {
    pages: { portal: "testpages/portal.html" },
    listExtract: {
      entries: { rows: "nav.menu a", fields: { label: "." } },
    },
  },
  invariants: [{ id: "on-portal", desc: "结束时停在门户页", signal: kit.judge.url("portal.html") }],
});

export async function flow(ctx) {
  await ctx.openPage("portal");
  if (!ctx.url().includes("portal.html")) throw new Error(`openPage 后不在门户：${ctx.url()}`);

  const entries = await ctx.extract("entries");
  ctx.log(`entries=${entries.length}`);
  if (entries.length > 0 && !entries[0].label.includes("枪机")) {
    throw new Error(`extract 首行不对：${JSON.stringify(entries[0])}`);
  }

  const href = await ctx.read.attr("[data-test=entry-fixed]", "href");
  if (href !== null && href !== "camera_a.html") throw new Error(`read.attr href=${JSON.stringify(href)}`);

  const missing = await ctx.read.attr("[data-test=entry-fixed]", "data-does-not-exist");
  if (missing !== null) throw new Error(`不存在的属性应为 null，拿到 ${JSON.stringify(missing)}`);

  const count = await ctx.read.count("nav.menu a");
  if (count !== 0 && count !== 2) throw new Error(`count=${count}`);

  await ctx.done();
}

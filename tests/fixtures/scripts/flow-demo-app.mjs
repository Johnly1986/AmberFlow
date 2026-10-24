/**
 * L2 夹具：`flow(ctx)` 跑 demo-app 的同一条下单链路（加购 → 购物车 → 优惠券 → 结算）。
 *
 * 与 L1 的差别只有一处、也是 L2 的全部意义：**控制流在脚本里**——
 * 循环（优惠券最多试两次）与条件（`if (!r.ok)`）都是普通 JS，
 * 运行期不再有 `retries`/`when` 这些声明键。
 *
 * 引擎仍然独占一步之内的一切：元素池/选元素/闸门/动作/证据判定/绑定。
 */
export const meta = (kit) => ({
  id: "flow-demo-app",
  label: "L2 flow：加购 → 购物车 → 优惠券 → 结算",
  goal: "在自带的商店夹具上走一条完整下单链路：加购 → 打开购物车 → 用计划里的优惠券 → 结算到感谢页",
  model: "english",
  hosts: [],
  slots: { coupon: "ACME10" },
  invariants: [
    {
      id: "on-thanks-page",
      desc: "旅程结束时确实在感谢页（不是停在购物车页）",
      signal: kit.judge.all(
        kit.judge.url("shop_thanks.html"),
        kit.judge.text("[data-test=order-ok]", "Thank you"),
      ),
    },
  ],
});

export async function flow(ctx) {
  await ctx.open("bench/fixtures/shop_home.html");

  const added = await ctx.step("把 TrailBottle 加入购物车", {
    act: ctx.hint("[data-test=add-to-cart]"),
    done: ctx.judge.equals("[data-test=cart-count]", "1"),
  });
  if (!added.ok) throw new Error(`add-to-cart failed: ${added.stopCode}`);

  const opened = await ctx.step("打开购物车页", {
    url: "bench/fixtures/shop_home.html",
    act: ctx.hint("[data-test=cart-link]"),
    done: ctx.judge.all(
      ctx.judge.url("shop_cart.html"),
      ctx.judge.equals("[data-test=cart-count]", "1"),
    ),
  });
  if (!opened.ok) throw new Error(`open-cart failed: ${opened.stopCode}`);

  // 运行期重试：最多两次，普通 for 循环（JSON 里要写 retries 键，这里不需要）。
  let applied = false;
  for (let attempt = 0; attempt < 2 && !applied; attempt += 1) {
    const r = await ctx.step("在购物车输入优惠券并应用", {
      url: "bench/fixtures/shop_cart.html",
      act: ctx.hints("[data-test=coupon]", "[data-test=apply-coupon]"),
      slots: { coupon: ctx.slots.coupon },
      done: ctx.judge.text("[data-test=coupon-msg]", "Coupon applied"),
    });
    applied = r.ok;
  }
  if (!applied) throw new Error("coupon was never applied");

  const paid = await ctx.step("结算，落到感谢页", {
    url: "bench/fixtures/shop_cart.html",
    act: ctx.hint("[data-test=checkout]"),
    done: ctx.judge.all(
      ctx.judge.url("shop_thanks.html"),
      ctx.judge.text("[data-test=order-ok]", "Thank you"),
    ),
  });
  if (!paid.ok) throw new Error(`checkout failed: ${paid.stopCode}`);

  await ctx.done();
}

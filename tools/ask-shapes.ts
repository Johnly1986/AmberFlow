/**
 * `tools/ask-shapes.ts` —— **同一个页面、同一个目标，换问法**：模型答得一样吗？
 *
 * 起因（docs/DECISION_MODEL_PURPOSE_REVIEW.md §2.6）：执行器的阶梯在 hint 未命中时
 * 把**整个元素池**交给模型（40 个元素、"点哪个"），而 P1 的窄问（`tieredHint`）只交
 * hint 那一档的候选。两种问法在真机上的差别从来没被量过——本文补上，而且顺手量了一个更要命的
 * 东西：**判它过不过闸门的那个 confidence，刻度是随选项数变的**（1 − H/log k），
 * 于是"2 选项、55/45"的正确答案拿到的 confidence 是 0.01 级，任何 0.25 的闸门都过不去。
 *
 * 三种问法（同一份 state 渲染、同一个 criteria 视图、同一个 shortlist 语义，全部走生产代码）：
 *   full    整个池子           —— 执行器在 hint 未命中时的实际问法
 *   tier    hint 最强非空档的候选 —— P1 `tieredHint` ON 的问法（`rules.hintCandidates`）
 *   hint    人写 hint 解析出的那个元素（先看人给的答案对不对，作为参照）
 *
 * 复算（真机需要网络与真模型产物；产物配方见审查文档 §7）：
 *   node --experimental-strip-types tools/ask-shapes.ts \
 *     --url '<结果页 URL>' --goal '<这一步的 desc>' --hint '<这一步的 target_hint>' \
 *     --expect '<正确答案 URL 里必然出现的子串>' --repeat 3
 *
 * 诚实边界：真机页面在两次访问之间会变（实测同一页同问题两次得到不同答案），
 * 所以 `--repeat` 的默认值是 3，输出**每一次**的结果与汇总，不写"平均分"。
 */
import { parseArgs } from "node:util";
import { isParseUsageError, usageErrorLine } from "../src/support/cli-args.ts";
import { chromium, type Page } from "playwright";
import * as browserEnv from "../src/browser/browser-env.ts";
import { BrowserMiddleware, type AnyPage, type PwLike } from "../src/engine/executor.ts";
import { extractElements, hintLookup, type Elem, type ElemPool } from "../src/engine/extraction.ts";
import { createLayaOnnxRuntime } from "../src/model/laya-onnx.ts";
import { installLayaRuntime } from "../src/model/model.ts";
import { checkArtifacts, missingPieces } from "../src/model/model-artifacts.ts";
import { hintCandidates, hintMatch } from "../src/engine/rules.ts";

const describeEl = (el: Elem | undefined): string =>
  el === undefined ? "(没答/无此元素)" : `${el.tag} "${el.label}"${el.href ? ` href=…${String(el.href).slice(-28)}` : ""}`;

const isRight = (el: Elem | undefined, expect: string | null): boolean | null => {
  if (el === undefined || expect === null) return null;
  return `${el.href ?? ""} ${el.label ?? ""}`.includes(expect);
};

async function main(argv: string[]): Promise<number> {
  let values;
  // 打错的参数 → 一行点名，绝不甩 parseArgs 的堆栈（src/support/cli-args.ts 的体例）。
  try {
    ({ values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      goal: { type: "string" },
      hint: { type: "string" },
      expect: { type: "string" },
      repeat: { type: "string", default: "3" },
      headful: { type: "boolean", default: false },
    },
  }));
  } catch (err) {
    if (!isParseUsageError(err)) throw err;
    console.error(usageErrorLine(err));
    return 2;
  }
  if (!values.url || !values.goal) {
    console.error("用法：ask-shapes.ts --url <页面> --goal <这一步的目标> [--hint <hint>] [--expect <子串>] [--repeat 3]");
    return 2;
  }
  const art = checkArtifacts();
  if (!art.ready) {
    console.error(`真模型不在（缺：${missingPieces(art).join(" / ")}）——这个工具只测真模型，缺产物时不猜、不退回脚本模型。`);
    return 2;
  }
  installLayaRuntime(createLayaOnnxRuntime({ onnxPath: art.onnxPath, tokenizerDir: art.tokenizerDir! }));

  const pw: PwLike = { chromium: chromium as unknown as PwLike["chromium"] };
  const browser = await browserEnv.launch(pw, !values.headful);
  const mw = new BrowserMiddleware({});
  const repeats = Math.max(1, Number(values.repeat) || 1);
  const log: string[] = [];

  try {
    for (let rep = 1; rep <= repeats; rep++) {
      const ctx = await (browser as unknown as {
        newContext(): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
      }).newContext();
      const page = await ctx.newPage();
      await page.goto(String(values.url), { waitUntil: "domcontentloaded", timeout: 45_000 });
      const elems: ElemPool = await extractElements(page as unknown as AnyPage);
      let hintText = "(未给 --hint)";
      let tierText = "(未给 --hint 或没有档内候选)";
      let tierRefs: string[] = [];
      if (values.hint) {
        // 与执行器同一条纪律：hint 在池子里没命中时按 DOM 回捞（预算挤出的元素要能找回来）
        if (hintMatch(String(values.hint), elems) === null) {
          for (const [ref, e] of Object.entries(await hintLookup(page as unknown as AnyPage, String(values.hint)))) elems[ref] = e;
        }
        const hitRef = hintMatch(String(values.hint), elems);
        const hitEl = hitRef === null ? undefined : elems[hitRef];
        const hitOk = isRight(hitEl, values.expect ?? null);
        hintText = `${describeEl(hitEl)}  ${hitOk === null ? "" : hitOk ? "✓" : "✗"}`;
        const cand = hintCandidates(String(values.hint), elems);
        tierRefs = cand?.decided === null ? cand.refs.slice() : [];
        tierText = cand === null ? "(规则层没命中：hint 的语法在这页上无解)"
          : cand.decided !== null ? `(档内唯一，已定：${describeEl(elems[cand.decided])})`
          : `档 tier=${cand.tier}，候选 ${cand.refs.length} 个`;
      }

      const t0 = Date.now();
      const [fullRef, fullConf, fullProbs] = await mw.pickElement(String(values.goal), page as unknown as AnyPage, elems, new Set(), null);
      const fullSecs = (Date.now() - t0) / 1000;
      const fullEl = fullRef ? elems[fullRef] : undefined;
      const fullVerdict = isRight(fullEl, values.expect ?? null);

      let tierLine = "   —（没有可窄问的档）";
      if (tierRefs.length > 1) {
        const subset: ElemPool = {};
        for (const r of tierRefs) if (elems[r]) subset[r] = elems[r]!;
        const t1 = Date.now();
        const [narrowRef, narrowConf, narrowProbs] = await mw.pickElement(
          String(values.goal), page as unknown as AnyPage, subset, new Set(), null);
        const secs = (Date.now() - t1) / 1000;
        const vals = Object.values(narrowProbs).sort((a, b) => b - a);
        const [top1 = 0, top2 = 0] = vals;
        const narrowed = narrowRef ? elems[narrowRef] : undefined;
        const nVerdict = isRight(narrowed, values.expect ?? null);
        tierLine = `   窄问(${Object.keys(subset).length} 条): ${describeEl(narrowed)}  conf=${narrowConf.toFixed(3)}`
          + ` ${nVerdict === null ? "" : nVerdict ? "✓ 对" : "✗ 错"}  p(top1)=${top1.toFixed(3)} p(top2)=${top2.toFixed(3)}`
          + ` margin=${(top1 - top2).toFixed(3)}  (${secs.toFixed(1)}s)`;
      }

      console.log(`\n== rep${rep}/${repeats}  池子=${Object.keys(elems).length}`);
      console.log(`   人写 hint : ${hintText}`);
      console.log(`   档内候选  : ${tierText}`);
      console.log(`   全池提问  : ${describeEl(fullEl)}  conf=${fullConf.toFixed(3)}`
        + ` ${fullVerdict === null ? "" : fullVerdict ? "✓ 对" : "✗ 错"}  (${fullSecs.toFixed(1)}s)`
        + `  选项数=${Object.keys(fullProbs).length}`);
      console.log(tierLine);
      log.push(`rep${rep}: full=${fullVerdict === null ? "?" : fullVerdict ? "对" : "错"}@${fullConf.toFixed(3)}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n汇总（不做"平均分"：真机每次都可能不同）：${log.join(" ｜ ")}`);
  return 0;
}

main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => {
  console.error(e);
  process.exit(1);
});

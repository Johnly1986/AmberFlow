/**
 * **W0：闸门该读哪个信号？**（`node --experimental-strip-types tools/gate-signals.ts [--in <json>]`）
 *
 * 它回答一个具体问题：在**同一份**逐题实测上，`confidence`（= 1 − H/log k）、
 * `pTop1`、`margin` 三个候选信号，谁更能区分"选对/选错"。
 *
 * 为什么要专门做这件事（而不是直接换信号）：
 * 1. 本轮横评（docs/DECISION_INTERFACE_SURVEY.md）发现 **laya 自己的温度标定就是按选项数分桶的**
 *    （`2 / 3-5 / 6-10 / 11+`），而我们的闸门拿**一个全局 floor** 跨桶比 ——
 *    两支 AUC 相反（passthrough 0.233 反向 / shortlist 0.587）很可能就是这么来的。
 *    所以比较必须**同时按桶分开做**，否则又会得出一个"平均出来的假数"。
 * 2. 本仓库早年测过 top-two margin 并**否掉了它**（CLAUDE.md 的 C3-R 条目：坏选中位 0.348 > 好选 0.263）。
 *    新插桩的数据要么调和这条，要么确认它——**不能装作没发生过**。
 *
 * 公平比较的口径：**同 coverage 比 precision**（不同采纳量比 precision 没有意义）。
 * 基准线 = 现状 `floor 0.25` 在该语料上的采纳量。
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (n: string): string | null => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const IN = argOf("--in") ?? "/tmp/model-contribution-w0.json";

interface Row {
  app: string; step: number; correct: boolean | null; conf: number;
  shortlisted: boolean; shape?: string; pool?: number;
  p_top1?: number | null; p_top2?: number | null; margin?: number | null;
}

const raw = JSON.parse(fs.readFileSync(path.resolve(IN), "utf-8")) as { rows?: Row[] };
const rows = (raw.rows ?? []).filter((r) => r.correct !== null) as Array<Row & { correct: boolean; options?: number | null }>;
if (!rows.length) { console.error(`没有可判的行：${IN}`); process.exit(1); }

/** laya 的标定桶（`common.py:temp_bucket`）：按**提问里的选项数**切，不是按池子大小切。 */
const bucketOfK = (k: number): string => k <= 2 ? "2" : k <= 5 ? "3-5" : k <= 10 ? "6-10" : "11+";
/**
 * 选项数从产物里**推**出来（旧产物没存这个字段）：
 *   - 短名单那一支：模型被重问的是保留子集，选项数 = k = 8；
 *   - passthrough：选项数 = 池子大小（≤8 才会走这一支）。
 * 直接拿 pool 分桶会把短名单的行错分到 "11+"——那正是"跨桶比标量"的同一种错误。
 * （新产物会直接落 `options`，这个推断只为兼容旧数据。）
 */
const optionsOf = (r: Row & { options?: number | null }): number =>
  r.options ?? (r.shortlisted ? 8 : Number(r.pool ?? 8));
const auc = (rs: Array<Row & { correct: boolean }>, pick: (r: Row) => number | null | undefined): number | null => {
  const v = rs.filter((r) => pick(r) !== null && pick(r) !== undefined);
  const P = v.filter((r) => r.correct), N = v.filter((r) => !r.correct);
  if (!P.length || !N.length) return null;
  let hit = 0, tot = 0;
  for (const a of P) for (const b of N) { tot++; hit += pick(a)! > pick(b)! ? 1 : pick(a)! === pick(b)! ? 0.5 : 0; }
  return Math.round((hit / tot) * 1000) / 1000;
};
/** 扫阈值到"至少采纳 target 步"的那一档，返回 {阈值, 采纳数, 对数, precision}。 */
const atCoverage = (rs: Array<Row & { correct: boolean }>, pick: (r: Row) => number | null | undefined, target: number) => {
  const v = rs.filter((r) => pick(r) !== null && pick(r) !== undefined)
    .sort((a, b) => (pick(b) ?? 0) - (pick(a) ?? 0));
  if (!v.length || target <= 0 || target > v.length) return null;
  const adopted = v.slice(0, target);
  const right = adopted.filter((r) => r.correct).length;
  return {
    threshold: pick(adopted[adopted.length - 1]!) ?? null,
    adopted: adopted.length, right,
    precision: Math.round((100 * right) / adopted.length * 10) / 10,
  };
};

const SIGNALS: Array<[string, (r: Row) => number | null | undefined]> = [
  ["confidence (1−H/log k)", (r) => r.conf],
  ["pTop1", (r) => r.p_top1],
  ["margin (pTop1−pTop2)", (r) => (r.p_top2 === null || r.p_top2 === undefined ? null : r.margin)],
];
// margin 只在"至少两个候选"时才有定义（单候选时 pickProposal 把 margin 记成 pTop1，
// 那不是分离度）。这里显式排除，并把这个决定打在输出里——静默混进去就是自欺。
const multi = rows.filter((r) => (r.p_top2 ?? null) !== null);

const base = atCoverage(rows, (r) => r.conf, rows.filter((r) => r.conf >= 0.25).length);
const cov = base?.adopted ?? 0;

console.log(`输入 ${IN}：可判 ${rows.length} 步（其中 ${multi.length} 步有两个以上候选 ⇒ margin 有定义）`);
console.log(`基准：现状 floor 0.25 采纳 ${cov} 步、对 ${base?.right ?? 0}（precision ${base?.precision ?? "-"}%）`);
console.log(`\n【一】全局 AUC（0.5 = 掷硬币；<0.5 = 方向反了）与同 coverage 的 precision`);
console.log("信号".padEnd(24), "AUC 全量".padEnd(10), `采纳 ${cov} 步时 precision`);
for (const [name, pick] of SIGNALS) {
  const pool = name.startsWith("margin") ? multi : rows;
  const a = auc(pool, pick);
  const t = atCoverage(pool, pick, Math.min(cov, pool.length));
  console.log(name.padEnd(22), String(a).padEnd(10),
    t ? `${t.precision}%（对 ${t.right}，阈值 ${t.threshold?.toFixed(3)}）` : "-");
}

console.log(`\n【二】按 laya 自己的标定桶分开看（这是关键：跨桶比标量本来就不公平）`);
console.log("桶(选项数)".padEnd(12), "步数".padEnd(7), "对".padEnd(5), ...SIGNALS.map((x) => x[0].padEnd(24)));
for (const b of ["2", "3-5", "6-10", "11+"]) {
  const rs = rows.filter((r) => bucketOfK(optionsOf(r)) === b);
  if (!rs.length) continue;
  const right = rs.filter((r) => r.correct).length;
  const cells = SIGNALS.map(([name, pick]) => {
    const pool = name.startsWith("margin") ? rs.filter((r) => (r.p_top2 ?? null) !== null) : rs;
    const a = auc(pool, pick);
    return `${a ?? "-"} (n=${pool.length})`.padEnd(24);
  });
  console.log(b.padEnd(12), String(rs.length).padEnd(7), String(right).padEnd(5), ...cells);
}

console.log(`\n【三】两支（passthrough / shortlist）各自的最佳信号`);
for (const sl of [false, true]) {
  const rs = rows.filter((r) => r.shortlisted === sl);
  const line = SIGNALS.map(([name, pick]) => {
    const pool = name.startsWith("margin") ? rs.filter((r) => (r.p_top2 ?? null) !== null) : rs;
    return `${name.split(" ")[0]} ${auc(pool, pick) ?? "-"}`;
  });
  console.log(`  ${(sl ? "shortlist(池>8)" : "passthrough(池≤8)").padEnd(20)} n=${String(rs.length).padStart(3)} ｜ ${line.join(" ｜ ")}`);
}

const verdict = {
  input: IN, judged: rows.length, margin_defined: multi.length,
  baseline_floor_025: base, signals: Object.fromEntries(SIGNALS.map(([name, pick]) => {
    const pool = name.startsWith("margin") ? multi : rows;
    return [name, {
      auc_all: auc(pool, pick),
      at_baseline_coverage: atCoverage(pool, pick, Math.min(cov, pool.length)),
      by_bucket: Object.fromEntries(["2", "3-5", "6-10", "11+"].map((b) => {
        const rs = pool.filter((r) => bucketOfK(optionsOf(r)) === b);
        return [b, { n: rs.length, auc: auc(rs, pick) }];
      })),
      by_branch: { passthrough: auc(rows.filter((r) => !r.shortlisted), pick), shortlist: auc(rows.filter((r) => r.shortlisted), pick) },
    }];
  })),
};
const outPath = argOf("--out") ?? "/tmp/gate-signals.json";
fs.writeFileSync(outPath, JSON.stringify(verdict, null, 2) + "\n");
console.log(`\n写出 ${outPath}`);

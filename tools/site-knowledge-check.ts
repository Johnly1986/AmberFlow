/**
 * 站点知识扫词门禁（W3-4，§9 #3 收口）：`src/**` 不得认识具体站点/业务字段。
 *
 * 口径（与 `src/data/datasource.ts` 头注释的自检声明一致）：
 *   - **剥注释**：整行 `//` 与块注释 `/* … *\/` 一律不参与扫描——注释里的历史实证/踩坑记录
 *     不是引擎机制（AGENTS 注释规约也要求历史进 CHANGELOG）；`file:line` 仍按原文件行号。
 *   - **保留字符串**：提示词/帮助文案里的站点名同样是"引擎认识站点"的证据，要能拦。
 *   - 词表是**闭集**：站点名 + 业务字段名（见 `SITE_WORDS` / `BUSINESS_WORDS`）。ASCII 词按
 *     词边界匹配（`price` 不会命中 `price_color`/`prices`）；中文按子串。
 *
 * 白名单：`WHITELIST` 逐条登记「文件 + 词 + 理由」，必须写明为什么这是必要例外；
 * 新增白名单请在评审中确认（本文件不提供 CLI 改白名单的入口，避免悄悄放行）。
 *
 * 用法：
 *   node --experimental-strip-types tools/site-knowledge-check.ts          # 扫描（命中 exit 1）
 *   ... --self-test                                                       # 合成负向自测（必红）
 *   ... --json                                                            # 机器可读
 *   ... --root <dir>                                                      # 指定仓库根（自测/A-B 用）
 *
 * 本工具是 `npm run check` 的候选成员（接线由 Lead 统一做，本批不改 package.json）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 站点/业务词闭集（小写 ASCII；中文直接子串）。新增站点前请先问：这是引擎该认识的吗？ */
export const SITE_WORDS: readonly string[] = [
  "ctrip", "携程", "trip.com", "qunar", "去哪儿", "taobao", "淘宝", "jd.com", "京东",
  "amazon", "12306", "火车票", "hotel", "酒店",
];

/** 业务字段名闭集：数据/报表机制不应该知道具体业务字段。 */
export const BUSINESS_WORDS: readonly string[] = [
  "flight_no", "airline", "dep_port", "arr_port", "cabin", "discount",
  "机票", "航班", "price",
];

/** 必要的例外（文件 + 词 + 理由）；文件路径用仓库相对正斜杠。 */
export const WHITELIST: ReadonlyArray<{ file: string; word: string; reason: string }> = [
  {
    file: "src/model/model-fetch.ts",
    word: "ctrip",
    reason: "模型获取的收尾提示用 ``--app ctrip-case`` 举例（用户可见文案，不是引擎机制）",
  },
  {
    file: "src/online/case.ts",
    word: "ctrip",
    reason: "旧复刻站目录的**禁止 URL 名单**（拒绝 file:/旧夹具路径的防御性常量，删了反而放松门禁）",
  },
  {
    file: "src/online/case.ts",
    word: "qunar",
    reason: "同上：旧复刻站目录的禁止 URL 名单",
  },
  {
    file: "src/cli/schema-gen.ts",
    word: "酒店",
    reason: "schema 契约台账的 statement 是**人读文档面**（逐字记录交付语义/示例），不是引擎机制；这里剥字符串会破坏台账自证",
  },
  {
    file: "src/cli/schema-gen.ts",
    word: "航班",
    reason: "同上：契约台账 statement 里的示例文案",
  },
  {
    file: "src/cli/schema-gen.ts",
    word: "price",
    reason: "同上：ctx.extract 示例里的字段名（文档示例，不是引擎默认值）",
  },
  {
    file: "src/engine/picker.ts",
    word: "discount",
    reason: "点选助手的通用电商 UI 词表（coupon/discount 英文交互词），与站点/业务字段无关",
  },
  {
    file: "src/model/page-context.ts",
    word: "price",
    reason: "模型输入的通用 affordance 计数启发式（货币符号/中文「元」/英文 price 词面），站点无关",
  },
];

export interface SiteKnowledgeViolation {
  /** 仓库相对路径（正斜杠）。 */
  file: string;
  /** 1-based 行号。 */
  line: number;
  /** 命中的词（闭集里的原写法）。 */
  word: string;
  /** 命中行原文（截断，便于定位）。 */
  text: string;
}

export interface ScannerOptions {
  /** 白名单（自测可注入）；默认 `WHITELIST`。 */
  whitelist?: ReadonlyArray<{ file: string; word: string; reason: string }>;
}

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * 剥注释但保留行号：块注释/行注释替换为空格，换行保留。
 * 字符串不特殊处理——口径是"保留字符串"（站点名在文案里同样算证据）。
 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    const next = i + 1 < n ? text[i + 1]! : "";
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function asciiWordRegex(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "i");
}

function isAscii(word: string): boolean {
  return /^[\x00-\x7F]+$/.test(word);
}

/** 扫描一份文件文本（`file` 只需仓库相对路径，用于白名单与输出）。 */
export function scanText(
  file: string,
  text: string,
  opts: ScannerOptions = {},
): SiteKnowledgeViolation[] {
  const whitelist = opts.whitelist ?? WHITELIST;
  const allowed = new Map<string, Set<string>>();
  for (const entry of whitelist) {
    if (entry.reason.trim() === "") continue;     // 无理由白名单 = 不生效
    const set = allowed.get(entry.file) ?? new Set<string>();
    set.add(entry.word);
    allowed.set(entry.file, set);
  }
  const words = [...SITE_WORDS, ...BUSINESS_WORDS];
  const matchers: Array<{ word: string; test: (line: string) => boolean }> = words.map((word) => ({
    word,
    test: isAscii(word)
      ? (line: string): boolean => asciiWordRegex(word).test(line)
      : (line: string): boolean => line.includes(word),
  }));
  const stripped = stripComments(text).split("\n");
  const rawLines = text.split("\n");
  const hits: SiteKnowledgeViolation[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i]!;
    if (line.trim() === "") continue;              // 纯注释/空行：剥完是空白
    if (COMMENT_LINE.test(rawLines[i] ?? "")) continue;
    for (const { word, test } of matchers) {
      if (!test(line)) continue;
      if (allowed.get(file)?.has(word) === true) continue;
      hits.push({ file, line: i + 1, word, text: rawLines[i]!.trim().slice(0, 160) });
    }
  }
  return hits;
}

function walkTs(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/node_modules|\.git|dist/.test(full)) continue;
      walkTs(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

/** 扫描 `<root>/src/**\/*.ts`（缺省 root = 仓库根）。 */
export function scanRepo(root: string, opts: ScannerOptions = {}): SiteKnowledgeViolation[] {
  const src = path.join(root, "src");
  const files: string[] = [];
  walkTs(src, files);
  const hits: SiteKnowledgeViolation[] = [];
  for (const abs of files.sort()) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    hits.push(...scanText(rel, fs.readFileSync(abs, "utf-8"), opts));
  }
  return hits;
}

/** 合成负向自测：词表/注释口径/白名单各至少一条必红断言。 */
export function selfTest(): string[] {
  const failures: string[] = [];
  const expect = (label: string, hits: SiteKnowledgeViolation[], word: string | null): void => {
    if (word === null) {
      if (hits.length > 0) failures.push(`${label}: 期望零命中，实际 ${hits.map((h) => h.word).join(",")}`);
      return;
    }
    if (!hits.some((h) => h.word === word)) failures.push(`${label}: 期望命中 ${word}，实际 ${hits.length} 条`);
  };
  expect("站点词（字符串）", scanText("src/x.ts", 'const site = "m.ctrip.com";'), "ctrip");
  expect("业务字段", scanText("src/x.ts", "if (row.flight_no) return row.price;"), "flight_no");
  expect("中文业务词", scanText("src/x.ts", 'const t = "机票报告";'), "机票");
  expect("注释剥离（块注释）", scanText("src/x.ts", "/* m.ctrip.com 实证 */\nconst x = 1;"), null);
  expect("注释剥离（行注释）", scanText("src/x.ts", "// 携程五轮取证\nconst x = 1;"), null);
  expect("词边界（price_color 不算 price）", scanText("src/x.ts", 'const sel = ".price_color";'), null);
  expect("白名单生效", scanText("src/x.ts", 'const s = "ctrip";', {
    whitelist: [{ file: "src/x.ts", word: "ctrip", reason: "自测" }],
  }), null);
  expect("白名单缺理由不生效", scanText("src/x.ts", 'const s = "ctrip";', {
    whitelist: [{ file: "src/x.ts", word: "ctrip", reason: " " }],
  }), "ctrip");
  expect("多行块注释保留行号", (() => {
    const hits = scanText("src/x.ts", "/* a\n b\n c */\nconst v = row.price;");
    return hits.length === 1 && hits[0]!.line === 4 ? hits : [];
  })(), "price");
  return failures;
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);

function rootArg(): string {
  const i = argv.indexOf("--root");
  if (i === -1) return REPO;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error("site-knowledge-check: --root 需要一个目录参数");
    process.exit(2);
  }
  return path.resolve(value);
}

if (has("--help")) {
  console.log("usage: node --experimental-strip-types tools/site-knowledge-check.ts [--self-test] [--json] [--root <dir>]");
  process.exit(0);
}
if (has("--self-test")) {
  const failures = selfTest();
  if (failures.length > 0) {
    for (const f of failures) console.error(`site-knowledge-check --self-test: ${f}`);
    console.error(`site-knowledge-check --self-test: FAIL（${failures.length} 条）`);
    process.exit(1);
  }
  console.log(`site-knowledge-check --self-test: OK（词表 ${SITE_WORDS.length + BUSINESS_WORDS.length} 词 / 白名单 ${WHITELIST.length} 条 / 断言 9 条）`);
  process.exit(0);
}
const hits = scanRepo(rootArg());
if (has("--json")) {
  console.log(JSON.stringify({ ok: hits.length === 0, hits, whitelist: WHITELIST.length }, null, 2));
} else if (hits.length === 0) {
  console.log(`site-knowledge-check: OK（src/**/*.ts 零命中；词表 ${SITE_WORDS.length + BUSINESS_WORDS.length} 词，白名单 ${WHITELIST.length} 条）`);
} else {
  for (const h of hits) console.error(`${h.file}:${h.line} 命中站点/业务词 "${h.word}" —— ${h.text}`);
  console.error(`site-knowledge-check: FAIL（${hits.length} 处命中；引擎不得认识具体站点/业务字段，`
    + "站点知识放数据源/应用配置；确需例外请登记 WHITELIST 并写理由）");
}
process.exit(hits.length === 0 ? 0 : 1);

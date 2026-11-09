/**
 * **静态声明收集器**（dry 分支覆盖①）：扫描 flow 应用源码，枚举**全部** `ctx.*` 声明调用点。
 *
 * 为什么需要它：dry（`amber apps check`）只校验"实际执行的调用序列"——分支内（if/for 守卫
 * 未走到）的声明形状从不被校验。真实事故（gmap-probe1）：分支里的空字符串 hint / 空操作数
 * 信号（`css_exists_text` 空操作数）直到真跑才炸。本模块让"声明在源码里出现过"本身成为
 * check 的覆盖对象——**静态 lint，不是 dry 模拟**（架构师已否决 --unroll 模拟方案）。
 *
 * 实现纪律：
 *   - **只读复用**：hint/信号的"是什么形状"仍由既有唯一出处回答（task-2 校验器复用
 *     `parseHint` / `validateSignalSpec`）；本模块只回答"源码里有哪些声明调用点、它们的
 *     静态可求值形状是什么"。构造器求值逐字镜像 `kit.ts`（同一份形状语义，两处实现靠
 *     本注释对齐——kit 改了这里必须跟着改，否则收集到的形状会漂移）。
 *   - **不强解**：变量 / 带插值的模板串 / 函数调用结果等非字面量表达式标记 dynamic
 *     （弱标记洞，嵌在静态树里），校验器只跳过、只计数，绝不猜值。
 *   - **零依赖**：手写词法器（注释/字符串/模板/正则都正确跳过——S3 先例用正则剥注释只防了
 *     注释，防不了字符串里的 `ctx.expand(` 字样；这里词法层天然免疫），不新增 npm 依赖，
 *     运行时不 import `typescript`（它是 devDependency，src 无运行时先例）。
 *   - **纯函数**：不碰 fs、不开浏览器、不改任何运行时行为；接线前的 check 输出逐字节不变。
 *
 * 已知限制（如实记录，不静默）：接收方别名（`const j = ctx.judge; j.exists(...)`）不解析，
 * 该调用点收不到——这类调用点对 dry 执行路径仍被既有校验覆盖；本模块只增覆盖，不减。
 */

import { loginWallSignal } from "../engine/signals.ts";

/* ------------------------------------------------------------------ 数据形状 */

/**
 * dynamic 洞的弱标记键（极难撞名的字面键，不用 Symbol 以便摘要/调试可直接序列化）。
 * 洞只表示"此处不可静态求值"，绝不携带猜测值；校验器遇到洞 = 跳过并计数。
 */
const DYNAMIC_KEY = "__amberflow_dynamic" as const;

export interface DynamicHole {
  readonly [DYNAMIC_KEY]: string; // 人话原因：为什么求不了值
}

export function isDynamicHole(v: unknown): v is DynamicHole {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    && DYNAMIC_KEY in v
    && typeof (v as Record<string, unknown>)[DYNAMIC_KEY] === "string";
}

/** 声明族的分类（task-2 校验器按族选择既有校验器）。 */
export type DeclCallKind =
  | "step"        // ctx.step —— done/when/act 声明位
  | "arrive"      // ctx.arrive —— done 声明位
  | "manual"      // ctx.manual —— done 声明位（人工步）
  | "nav"         // ctx.open / ctx.openPage / ctx.switchTab —— 导航声明
  | "target"      // ctx.hint / ctx.hints —— 目标声明
  | "signal"      // ctx.judge.* / ctx.waitFor / ctx.holds —— 信号声明
  | "command"     // ctx.command —— 命令闭集的一项
  | "value"       // ctx.value.* —— 值绑定构造器
  | "tool-signal" // ctx.tool.* —— 工具信号构造器
  | "primitive"   // ctx.scrollList / expand / setRange / collect —— A3/S3 原语声明
  | "tool";       // ctx.run / ctx.dangerous —— 工具步声明

export interface DeclArgSite {
  /** 第几个实参（0 起）。 */
  index: number;
  /** true = 整棵树静态可求值（无洞）；false = 含洞或整体不可求值。 */
  static: boolean;
  /** 静态值（洞占位不可求值子树）；static=false 时仍可能有部分静态内容。 */
  value: unknown;
  /** 人话摘要（日志/报告直接可贴）。 */
  summary: string;
}

export interface DeclSite {
  /** 规范调用名：`ctx.step` / `ctx.judge.exists` / `ctx.value.slot` … */
  call: string;
  kind: DeclCallKind;
  /** 调用起点（`ctx` 词元）的 1-based 行/列。 */
  line: number;
  col: number;
  args: DeclArgSite[];
}

export interface DeclarationScan {
  /** 归入已知声明族的调用点（含嵌套调用点，按源码出现序）。 */
  sites: DeclSite[];
  /** 源码中发现的全部 `ctx.` 成员调用数（含观察类未入族调用——扫描覆盖面对账用）。 */
  ctxCallCount: number;
  /** 词法层降级记录（未终结字符串/模板/正则回退等；正常脚本应为空）。 */
  lexNotes: string[];
}

/* ------------------------------------------------------------------ 词法器 */

type TokType = "ident" | "num" | "str" | "template" | "punct" | "regex";

interface TemplatePart {
  kind: "str" | "expr";
  value?: string;  // str 段的 cooked 文本
  toks?: Tok[];    // expr 段的内嵌词元流
}

interface Tok {
  type: TokType;
  value: string;
  line: number;
  col: number;
  /** template 专属：cooked 段与插值段。 */
  parts?: TemplatePart[];
}

/** 其后可跟正则字面量的标识符（其余标识符后跟 `/` 是除法）。 */
const REGEX_ALLOWED_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await",
]);

const KEYWORDS = new Set([...REGEX_ALLOWED_KEYWORDS]);

const PUNCT3 = ["...", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??="];
const PUNCT2 = ["?.", "??", "=>", "==", "!=", "<=", ">=", "&&", "||", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

class Lexer {
  private i = 0;
  private line = 1;
  private col = 1;
  private prev: Tok | null = null;
  readonly notes: string[] = [];
  // strip-types 运行模式不支持参数属性（ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）——src 约定显式赋值。
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  /** 主入口：词法到 EOF（或可选地停在未消费的 `}`——模板插值段用）。 */
  readTokens(stopAtBrace = false): Tok[] {
    const out: Tok[] = [];
    let braceDepth = 0;
    for (;;) {
      this.skipTrivia();
      if (this.i >= this.src.length) return out;
      const c = this.src[this.i]!;
      if (stopAtBrace && braceDepth === 0 && c === "}") return out; // 插值段收口，不消费
      const t = this.readToken(c);
      if (t.type === "punct") {
        if (t.value === "{") braceDepth++;
        else if (t.value === "}") braceDepth--;
      }
      out.push(t);
      this.prev = t;
    }
  }

  /** 跳过空白与注释（行号照常推进——注释里的 `ctx.done()` 字样绝不入族）。 */
  private skipTrivia(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === " " || c === "\t" || c === "\r") { this.i++; this.col++; continue; }
      if (c === "\n") { this.i++; this.line++; this.col = 1; continue; }
      if (c === "/" && this.src[this.i + 1] === "/") {
        while (this.i < this.src.length && this.src[this.i] !== "\n") { this.i++; this.col++; }
        continue;
      }
      if (c === "/" && this.src[this.i + 1] === "*") {
        this.i += 2; this.col += 2;
        while (this.i < this.src.length && !(this.src[this.i] === "*" && this.src[this.i + 1] === "/")) {
          if (this.src[this.i] === "\n") { this.line++; this.col = 1; } else this.col++;
          this.i++;
        }
        this.i += 2; this.col += 2;
        continue;
      }
      return;
    }
  }

  private readToken(c: string): Tok {
    const line = this.line, col = this.col;
    if (isIdentStart(c)) {
      let j = this.i + 1;
      while (j < this.src.length && isIdentChar(this.src[j]!)) j++;
      const value = this.src.slice(this.i, j);
      this.i = j; this.col += value.length;
      return { type: "ident", value, line, col };
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(this.src[this.i + 1] ?? ""))) {
      return this.readNumber(line, col);
    }
    if (c === "'" || c === "\"") return this.readString(c, line, col);
    if (c === "`") return this.readTemplate(line, col);
    if (c === "/") {
      if (this.canPrecedeRegex()) return this.readRegex(line, col);
      this.i++; this.col++;
      return { type: "punct", value: "/", line, col };
    }
    const three = this.src.slice(this.i, this.i + 3);
    if (PUNCT3.includes(three)) { this.i += 3; this.col += 3; return { type: "punct", value: three, line, col }; }
    const two = this.src.slice(this.i, this.i + 2);
    if (PUNCT2.includes(two)) { this.i += 2; this.col += 2; return { type: "punct", value: two, line, col }; }
    this.i++; this.col++;
    return { type: "punct", value: c, line, col };
  }

  private readNumber(line: number, col: number): Tok {
    let j = this.i;
    const src = this.src;
    if (src[j] === "0" && /[xXbBoO]/.test(src[j + 1] ?? "")) {
      j += 2;
      while (j < src.length && /[0-9a-fA-F_]/.test(src[j]!)) j++;
    } else {
      while (j < src.length && /[0-9_]/.test(src[j]!)) j++;
      if (src[j] === ".") {
        j++;
        while (j < src.length && /[0-9_]/.test(src[j]!)) j++;
      }
      if (/[eE]/.test(src[j] ?? "")) {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k++;
        if (/[0-9]/.test(src[k] ?? "")) {
          j = k;
          while (j < src.length && /[0-9_]/.test(src[j]!)) j++;
        }
      }
    }
    const value = src.slice(this.i, j);
    this.i = j; this.col += value.length;
    return { type: "num", value, line, col };
  }

  private readString(quote: string, line: number, col: number): Tok {
    this.i++; this.col++;
    let value = "";
    for (;;) {
      if (this.i >= this.src.length || this.src[this.i] === "\n") {
        this.notes.push(`line ${line}: unterminated string literal`);
        break;
      }
      const ch = this.src[this.i]!;
      if (ch === "\\") {
        const nx = this.src[this.i + 1] ?? "";
        if (nx === "\n") { this.line++; this.col = 1; this.i += 2; value += "\n"; continue; }
        value += unescapeChar(nx);
        this.i += 2; this.col += 2;
        continue;
      }
      if (ch === quote) { this.i++; this.col++; break; }
      value += ch; this.i++; this.col++;
    }
    return { type: "str", value, line, col };
  }

  private canPrecedeRegex(): boolean {
    const p = this.prev;
    if (p === null) return true;
    if (p.type === "punct") return !(")]}".includes(p.value) || p.value === "++" || p.value === "--");
    if (p.type === "ident") return REGEX_ALLOWED_KEYWORDS.has(p.value);
    return false; // num/str/template/regex 之后是除法
  }

  /** 正则字面量：`/…/flags`；换行前没闭合 = 误判，回吐为除法（安全阀）。 */
  private readRegex(line: number, col: number): Tok {
    const startI = this.i, startCol = this.col;
    this.i++; this.col++;
    let inClass = false;
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === "\\") { this.i += 2; this.col += 2; continue; }
      if (ch === "\n") {
        // 误判回退：这不是正则，是除法。行号未推进过，直接回退游标按除法重读。
        this.i = startI + 1; this.col = startCol + 1;
        return { type: "punct", value: "/", line, col };
      }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        this.i++; this.col++;
        while (this.i < this.src.length && /[a-z]/.test(this.src[this.i]!)) { this.i++; this.col++; }
        return { type: "regex", value: "", line, col };
      }
      this.i++; this.col++;
    }
    this.notes.push(`line ${line}: unterminated regex`);
    return { type: "regex", value: "", line, col };
  }

  /** 模板串：cooked 段 + `${…}` 插值段（插值段递归词法，`}` 由 readTokens(stopAtBrace) 收口）。 */
  private readTemplate(line: number, col: number): Tok {
    this.i++; this.col++; // 背引号
    const parts: TemplatePart[] = [];
    let cooked = "";
    for (;;) {
      if (this.i >= this.src.length || this.src[this.i] === "\n") {
        this.notes.push(`line ${line}: unterminated template literal`);
        break;
      }
      const ch = this.src[this.i]!;
      if (ch === "\\") {
        const nx = this.src[this.i + 1] ?? "";
        if (nx === "\n") { this.line++; this.col = 1; this.i += 2; cooked += "\n"; continue; }
        cooked += unescapeChar(nx);
        this.i += 2; this.col += 2;
        continue;
      }
      if (ch === "`") { this.i++; this.col++; break; }
      if (ch === "$" && this.src[this.i + 1] === "{") {
        if (cooked) { parts.push({ kind: "str", value: cooked }); cooked = ""; }
        this.i += 2; this.col += 2;
        const inner = this.readTokens(true);
        parts.push({ kind: "expr", toks: inner });
        if (this.src[this.i] === "}") { this.i++; this.col++; } // 插值段收口
        continue;
      }
      cooked += ch; this.i++; this.col++;
    }
    if (cooked || parts.length === 0) parts.push({ kind: "str", value: cooked });
    return { type: "template", value: "", line, col, parts };
  }
}

function unescapeChar(c: string): string {
  switch (c) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case "b": return "\b";
    case "f": return "\f";
    case "v": return "\v";
    case "0": return "\0";
    case "\n": return "";   // 行续接
    case "": return "";
    default: return c;      // \' \" \\ \` 与未知转义按字面
  }
}

function tokenize(src: string): { toks: Tok[]; notes: string[] } {
  const lx = new Lexer(src);
  return { toks: lx.readTokens(), notes: lx.notes };
}

/* ------------------------------------------------------------------ 调用点匹配 */

/** 单级方法 → 族（`ctx.<name>(`）。观察类（read/observe/log/…）不在表内 = 不入族，只计数。 */
const SINGLE_METHODS: Record<string, DeclCallKind> = {
  step: "step",
  arrive: "arrive",
  manual: "manual",
  open: "nav",
  openPage: "nav",
  switchTab: "nav",
  hint: "target",
  hints: "target",
  command: "command",
  waitFor: "signal",
  holds: "signal",
  scrollList: "primitive",
  expand: "primitive",
  setRange: "primitive",
  collect: "primitive",
  run: "tool",
  dangerous: "tool",
};

/** 二级接收方 → 族（`ctx.<recv>.<method>(`）。未知 method 也入族（收形状，校验器再裁）。 */
const NESTED_RECEIVERS: Record<string, DeclCallKind> = {
  judge: "signal",
  value: "value",
  tool: "tool-signal",
};

interface CallMatch {
  /** 规范调用名（入族时）：`ctx.step` / `ctx.judge.exists` …；未入族为 null。 */
  call: string | null;
  kind: DeclCallKind | null;
  /** 实参开括号词元下标（调用形状成立才有）。 */
  argsOpen: number;
}

/**
 * 从 `toks[i]` 起识别 `ctx (.|?.) path… (`。
 * 守卫：前一个显著词元是 `.` ⇒ 这是 `obj.ctx.step` 的属性访问，不是 flow 的 ctx。
 * 任何能走通的 `ctx.x(` / `ctx.x.y(` 都返回计数用匹配；kind=null = 观察类，不入族。
 */
function matchCall(toks: Tok[], i: number): CallMatch | null {
  const t0 = toks[i];
  if (t0 === undefined || t0.type !== "ident" || t0.value !== "ctx") return null;
  const prev = i > 0 ? toks[i - 1] : undefined;
  if (prev !== undefined && prev.type === "punct" && (prev.value === "." || prev.value === "?.")) return null;
  let j = i + 1;
  const path: string[] = [];
  for (;;) {
    const dot = toks[j];
    if (dot === undefined || dot.type !== "punct" || (dot.value !== "." && dot.value !== "?.") ) return null;
    const name = toks[j + 1];
    if (name === undefined || name.type !== "ident") return null;
    path.push(name.value);
    j += 2;
    const nx = toks[j];
    if (nx !== undefined && nx.type === "punct" && (nx.value === "." || nx.value === "?.") && path.length < 2) continue;
    break;
  }
  const open = toks[j];
  if (open === undefined || open.type !== "punct" || open.value !== "(") return null;
  if (path.length === 1) {
    const kind = SINGLE_METHODS[path[0]!];
    return kind === undefined
      ? { call: null, kind: null, argsOpen: j }
      : { call: `ctx.${path[0]}`, kind, argsOpen: j };
  }
  if (path.length === 2) {
    const kind = NESTED_RECEIVERS[path[0]!];
    return kind === undefined
      ? { call: null, kind: null, argsOpen: j }
      : { call: `ctx.${path[0]}.${path[1]}`, kind, argsOpen: j };
  }
  return { call: null, kind: null, argsOpen: j };
}

/** 找配对闭括号下标（词元层；模板是原子词元，插值内的括号不影响深度）。 */
function matchParen(toks: Tok[], openIdx: number): number | null {
  const open = toks[openIdx]!;
  const closeCh = open.value === "(" ? ")" : open.value === "[" ? "]" : "}";
  let depth = 0;
  for (let k = openIdx; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.type !== "punct") continue;
    if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
    else if (t.value === ")" || t.value === "]" || t.value === "}") {
      depth--;
      if (depth === 0 && t.value === closeCh) return k;
    }
  }
  return null;
}

/** 按顶层逗号切段（尾逗号容忍）；返回每段的 [start,end) 词元下标。openIdx 指向 `(` `[` `{`。 */
function splitArgs(toks: Tok[], openIdx: number, closeIdx: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0, segStart = openIdx + 1;
  for (let k = openIdx + 1; k < closeIdx; k++) {
    const t = toks[k]!;
    if (t.type !== "punct") continue;
    if (t.value === "(" || t.value === "[" || t.value === "{") depth++;
    else if (t.value === ")" || t.value === "]" || t.value === "}") depth--;
    else if (t.value === "," && depth === 0) {
      out.push([segStart, k]);
      segStart = k + 1;
    }
  }
  if (segStart < closeIdx) out.push([segStart, closeIdx]);
  return out.filter(([a, b]) => a < b);
}

/* ------------------------------------------------------------------ 静态求值器（镜像 kit.ts 的纯构造器语义） */

/** 洞工厂：不可求值就打洞，绝不猜值。 */
function hole(reason: string): DynamicHole {
  return { [DYNAMIC_KEY]: reason };
}

const CONST_IDENTS: Record<string, unknown> = {
  undefined: undefined,
  Infinity: Infinity,
  NaN: NaN,
};

class Evaluator {
  private readonly toks: Tok[];

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  /**
   * 求值词元切片 [a,b)。返回静态值或洞（洞也可能嵌在对象/数组里——部分静态）。
   * 不抛：任何吃不透的形状都降级为洞（保守 = 不产生假问题）。
   */
  evalRange(a: number, b: number): unknown {
    if (a >= b) return hole("empty expression");
    try {
      return this.evalPrimary(a, b);
    } catch {
      return hole("unsupported expression");
    }
  }

  private evalPrimary(a: number, b: number): unknown {
    const toks = this.toks;
    const t = toks[a]!;
    if (a + 1 === b) {
      switch (t.type) {
        case "str": return t.value;
        case "num": return Number(t.value.replace(/_/g, ""));
        case "template": return this.evalTemplate(t);
        case "ident": {
          if (t.value === "true") return true;
          if (t.value === "false") return false;
          if (t.value === "null") return null;
          if (t.value in CONST_IDENTS) return CONST_IDENTS[t.value]!;
          return hole(`identifier ${t.value}`);
        }
        default: return hole(`${t.type} ${t.value}`.trim());
      }
    }
    // 一元 +/- 数字
    if (t.type === "punct" && (t.value === "-" || t.value === "+") && a + 2 === b
      && toks[a + 1]!.type === "num") {
      const n = Number(toks[a + 1]!.value.replace(/_/g, ""));
      return t.value === "-" ? -n : n;
    }
    // 括号表达式
    if (t.type === "punct" && t.value === "(") {
      const close = matchParen(toks, a);
      if (close !== null && this.endsInCast(close, b)) return this.evalRange(a + 1, close);
      if (close === b - 1) return this.evalRange(a + 1, close);
      return hole("parenthesized sequence");
    }
    // 这些关键字打头的表达式不做静态求值（保守降级）
    if (t.type === "ident" && ["await", "new", "typeof", "function", "async"].includes(t.value)) {
      return hole(`${t.value} expression`);
    }
    // ctx 构造器调用（嵌在实参/对象字面量里也走这里）
    const ctor = matchCall(toks, a);
    if (ctor !== null && ctor.kind !== null) {
      const close = matchParen(toks, ctor.argsOpen);
      if (close === b - 1) return this.evalCtorCall(ctor.call!, ctor.argsOpen, close);
    }
    // 数组字面量
    if (t.type === "punct" && t.value === "[") {
      const close = matchParen(toks, a);
      if (close !== null && this.endsInCast(close, b)) return this.evalArray(a + 1, close);
      if (close === b - 1) return this.evalArray(a + 1, close);
    }
    // 对象字面量（`{…} as T` / `satisfies T` 尾巴剥掉后照常求值——TS 应用的 done 树不被断言埋掉）
    if (t.type === "punct" && t.value === "{") {
      const close = matchParen(toks, a);
      if (close !== null && this.endsInCast(close, b)) return this.evalObject(a + 1, close);
      if (close === b - 1) return this.evalObject(a + 1, close);
    }
    // 标识符打头：函数调用 / 成员链 / TS cast / 裸标识符
    if (t.type === "ident") {
      for (let k = a + 1; k < b; k++) {
        const tk = toks[k]!;
        if (tk.type === "ident" && (tk.value === "as" || tk.value === "satisfies")) {
          return hole(`TS ${tk.value} expression`);
        }
      }
      const t1 = toks[a + 1]!;
      if (t1.type === "punct" && t1.value === "(") return hole(`call ${t.value}()`);
      if (t1.type === "punct" && (t1.value === "." || t1.value === "?.") ) {
        return hole(`member ${t.value}.${toks[a + 2]?.value ?? "…"}`);
      }
      return hole(`identifier ${t.value}`);
    }
    return hole(`${t.type} ${t.value}`.trim());
  }

  /** 切片在 primary 闭点之后是否只剩 TS 断言尾巴（`as T` / `satisfies T`，含 `as const`）。 */
  private endsInCast(close: number, b: number): boolean {
    if (close + 2 > b) return false;
    const kw = this.toks[close + 1]!;
    return kw.type === "ident" && (kw.value === "as" || kw.value === "satisfies");
  }

  private evalTemplate(t: Tok): unknown {
    const parts = t.parts ?? [];
    const hasExpr = parts.some((p) => p.kind === "expr");
    if (!hasExpr) return parts.map((p) => p.value ?? "").join("");
    // 任务口径：带插值的模板串标记 dynamic，不强解（插值里的 ctx 调用点由线性扫描单独收）。
    return hole("template literal with substitution");
  }

  private evalArray(a: number, b: number): unknown {
    const toks = this.toks;
    for (let k = a; k < b; k++) {
      const t = toks[k]!;
      if (t.type === "punct" && t.value === "...") return hole("array spread");
    }
    return splitArgs(toks, a - 1, b).map(([s, e]) => this.evalRange(s, e));
  }

  private evalObject(a: number, b: number): unknown {
    const toks = this.toks;
    const out: Record<string, unknown> = {};
    const entries: Array<{ key: string | null; range: [number, number] }> = [];
    let depth = 0;
    let keyStart = a;
    let curKey: string | null = null;
    let afterColon = -1;
    for (let k = a; k <= b; k++) {
      const atEnd = k === b;
      const t = atEnd ? undefined : toks[k]!;
      if (!atEnd && t!.type === "punct") {
        if (t!.value === "(" || t!.value === "[" || t!.value === "{") depth++;
        else if (t!.value === ")" || t!.value === "]" || t!.value === "}") depth--;
      }
      const isTopPunct = !atEnd && t!.type === "punct" && depth === 0;
      const segEnd = atEnd ? b : k;
      if (atEnd || (isTopPunct && t!.value === ",")) {
        if (afterColon >= 0) entries.push({ key: curKey, range: [afterColon, segEnd] });
        else if (keyStart < segEnd) {
          // 简写属性 / 展开 / 方法——整体降级为洞（不知道值，绝不猜）
          entries.push({ key: null, range: [keyStart, segEnd] });
        }
        keyStart = segEnd + 1;
        curKey = null;
        afterColon = -1;
        continue;
      }
      if (isTopPunct && t!.value === ":" && curKey === null) {
        const kt = toks[keyStart]!;
        curKey = kt.type === "str" || kt.type === "num"
          ? String(kt.value)
          : kt.type === "ident" ? kt.value : null;
        afterColon = k + 1;
      }
    }
    for (const en of entries) {
      if (en.key === null) {
        const t0 = toks[en.range[0]]!;
        const why = t0.type === "punct" && t0.value === "..." ? "object spread" : "object entry (shorthand/method)";
        return hole(why);
      }
      out[en.key] = this.evalRange(en.range[0], en.range[1]);
    }
    return out;
  }

  /** `ctx.*` 构造器调用的静态求值——逐字镜像 kit.ts（形状语义的唯一旁证是 kit 本体）。 */
  private evalCtorCall(call: string, argsOpen: number, closeIdx: number): unknown {
    const segs = splitArgs(this.toks, argsOpen, closeIdx);
    const evaled = segs.map(([s, e]) => this.evalRange(s, e));
    const arg = (n: number): unknown => (n < evaled.length ? evaled[n] : hole(`missing argument ${n}`));
    const parts = call.split(".");
    if (parts[1] === "judge") {
      switch (parts[2]) {
        case "url": return { url_contains: arg(0) };
        case "exists": {
          const opts = evaled[1];
          if (opts !== undefined && hasHole(opts)) {
            return hole("ctx.judge.exists 的 opts 不可静态求值（visible 与否决定算子形状）");
          }
          const visible = isObj(opts) && opts["visible"] === true;
          return visible ? { css_visible_exists: arg(0) } : { css_exists: arg(0) };
        }
        case "existsText": return { css_exists_text: [arg(0), arg(1)] };
        case "text": return { css_text_contains: [arg(0), arg(1)] };
        case "equals": return { css_text_equals: [arg(0), arg(1)] };
        case "value": return { css_value_equals: [arg(0), arg(1)] };
        case "all": return { all_of: evaled };
        case "any": return { any_of: evaled };
        case "not": return { not: arg(0) };
        case "manual": return { manual: arg(0) };
        case "loginWall": return hasHole(evaled) ? hole("loginWall args") : loginWallSignal();
        default: return hole(`ctx.judge.${String(parts[2])} 不是已知构造器`);
      }
    }
    if (parts[1] === "value") {
      switch (parts[2]) {
        case "literal": return { literal: arg(0) };
        case "slot": return { from: "slot", key: arg(0) };
        case "option": {
          const match = evaled[1];
          if (match !== undefined && hasHole(match)) return hole("ctx.value.option 的 match 不可静态求值");
          return { from: "option", key: arg(0), match };
        }
        case "list": {
          const order = evaled[1];
          if (order !== undefined && hasHole(order)) return hole("ctx.value.list 的 order 不可静态求值");
          return { from: "list", by: arg(0), order };
        }
        default: return hole(`ctx.value.${String(parts[2])} 不是已知构造器`);
      }
    }
    if (parts[1] === "tool") {
      switch (parts[2]) {
        case "exitOk": return { exit_ok: evaled.length ? evaled[0] : true };
        case "exitCode": return { exit_code_equals: arg(0) };
        case "stdoutContains": return { stdout_contains: arg(0) };
        case "stdoutMatches": return { stdout_matches: arg(0) };
        case "stderrContains": return { stderr_contains: arg(0) };
        case "jsonPath": return { json_path_equals: [arg(0), arg(1)] };
        case "fileExists": return { file_exists: arg(0) };
        case "fileAbsent": return { file_absent: arg(0) };
        case "all": return { all_of: evaled };
        case "any": return { any_of: evaled };
        case "not": return { not: arg(0) };
        default: return hole(`ctx.tool.${String(parts[2])} 不是已知构造器`);
      }
    }
    if (call === "ctx.hint") return { kind: "hint", hint: arg(0) };
    if (call === "ctx.hints") return { kind: "hints", hints: evaled };
    if (call === "ctx.command") {
      const op = arg(0);
      const target = evaled[1];
      const valueArg = evaled[2];
      const id = evaled[3];
      // kit.command 的 isTo 口径：单键且键为字符串 `to` ⇒ scroll 方向，不是值绑定。
      let to: unknown;
      let valueBinding: unknown;
      if (isObj(valueArg) && Object.keys(valueArg).length === 1 && typeof valueArg["to"] === "string") {
        to = valueArg["to"];
      } else if (valueArg !== undefined) {
        valueBinding = valueArg;
      }
      return {
        op,
        ...(target === undefined ? {} : { target }),
        ...(valueBinding === undefined ? {} : { value: valueBinding }),
        ...(to === undefined ? {} : { to }),
        ...(id === undefined ? {} : { id }),
      };
    }
    return hole(`${call} 不是可静态求值的构造器`);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 树里是否含洞（含 = 该实参整体按"非全静态"口径上报）。 */
export function hasHole(v: unknown): boolean {
  if (isDynamicHole(v)) return true;
  if (Array.isArray(v)) return v.some(hasHole);
  if (isObj(v)) return Object.values(v).some(hasHole);
  return false;
}

/* ------------------------------------------------------------------ 摘要 */

const SUMMARY_LIMIT = 120;

/** 摘要渲染：洞显示为 ⟨dynamic: 原因⟩，长值截断（只做人话摘要，不做数据源）。 */
export function summarizeValue(v: unknown, depth = 0): string {
  if (isDynamicHole(v)) return `⟨dynamic: ${v[DYNAMIC_KEY]}⟩`;
  if (typeof v === "string") return clip(JSON.stringify(v), SUMMARY_LIMIT);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) {
    if (depth > 2) return "[…]";
    return clip(`[${v.map((x) => summarizeValue(x, depth + 1)).join(", ")}]`, SUMMARY_LIMIT);
  }
  if (isObj(v)) {
    if (depth > 2) return "{…}";
    return clip(`{${Object.entries(v).map(([k, x]) => `${k}: ${summarizeValue(x, depth + 1)}`).join(", ")}}`,
      SUMMARY_LIMIT);
  }
  return clip(JSON.stringify(v) ?? "?", SUMMARY_LIMIT);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ 主入口 */

/**
 * 扫描 flow 应用源码，产出全部静态可发现的 ctx 声明调用点。
 * 纯函数：`appsCheck` 接线时用 `loaded.sourceText` 直接喂（与 scriptSha256 同一份字节）。
 */
export function scanDeclarations(sourceText: string): DeclarationScan {
  const { toks, notes } = tokenize(sourceText);
  const sites: DeclSite[] = [];
  let ctxCallCount = 0;
  const ev = new Evaluator(toks);

  const walk = (list: Tok[]): void => {
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      if (t.type === "template") {
        for (const p of t.parts ?? []) if (p.kind === "expr" && p.toks) walk(p.toks);
        continue;
      }
      if (t.type !== "ident" || t.value !== "ctx") continue;
      const m = matchCall(list, i);
      if (m === null) continue;
      ctxCallCount++;
      if (m.kind === null) continue; // 观察类调用（read/observe/log/…）：计数，不入族
      const close = matchParen(list, m.argsOpen);
      if (close === null) continue; // 括号不配对：加载期 import 会报语法错误，这里不硬猜
      const args: DeclArgSite[] = splitArgs(list, m.argsOpen, close).map(([s, e], idx) => {
        const value = ev.evalRange(s, e);
        return {
          index: idx,
          static: !hasHole(value),
          value,
          summary: summarizeValue(value),
        };
      });
      sites.push({ call: m.call!, kind: m.kind, line: t.line, col: t.col, args });
    }
  };
  walk(toks);
  return { sites, ctxCallCount, lexNotes: notes };
}

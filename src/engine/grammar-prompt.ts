/**
 * hint / 信号语法**描述**的唯一出处（提示词面）——对齐「命令表唯一出处是 registry.ts」
 * 的同一条纪律：语法描述不许在任何面手抄。
 *
 * 两个事实来源在这里汇合并**自证**：
 *   - hint 形状：镜像 `parseHint`（hint.ts，唯一解析器）的闭集；import 时逐个示例断言
 *     解析结果 = 声明形状——示例烂了/解析器改了没跟上，**启动即红**。
 *   - 信号算子：从 `SIGNAL_OPS`（signal-ops.ts，叶子）生成；import 时双向对齐断言——
 *     新增算子漏写描述 / 删算子留死描述，**启动即红**。提示词不可能再悄悄落后于校验器。
 *
 * 消费点（引擎内直接 import）：`executor.ts` 的 target_not_found 报错文案、
 * `plan.ts` 的 `PlanningRules.promptText()`。
 * 引擎外（DSH 桥，"called, not embedded"，不 import 引擎代码）走**生成物**：
 * `integrations/dsh-bridge/src/grammar.generated.ts`，由 `npm run prompt-hit` 生成并校验同步。
 */

import { parseHint } from "./hint.ts";
import { SIGNAL_OPS } from "./signal-ops.ts";

/** 语法描述里的一个 hint 形状。 */
export interface HintShape {
  /** 中文语境的形状名（报错文案里列形状用）。 */
  token: string;
  /** 英文语境的形状名（英文提示词用）。 */
  en: string;
  /** 可直接照抄的示例——必须被 `parseHint` 解析成 `kind`。 */
  example: string;
  /** 声明的形状 = `ParsedHint` 的 kind。 */
  kind: string;
  note: string;
}

/**
 * 6 种 hint 形状，镜像 `parseHint` 的闭集。顺序即报错/提示词里的展示顺序。
 * 注意：示例只示范**形状**，不承诺在任意页面上唯一命中（多候选时 hintMatch 返回
 * null、宁缺勿错——照抄前先 `amber inspect` 看这一页）。
 */
export const HINT_SHAPES: readonly HintShape[] = [
  { token: "#id", en: "#id", example: "#login-button", kind: "id", note: "元素 id" },
  {
    token: "tag[attr~substr]", en: "tag[attr~substr]", example: "a[href~travel_2]",
    kind: "attrSubstr", note: "属性子串——真实页面的主力形状",
  },
  {
    token: "tag~token", en: "tag~token", example: "button~onesie",
    kind: "nearToken", note: "近邻上下文词（消歧重复标签）",
  },
  {
    token: "tag[attr=value]", en: "tag[attr=value]", example: "[data-test=add-to-cart]",
    kind: "attrEq", note: "属性精确匹配（大小写折叠）",
  },
  {
    token: "角色词", en: "tag (button|link|input|textarea|select)", example: "button",
    kind: "tag", note: "角色词：button | link | input | textarea | select",
  },
  {
    token: "裸词", en: "bare-token", example: "travel",
    kind: "bare",
    note: "唯一标签 / data-test 词（大小写不敏感；完整 label 的词边界/前缀匹配；多候选即歧义，宁缺勿错）",
  },
];

/**
 * E3：`within:#id` 尾缀（可选；E2 起为**语义链** `within:#a1>#a2`）——任意形状后缀它，命中集
 * 即被限定在锚链子树内（池侧 = anchorChainMatch 嵌套序包含；DOM 侧回捞 = 逐段 getElementById
 * + 嵌套 contains）。链：`>` 分隔、**外→内**、≤4 段、每段 `#id` 形态（任意 CSS 锚拒绝）；
 * 单层 `within:#id` = 长度 1 链（逐字节兼容）。多 within / 空段 / 超 4 段 / 非法段 = 解析期
 * 整组拒绝（原始串回退，绝不半剥）。
 */
export const HINT_WITHIN_SUFFIX: { token: string; en: string; example: string; anchor: string; note: string } = {
  token: "within:#id[>#id…]", en: "within:#id[>#id…]", example: "添加到购物车 within:#product-panel",
  anchor: "within:#login-button",
  note: "锚定限定：把命中集限定在锚链子树内（within:#a1>#a2 链：`>` 分隔外→内、≤4 段、嵌套序包含；单层 within:#id 兼容；多 within / 空段 / 超限 = 解析期整组拒绝）",
};

/**
 * A 批：`frame:<origin>` 帧限定尾缀（与 HINT_WITHIN_SUFFIX 同构）——任意形状后缀它，命中集
 * 即被限定在 origin 链声明的 frame 内。值是 `>` 分隔的 origin 链（外→内，≤4 段，每段
 * `v === new URL(v).origin` 的 http/https 规范形，默认端口要写成规范形如 `https://a`）；
 * 末段 = 元素所在帧自身 origin，声明链 = 帧完整链 [rootOrigin..ownOrigin] 的后缀；
 * about:blank/srcdoc 等未知 origin 帧不可被任何 `frame:` 命中；串尾词法预扫 + 循环剥离，
 * 与 within 可组合（两种顺序）；任一后缀超限/值非法/空段 = 整组后缀拒绝（原始串回退，绝不半剥）。
 */
export const HINT_FRAME_SUFFIX: { token: string; en: string; example: string; anchor: string; note: string } = {
  token: "frame:<origin>", en: "frame:<origin>", example: "关闭 frame:https://checkout.example.com",
  anchor: "frame:https://ogs.google.com",
  note: "帧限定：把命中集限定在 origin 链声明的 frame 内（`>` 分隔外→内、≤4 段、末段=元素所在帧；未知 origin 帧不可寻址；非法值/超限 = 整组后缀拒绝）",
};

/**
 * F82：`in-row:<token>` 行锚尾缀（与 within/frame 同构的**第三类**尾缀）——任意形状后缀它，
 * 命中集限定到"行上下文文本包含 token"的元素。列表/表格场景里行的唯一可靠身份是**内容**
 * （航班号、订单号、商品名），不是结构 id——子元素不可能仅凭自身信息定位。
 * 行上下文（row_texts，≤6 行 × ≤40 字符）只在**同文案重复组**元素上采集（与 near 同触发）：
 * 非重复组元素写 in-row = 恒落空（fail-closed 对称）。token 非空、无空白、禁 `>`（为未来链
 * 语法保留词法）、≤40 字符，匹配仅小写折叠（不做 NFKC——全角 fail-closed，照抄 hint_candidates
 * 真实行词元构造上必中）。与 within:/frame: 可组合（三类尾缀各至多一次、任意次序）；任一类
 * 超限/值非法 = 整组后缀拒绝（原始串回退，绝不半剥）。
 */
export const HINT_ROW_SUFFIX: { token: string; en: string; example: string; anchor: string; note: string } = {
  token: "in-row:<token>", en: "in-row:<token>", example: "订票 in-row:sc7960",
  anchor: "in-row:order-1042",
  note: "行锚限定：把命中集限定到行上下文文本包含 token 的元素（列表/表格行的内容身份定位；row_texts 只在同文案重复组上采集，非重复组恒落空；token 非空/无空白/禁 >/≤40 字符、仅小写折叠；与 within:/frame: 可组合，任一超限 = 整组后缀拒绝）",
};

/**
 * F83：`row-index:N` 顺序行锚尾缀（与 within/frame/in-row 同构的**第四类**尾缀）——任意形状
 * 后缀它，命中集限定到"**同 dup 组内 DOM 先序第 N 个成员**"（1-based、无前导 0、≤9 位）。
 * 序号即语义的合法场景（排序榜/低价列表/排序命令后点第 N 行）由作者显式承担序漂移；
 * `row-index:N in-row:<token>` 组合 = 内容守卫（双条件 AND，内容不符 = 显式落空，fail-safe
 * 主推形态，组合不强制——推荐纪律）。row_index 只在**同文案重复组**上编号（帧内 (tag+label)
 * 子组 DOM 先序；非重复组元素写 row-index = 恒落空，fail-closed 对称）。与三类尾缀可组合
 * （各至多一次、任意次序）；任一类超限/值非法 = 整组后缀拒绝（原始串回退，绝不半剥）。
 */
export const HINT_ROW_INDEX_SUFFIX: { token: string; en: string; example: string; anchor: string; note: string } = {
  token: "row-index:N", en: "row-index:N", example: "订票 row-index:3",
  anchor: "row-index:5",
  note: "顺序行锚：把命中集限定到同 dup 组内 DOM 先序第 N 个成员（1-based 正整数、无前导 0、≤9 位；0/负数/非数字 = 整组后缀拒绝；序号即语义——排序榜/排序后点第 N 行，作者承担序漂移；组合 in-row:<token> = 内容守卫，内容不符 = 显式落空；非重复组恒落空）",
};

/* ---- import 时自证 1：示例 ↔ 唯一解析器 ---------------------------------- */

for (const s of HINT_SHAPES) {
  const got = parseHint(s.example).kind;
  if (got !== s.kind) {
    throw new Error(
      `grammar-prompt: HINT_SHAPES 示例 '${s.example}' 被解析为 kind='${got}'，声明为 '${s.kind}'`
        + `——示例或 parseHint 漂移了，先对齐 hint.ts 再改这里`,
    );
  }
}

/* E3/E2 自证：within 尾缀被解析层剥离并落进 within 字段（E2 = **链**，外→内 string[]、
   单层 = 长度 1）；非法锚拒绝：多 within 拒、单串链受、空段/超 4 段/非法段拒。 */
{
  const ok = parseHint(HINT_WITHIN_SUFFIX.example);
  if (ok.within === undefined || ok.within.join(">") !== "product-panel" || ok.kind !== "bare") {
    throw new Error(
      `grammar-prompt: HINT_WITHIN_SUFFIX 示例 '${HINT_WITHIN_SUFFIX.example}' 解析为 `
        + `kind='${ok.kind}', within=${JSON.stringify(ok.within)}——期望 bare + within=['product-panel']`,
    );
  }
  // 单串链（E2）：`>` 分隔外→内，归一为小写段数组；`#a>#b` 与 `#a>b` 两种写法同归一。
  const chained = parseHint("保存 within:#modal>#dialog");
  if (chained.within === undefined || chained.within.join(">") !== "modal>dialog" || chained.kind !== "bare") {
    throw new Error(
      `grammar-prompt: 单串 within 链示例解析为 within=${JSON.stringify(chained.within)}`
        + `——期望 bare + ['modal','dialog']（E2 链形必须被解析层接受）`,
    );
  }
  const chainedBare = parseHint("保存 within:#a>b");
  if (chainedBare.within === undefined || chainedBare.within.join(">") !== "a>b") {
    throw new Error("grammar-prompt: within:#a>b（后续段无 #）应与 #a>#b 同归一为 ['a','b']");
  }
  // 多 within = 解析期整组拒绝（原始串回退，绝不半剥）。
  const multi = parseHint(`${HINT_WITHIN_SUFFIX.anchor} within:#a within:#b`);
  if (multi.within !== undefined || multi.kind !== "bare"
      || multi.token !== `${HINT_WITHIN_SUFFIX.anchor} within:#a within:#b`) {
    throw new Error(
      `grammar-prompt: 多 within 示例被静默接受（within=${JSON.stringify(multi.within)}）——解析器必须整组拒绝`,
    );
  }
  // 空段 / 超 4 段 = 解析期整组拒绝（E2 链形校验；与 parseWithinChainValue 同一判定）。
  for (const bad of ["保存 within:#a>", "保存 within:#a>b>c>d>e"]) {
    const rejected = parseHint(bad);
    if (rejected.within !== undefined) {
      throw new Error(
        `grammar-prompt: 非法 within 链 '${bad}' 被静默接受（within=${JSON.stringify(rejected.within)}）`
          + `——空段/超 4 段必须整组拒绝（按原始串回退）`,
      );
    }
  }
}

/* A 批自证：frame:<origin> 尾缀被解析层剥离并落进 frameChain（单段与 2 段链）；双 frame/
   多后缀超限/非法 origin 被**整组**拒绝（原始串回退，绝不半剥）；与 within 组合两种顺序都成立。 */
{
  const ok = parseHint(HINT_FRAME_SUFFIX.example);
  if (ok.frameChain === undefined || ok.frameChain.length !== 1
      || ok.frameChain[0] !== "https://checkout.example.com" || ok.kind !== "bare") {
    throw new Error(
      `grammar-prompt: HINT_FRAME_SUFFIX 示例 '${HINT_FRAME_SUFFIX.example}' 解析为 `
        + `kind='${ok.kind}', frameChain=${JSON.stringify(ok.frameChain)}——期望 bare + ['https://checkout.example.com']`,
    );
  }
  const chain = parseHint("button frame:https://a.example>https://b.example");
  if (chain.frameChain === undefined
      || chain.frameChain.join(">") !== "https://a.example>https://b.example"
      || chain.kind !== "tag") {
    throw new Error(
      `grammar-prompt: 2 段 frame 链示例解析为 frameChain=${JSON.stringify(chain.frameChain)}`
        + `——期望 tag + ['https://a.example','https://b.example']`,
    );
  }
  const double = parseHint("button frame:https://a.example frame:https://b.example");
  if (double.frameChain !== undefined || double.kind !== "bare"
      || double.token !== "button frame:https://a.example frame:https://b.example") {
    throw new Error(
      `grammar-prompt: 双 frame 示例被静默接受（frameChain=${JSON.stringify(double.frameChain)}）`
        + `——解析器必须整组拒绝（按原始串回退 = 裸词落空）`,
    );
  }
  const illegal = parseHint("button frame:https://a.example/path");
  if (illegal.frameChain !== undefined) {
    throw new Error("grammar-prompt: 带 path 的 frame 值被静默接受——每段必须是 v === new URL(v).origin 的规范形");
  }
  const bothOrders = [
    parseHint("保存 within:#dialog frame:https://checkout.example.com"),
    parseHint("保存 frame:https://checkout.example.com within:#dialog"),
  ];
  for (const p of bothOrders) {
    if (p.within === undefined || p.within.join(">") !== "dialog" || p.frameChain === undefined
        || p.frameChain.join(">") !== "https://checkout.example.com") {
      throw new Error(
        `grammar-prompt: within+frame 组合解析漂移（within=${JSON.stringify(p.within)}, `
          + `frameChain=${JSON.stringify(p.frameChain)}）——两种顺序都必须剥出两字段`,
      );
    }
  }
}

/* F82 自证：in-row:<token> 尾缀被解析层剥离并落进 inRow（六形状均可后缀——解析只管形状）；
   双 in-row / 含 ">" / 空值 / 超 40 字符 / 属性值内伪尾缀被**整组**拒绝（原始串回退，绝不半剥）；
   与 within/frame 组合三种尾缀任意次序都成立；NFKC 不进解析（小写折叠既有路径）。 */
{
  const ok = parseHint(HINT_ROW_SUFFIX.example);
  if (ok.inRow === undefined || ok.inRow !== "sc7960" || ok.kind !== "bare") {
    throw new Error(
      `grammar-prompt: HINT_ROW_SUFFIX 示例 '${HINT_ROW_SUFFIX.example}' 解析为 `
        + `kind='${ok.kind}', inRow=${JSON.stringify(ok.inRow)}——期望 bare + inRow='sc7960'`,
    );
  }
  // 六形状 × in-row（解析只管形状——形状判定先于/独立于尾缀剥离）。
  const shapes = [
    parseHint("#login-button in-row:order-1042"),
    parseHint("a[href~travel_2] in-row:order-1042"),
    parseHint("button~onesie in-row:order-1042"),
    parseHint("[data-test=add] in-row:order-1042"),
    parseHint("button in-row:order-1042"),
    parseHint("添加到购物车 in-row:order-1042"),
  ];
  const wantKinds = ["id", "attrSubstr", "nearToken", "attrEq", "tag", "bare"];
  shapes.forEach((p, i) => {
    if (p.inRow !== "order-1042" || p.kind !== wantKinds[i]) {
      throw new Error(
        `grammar-prompt: in-row × 六形状自证失败（第 ${i + 1} 形状解析为 kind='${p.kind}', `
          + `inRow=${JSON.stringify(p.inRow)}，期望 ${wantKinds[i]} + 'order-1042'）`,
      );
    }
  });
  // 双 in-row = 整组拒绝（原始串回退，绝不半剥）。
  const double = parseHint("button in-row:a in-row:b");
  if (double.inRow !== undefined || double.kind !== "bare"
      || double.token !== "button in-row:a in-row:b") {
    throw new Error(
      `grammar-prompt: 双 in-row 示例被静默接受（inRow=${JSON.stringify(double.inRow)}）`
        + `——解析器必须整组拒绝（按原始串回退 = 裸词落空）`,
    );
  }
  // token 闭集：含 ">" / 空值 / 超 40 字符 = 整组拒绝。
  const gt = parseHint("button in-row:a>b");
  if (gt.inRow !== undefined) throw new Error("grammar-prompt: 含 '>' 的 in-row token 被静默接受——禁 '>'");
  const empty = parseHint("button in-row:");
  if (empty.inRow !== undefined) throw new Error("grammar-prompt: 空 in-row 值被静默接受——必须整组拒绝");
  const tooLong = parseHint(`button in-row:${"x".repeat(41)}`);
  if (tooLong.inRow !== undefined) throw new Error("grammar-prompt: >40 字符的 in-row token 被静默接受——必须整组拒绝");
  // 属性值内伪尾缀：`tag[attr=x in-row:o]` 的 in-row: 落在属性值里——不是语法后缀。
  const pseudo = parseHint("tag[attr=x in-row:o]");
  if (pseudo.inRow !== undefined || pseudo.kind !== "attrEq") {
    throw new Error(
      `grammar-prompt: 属性值内伪尾缀被当后缀（kind='${pseudo.kind}', inRow=${JSON.stringify(pseudo.inRow)}）`
        + `——应按原始串回退为 attrEq（值含伪尾缀文本）`,
    );
  }
  // 三类尾缀组合任意次序（within + frame + in-row）。
  const combos = [
    parseHint("保存 in-row:sc7960 within:#dialog frame:https://checkout.example.com"),
    parseHint("保存 frame:https://checkout.example.com within:#dialog in-row:sc7960"),
    parseHint("保存 within:#dialog in-row:sc7960 frame:https://checkout.example.com"),
  ];
  for (const p of combos) {
    if (p.within === undefined || p.within.join(">") !== "dialog"
        || p.frameChain === undefined || p.frameChain.join(">") !== "https://checkout.example.com"
        || p.inRow !== "sc7960") {
      throw new Error(
        `grammar-prompt: 三尾缀组合解析漂移（within=${JSON.stringify(p.within)}, `
          + `frameChain=${JSON.stringify(p.frameChain)}, inRow=${JSON.stringify(p.inRow)}）`
          + `——三类尾缀任意次序都必须剥出三字段`,
      );
    }
  }
}

/* F83 自证：row-index:N 尾缀被解析层剥离并落进 rowIndex（number，六形状均可后缀）；四类尾缀
   全组合 24 排列（程序化枚举）任意次序都成立；双 row-index / 0 / 负数 / 非数字 / 超位数 /
   空值 / 属性值内伪尾缀被**整组**拒绝（原始串回退，绝不半剥）。 */
{
  const ok = parseHint(HINT_ROW_INDEX_SUFFIX.example);
  if (ok.rowIndex === undefined || ok.rowIndex !== 3 || ok.kind !== "bare") {
    throw new Error(
      `grammar-prompt: HINT_ROW_INDEX_SUFFIX 示例 '${HINT_ROW_INDEX_SUFFIX.example}' 解析为 `
        + `kind='${ok.kind}', rowIndex=${JSON.stringify(ok.rowIndex)}——期望 bare + rowIndex=3`,
    );
  }
  // 六形状 × row-index（解析只管形状）。
  const shapes = [
    parseHint("#login-button row-index:5"),
    parseHint("a[href~travel_2] row-index:5"),
    parseHint("button~onesie row-index:5"),
    parseHint("[data-test=add] row-index:5"),
    parseHint("button row-index:5"),
    parseHint("添加到购物车 row-index:5"),
  ];
  const wantKinds = ["id", "attrSubstr", "nearToken", "attrEq", "tag", "bare"];
  shapes.forEach((p, i) => {
    if (p.rowIndex !== 5 || p.kind !== wantKinds[i]) {
      throw new Error(
        `grammar-prompt: row-index × 六形状自证失败（第 ${i + 1} 形状解析为 kind='${p.kind}', `
          + `rowIndex=${JSON.stringify(p.rowIndex)}，期望 ${wantKinds[i]} + 5）`,
      );
    }
  });
  // 四类尾缀全组合 24 排列（程序化枚举，v1.0 Q1-Q6 定稿口径）。
  const tail4 = ["within:#dialog", "frame:https://checkout.example.com", "in-row:sc7960", "row-index:3"];
  const perms4: string[][] = [];
  const permute = (arr: string[], acc: string[] = []): void => {
    if (arr.length === 0) { perms4.push(acc); return; }
    for (let i = 0; i < arr.length; i++) {
      permute([...arr.slice(0, i), ...arr.slice(i + 1)], [...acc, arr[i]!]);
    }
  };
  permute(tail4);
  if (perms4.length !== 24) throw new Error("grammar-prompt: 4! 排列枚举漂移");
  for (const perm of perms4) {
    const p = parseHint(`保存 ${perm.join(" ")}`);
    if (p.kind !== "bare" || p.within?.join(">") !== "dialog"
        || p.frameChain?.join(">") !== "https://checkout.example.com"
        || p.inRow !== "sc7960" || p.rowIndex !== 3) {
      throw new Error(
        `grammar-prompt: 四尾缀组合解析漂移（次序 ${perm.join(" ")}→within=${JSON.stringify(p.within)}, `
          + `frameChain=${JSON.stringify(p.frameChain)}, inRow=${JSON.stringify(p.inRow)}, `
          + `rowIndex=${JSON.stringify(p.rowIndex)}）——四类尾缀任意次序都必须剥出四字段`,
      );
    }
  }
  // 双 row-index = 整组拒绝（原始串回退，绝不半剥）。
  const double = parseHint("button row-index:2 row-index:3");
  if (double.rowIndex !== undefined || double.kind !== "bare"
      || double.token !== "button row-index:2 row-index:3") {
    throw new Error(
      `grammar-prompt: 双 row-index 示例被静默接受（rowIndex=${JSON.stringify(double.rowIndex)}）`
        + `——解析器必须整组拒绝（按原始串回退 = 裸词落空）`,
    );
  }
  // 值闭集：0 / 负数 / 非数字 / 超 9 位 / 空值 = 整组拒绝。
  for (const bad of ["button row-index:0", "button row-index:-1", "button row-index:abc",
    `button row-index:${"9".repeat(10)}`, "button row-index:"]) {
    const p = parseHint(bad);
    if (p.rowIndex !== undefined) {
      throw new Error(`grammar-prompt: 非法 row-index 值 '${bad}' 被静默接受（rowIndex=${p.rowIndex}）——必须整组拒绝`);
    }
  }
  // 边界：恰 9 位合法、row-index:1 合法。
  if (parseHint("button row-index:999999999").rowIndex !== 999999999) {
    throw new Error("grammar-prompt: 9 位 row-index 应合法（≤9 位词法卫生）");
  }
  // 属性值内伪尾缀：`tag[attr=x row-index:3]` 的 row-index: 落在属性值里——不是语法后缀。
  const pseudo = parseHint("tag[attr=x row-index:3]");
  if (pseudo.rowIndex !== undefined || pseudo.kind !== "attrEq") {
    throw new Error(
      `grammar-prompt: 属性值内伪尾缀被当后缀（kind='${pseudo.kind}', rowIndex=${JSON.stringify(pseudo.rowIndex)}）`
        + `——应按原始串回退为 attrEq（值含伪尾缀文本）`,
    );
  }
}

/**
 * 信号算子的提示词描述，键集合必须与 `SIGNAL_OPS` **双向一致**（下方 import 时断言）。
 * 描述面向英文提示词（`PlanningRules.promptText()`）；前五个叶子的措辞与历史版本逐字一致。
 */
export const SIGNAL_OP_PROMPT: Readonly<Record<string, string>> = {
  url_contains: "substring of the final url  (op=value)",
  css_exists: "css selector that must exist  (op=value)",
  css_exists_text: "selector|substring of the element's text (case-insensitive; any match counts)  (op=selector|text)",
  css_visible_exists: "css selector that must exist AND be visible  (op=value)",
  css_text_equals: "selector|exact text",
  css_text_contains: "selector|substring of the element's text",
  css_value_equals: "selector|exact input value",
  css_count_equals: "selector|N: total matching elements across frames must equal exactly N  (op=selector|N)",
  css_count_min: "selector|N: total matching elements across frames must be at least N  (op=selector|N)",
  all_of: "AND-composition: a non-empty list of signals, each leaf still a DOM fact",
  any_of: "OR-composition: a non-empty list of signal alternatives",
  not: "negation of one signal (e.g. the spinner is gone)",
  manual: "no-arg leaf: a human attestation, never verifiable from the DOM",
};

/* ---- import 时自证 2：算子描述 ↔ SIGNAL_OPS 双向对齐 ---------------------- */

for (const op of Object.keys(SIGNAL_OPS)) {
  if (!(op in SIGNAL_OP_PROMPT)) {
    throw new Error(
      `grammar-prompt: 信号算子 '${op}'（SIGNAL_OPS）没有提示词描述——新增算子必须在这里补描述`,
    );
  }
}
for (const op of Object.keys(SIGNAL_OP_PROMPT)) {
  if (!(op in SIGNAL_OPS)) {
    throw new Error(
      `grammar-prompt: SIGNAL_OP_PROMPT 的 '${op}' 不是 SIGNAL_OPS 里的算子——算子已删/改名，删掉死描述`,
    );
  }
}

/* ---- 生成的文案 ----------------------------------------------------------- */

const HINT_TOKEN_LINE_CN = HINT_SHAPES.map((s) => s.token).join(" / ");
const HINT_TOKEN_LINE_EN = HINT_SHAPES.map((s) => s.en).join(" | ");

/**
 * 池侧可参与匹配的属性名（唯一权威清单，报错/文档/工具都从这渲染）。
 * 依据：attrSubstr/attrEq 按 `e[poolAttr(attr)]` 匹配（rules.ts），`poolAttr` 只给
 * test/type 发别名、其余直取同名字段——**凡是 Elem 池字段**的属性都可命中
 * （extraction.ts `Elem`：data_test/name/id/input_type/href/role/near）；
 * class/title 等非池字段永不命中。历史教训：文档曾写「title、href 等不在池字段
 * 模型里」，与本文件自证示例 `a[href~travel_2]`（books-category rule:match 实测
 * 命中）直接矛盾——真实 Agent 首用即被搅浑（2026-10-29 实测报告）。
 */
export const MATCHABLE_POOL_ATTRS: readonly string[] = [
  "test→data-test",
  "type→input_type",
  "aria-label→label",
  "href",
  "name",
  "id",
  "role",
  "near",
];

/**
 * 属性匹配模型的权威表述（docs/APP_SCRIPT_AUTHORING.md 必须逐字包含，prompt-hit 校验）。
 * A2：DOM 的 aria-label 在提取期已并进 label（labelOf 优先读它），所以
 * `[aria-label~x]`/`[aria-label=y]` 按 **label** 匹配——不是第二个字段模型。
 * A1：label 的匹配底座是 [full_label, label]（≤200 完整值），href 同理是 [href_full, href]。
 */
export const ATTR_MATCH_MODEL_TEXT =
  `属性名按池字段匹配：${MATCHABLE_POOL_ATTRS.join("、")}`
  + `；aria-label 是 label 的别名（提取期已并进 label），label/href 按完整值（≤200）匹配（label = full_label + label、href = href_full + href 双底座），class、title 等不在池字段模型里，永不命中`;

/**
 * target_not_found 报错里的闭集提示（executor.ts 消费）。
 * 由 HINT_SHAPES / MATCHABLE_POOL_ATTRS 生成，不再手抄——形状或属性模型增删时这行自动跟上。
 */
export const HINT_CLOSED_SET_TEXT =
  `hint 语法是 ${HINT_SHAPES.length} 形状闭集（${HINT_TOKEN_LINE_CN}；`
  + `${ATTR_MATCH_MODEL_TEXT}）——`
  + `容器/后代 CSS（如 "#outer input"）会被当成一个永不命中的形状，报"matches nothing"而非语法错误`;

/**
 * A2 候选窗口/可寻址的权威表述（规划引导与作者文档共用；docs/APP_SCRIPT_AUTHORING.md
 * 逐字包含，prompt-hit 的 doc 组不校验这段，但「唯一出处」纪律仍适用）。
 */
export const CANDIDATE_WINDOW_TEXT =
  "候选窗口是**有界快照**：每步只取 40（宽扫 120）个候选，按桶配额来自当前视口——"
  + "chrome 8 / viewport 16 / contentNear 8 / mainOffscreen 6 / other 2，不足时按 "
  + "viewport→contentNear→mainOffscreen→other 顺延；窗口外不等于页面上没有（inspect --json 的 "
  + "window 会给出窗口外可见交互），引擎不自动滚动。真正需要读完整列表时用滚动/展开原语分块取证。"
  + "hint 匹配用**完整标签**（≤200，full_label）而不是模型视图的 40 字前缀："
  + "裸词按大小写不敏感的词边界/前缀匹配，`[aria-label~x]` 是 label 的别名。"
  + "要回退 A2 之前的主内容优先排序，在 meta.policy 写 candidate_priority: 'main-first'";

/** 英文提示词里的 hint 形状行（plan.ts promptText 消费）。 */
export function hintPromptTokens(): string {
  return HINT_TOKEN_LINE_EN;
}

/** 英文提示词里的信号算子行，每行 `op: 描述`（plan.ts promptText 消费）。 */
export function signalPromptLines(): string[] {
  return Object.entries(SIGNAL_OP_PROMPT).map(([op, d]) => `${op}: ${d}`);
}

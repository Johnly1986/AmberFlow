/**
 * P0 权重通道：`npm run model:fetch`——"想体验模型兜底的人**有路可走**"的那条路。
 *
 * 钉住的纪律（都来自仓内对"落盘"的同一套要求）：
 *   1. 先验后换：坏件/校验不符绝不覆盖现有产物（`.part` 清理，旧件原样）；
 *   2. 校验是点名不是点头：不符就失败退出；没给期望值就打印实测 digest 并明说"未校验"；
 *   3. 不覆盖已有（`--force` 才换）；
 *   4. 不留半途态：一组里某件失败 → 本轮新装的兄弟件一起撤回（重跑不必 --force，旧件未动）；
 *   5. 落点与 doctor 同一约定（`src/model/model-artifacts.ts`）——两处各写一份路径规则正是
 *      本仓库反复钉的"双实现漂移"（见 CLAUDE.md 的 hint grammar 教训）。
 *   通道两条腿都测：`file://` 复制 + 真 http server 的分块下载/404/中途断流。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, resolveSources } from "../src/model/model-fetch.ts";
import { checkArtifacts, onnxModelPath } from "../src/model/model-artifacts.ts";

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}
function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function recording(): { io: { out(l: string): void }; lines: string[] } {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => { lines.push(l); } } };
}

describe("model:fetch — 源形状解析", () => {
  it("点名 .onnx 文件时权重取同名兄弟件", () => {
    expect(resolveSources("/m/laya_dec.onnx"))
      .toEqual({ onnx: "/m/laya_dec.onnx", data: "/m/laya_dec.onnx.data" });
  });
  it("给目录/前缀时按约定文件名找两件", () => {
    expect(resolveSources("https://mirror.example/laya"))
      .toEqual({ onnx: "https://mirror.example/laya/laya_dec.onnx",
        data: "https://mirror.example/laya/laya_dec.onnx.data" });
  });
});

describe("model:fetch — 装件纪律", () => {
  it("file:// 源 + 校验一致：两件就位，.part 不残留", async () => {
    const src = tmpDir("mf-src");
    fs.writeFileSync(path.join(src, "laya_dec.onnx"), "GRAPH");
    fs.writeFileSync(path.join(src, "laya_dec.onnx.data"), "WEIGHTS");
    const dest = tmpDir("mf-dest");
    const onnx = path.join(dest, "laya_dec.onnx");
    const { io, lines } = recording();
    const code = await main([
      "--from", `file://${src}`, "--out", onnx,
      "--sha256-onnx", sha256(Buffer.from("GRAPH")),
      "--sha256-data", sha256(Buffer.from("WEIGHTS")),
    ], io);
    expect(code).toBe(0);
    expect(fs.readFileSync(onnx, "utf-8")).toBe("GRAPH");
    expect(fs.readFileSync(`${onnx}.data`, "utf-8")).toBe("WEIGHTS");
    expect(fs.existsSync(`${onnx}.part`)).toBe(false);
    expect(lines.join("\n")).toContain("与期望一致");
  });

  it("校验不符 = 不安装，现有产物一根手指都不碰", async () => {
    const dest = tmpDir("mf-keep");
    const onnx = path.join(dest, "laya_dec.onnx");
    fs.writeFileSync(onnx, "OLD-GRAPH");                    // 真装过的旧件
    fs.writeFileSync(`${onnx}.data`, "OLD-WEIGHTS");
    const src = tmpDir("mf-bad");
    fs.writeFileSync(path.join(src, "laya_dec.onnx"), "NEW");
    fs.writeFileSync(path.join(src, "laya_dec.onnx.data"), "NEW-W");
    const { io, lines } = recording();
    const code = await main([
      "--from", src, "--out", onnx, "--force",
      "--sha256-onnx", "0".repeat(64),                       // 故意对不上
      "--sha256-data", sha256(Buffer.from("NEW-W")),
    ], io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("SHA256 校验不符");
    expect(fs.readFileSync(onnx, "utf-8")).toBe("OLD-GRAPH"); // 没被动过
    expect(fs.existsSync(`${onnx}.part`)).toBe(false);
  });

  it("没给期望值时如实报未校验（打印实测 digest，不装作校验过）", async () => {
    const src = tmpDir("mf-raw");
    fs.writeFileSync(path.join(src, "laya_dec.onnx"), "G");
    fs.writeFileSync(path.join(src, "laya_dec.onnx.data"), "W");
    const dest = tmpDir("mf-raw-dest");
    const { io, lines } = recording();
    const code = await main(["--from", src, "--out", path.join(dest, "laya_dec.onnx")], io);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("未提供期望值，未校验");
  });

  it("已有产物且没给 --force：动工之前就拒绝，不先下载再报错", async () => {
    const dest = tmpDir("mf-exist");
    const onnx = path.join(dest, "laya_dec.onnx");
    fs.writeFileSync(onnx, "G");
    fs.writeFileSync(`${onnx}.data`, "W");
    const { io, lines } = recording();
    let transferred = false;
    const code = await main(["--from", "/whatever", "--out", onnx], io, {
      transfer: async () => { transferred = true; return "0".repeat(64); },
    });
    expect(code).toBe(2);
    expect(transferred, "冲突检测必须先于取件").toBe(false);
    expect(lines.join("\n")).toContain("--force");
  });

  it("源不存在是失败，不是栈", async () => {
    const dest = tmpDir("mf-miss");
    const { io } = recording();
    const code = await main(["--from", path.join(dest, "nope"), "--out", path.join(dest, "laya_dec.onnx")], io);
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(dest, "nope"))).toBe(false);
  });

  it("缺 --from 就是用法错误（2）并给 usage", async () => {
    const { io, lines } = recording();
    expect(await main([], io)).toBe(2);
    expect(lines[0]).toContain("npm run model:fetch");
  });

  it("--tokenizer 把第三件也装上，并给出发现它的 env", async () => {
    const src = tmpDir("mf-tok");
    fs.writeFileSync(path.join(src, "laya_dec.onnx"), "G");
    fs.writeFileSync(path.join(src, "laya_dec.onnx.data"), "W");
    fs.writeFileSync(path.join(src, "tokenizer.json"), `{"tokenizer":"ok"}`);
    const dest = tmpDir("mf-tok-dest");
    const onnx = path.join(dest, "laya_dec.onnx");
    const { io, lines } = recording();
    const code = await main([
      "--from", src, "--out", onnx, "--tokenizer", path.join(src, "tokenizer.json"),
    ], io);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dest, "tokenizer", "tokenizer.json"))).toBe(true);
    expect(lines.join("\n")).toContain("LAYA_TOKENIZER_DIR");
  });
});

describe("model-artifacts — 单一出处的缺件点名", () => {
  it("三件齐才算 ready；缺哪件点哪件", () => {
    const dest = tmpDir("ma");
    const onnx = path.join(dest, "laya_dec.onnx");
    fs.writeFileSync(onnx, "G");
    fs.writeFileSync(`${onnx}.data`, "W");
    const a = checkArtifacts(onnx, () => null);
    expect(a.ready).toBe(false);
    expect(a.graph).toBe(true);
    expect(a.weights).toBe(true);
    // 齐的那一面：tokenizer 注入为有目录 = ready。
    fs.mkdirSync(path.join(dest, "tokenizer"));
    fs.writeFileSync(path.join(dest, "tokenizer", "tokenizer.json"), "{}");
    expect(checkArtifacts(onnx, () => path.join(dest, "tokenizer")).ready).toBe(true);
  });

  it("落点约定：LAYA_ONNX_MODEL 优先，缺省 /tmp/laya_dec.onnx（与 doctor/运行器同一处）", () => {
    expect(onnxModelPath({})).toBe("/tmp/laya_dec.onnx");
    expect(onnxModelPath({ LAYA_ONNX_MODEL: "/x/laya_dec.onnx" })).toBe("/x/laya_dec.onnx");
    // 旧名 LAYAA_* 仍然认（兼容既有部署），但新名优先。
    expect(onnxModelPath({ LAYAA_ONNX_MODEL: "/y/l.onnx" })).toBe("/y/l.onnx");
    expect(onnxModelPath({ LAYAA_ONNX_MODEL: "/y/l.onnx", LAYA_ONNX_MODEL: "/z/l.onnx" }))
      .toBe("/z/l.onnx");
  });
});

/** 真起一个本地 http server：测的是默认 transfer 的流式分支，不是注入的桩。 */
async function withServer(
  route: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => route(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${String(port)}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("model:fetch — http(s) 流式通道（1.7GB 形状的真路径）", () => {
  const GRAPH = Buffer.concat([Buffer.alloc(64 * 1024, 0xAB), Buffer.from("graph-tail")]);
  const DATA = Buffer.alloc(32 * 1024, 0xCD);

  it("分块下载两件 + SHA256 等值 → 就位，字节全等", async () => {
    await withServer((req, res) => {
      const p = req.url ?? "";
      if (p.endsWith("laya_dec.onnx")) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        // 分块写：模拟真源头的 chunked 传输，逼流水线走多 chunk 路径。
        for (let i = 0; i < GRAPH.length; i += 20_000) res.write(GRAPH.subarray(i, i + 20_000));
        res.end();
      } else if (p.endsWith(".onnx.data")) {
        res.writeHead(200); res.end(DATA);
      } else { res.writeHead(404); res.end(); }
    }, async (base) => {
      const dest = tmpDir("mf-http");
      const onnx = path.join(dest, "laya_dec.onnx");
      const { io, lines } = recording();
      const code = await main([
        "--from", `${base}/models`, "--out", onnx,
        "--sha256-onnx", sha256(GRAPH), "--sha256-data", sha256(DATA),
      ], io);
      expect(code).toBe(0);
      expect(fs.readFileSync(onnx)).toEqual(GRAPH);
      expect(fs.readFileSync(`${onnx}.data`)).toEqual(DATA);
      expect(lines.join("\n")).toContain("✓ 与期望一致");
      expect(fs.existsSync(`${onnx}.part`)).toBe(false);
    });
  });

  it("源缺件（HTTP 404）= 失败退出，并且**本轮新装的图一起撤回**（不留半途态）", async () => {
    await withServer((req, res) => {
      if ((req.url ?? "").endsWith("laya_dec.onnx")) { res.writeHead(200); res.end(GRAPH); }
      else { res.writeHead(404); res.end(); }     // 权重不在：产物不分"半张图"
    }, async (base) => {
      const dest = tmpDir("mf-404");
      const onnx = path.join(dest, "laya_dec.onnx");
      const { io, lines } = recording();
      const code = await main(["--from", `${base}/models`, "--out", onnx], io);
      expect(code).toBe(1);
      expect(lines.join("\n")).toContain("404");
      expect(fs.existsSync(onnx), "图装上了也必须撤回：否则重跑被\"不覆盖已有\"挡住").toBe(false);
      expect(fs.existsSync(`${onnx}.part`)).toBe(false);
      // 撤回之后重跑同一条命令不再撞覆盖保护（半途态陷阱的回归钉）。
      const a = checkArtifacts(onnx, () => null);
      expect(a.graph).toBe(false);
    });
  });

  it("传输中途断流 = 失败、半个字节都不留", async () => {
    await withServer((req, res) => {
      const p = req.url ?? "";
      if (p.endsWith(".onnx.data")) { res.writeHead(200); res.end(DATA); return; }
      res.writeHead(200);
      res.write(GRAPH.subarray(0, 10_000));
      // 半路掐断 socket：fetch 的 body 流会 reject，走的是真断流分支而不是 404。
      setImmediate(() => res.socket?.destroy());
    }, async (base) => {
      const dest = tmpDir("mf-cut");
      const onnx = path.join(dest, "laya_dec.onnx");
      const { io } = recording();
      const code = await main(["--from", `${base}/models`, "--out", onnx], io);
      expect(code).toBe(1);
      for (const f of [onnx, `${onnx}.data`, `${onnx}.part`, `${onnx}.data.part`]) {
        expect(fs.existsSync(f), `${f} 不该存在`).toBe(false);
      }
    });
  });
});

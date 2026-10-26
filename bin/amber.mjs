#!/usr/bin/env node
/**
 * `amber` 的启动垫片。
 *
 * 为什么不让 bin 直接 import main.ts：Windows 上没有 shebang 可执行位这一说，
 * npm 会生成 .cmd 垫片；这里只负责找到仓库里的 TS 入口、传参、转发信号和退出码。
 * Node >= 22.6 的 `--experimental-strip-types` 让源码保持可直接运行，不需要先 build。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const child = spawn(process.execPath, ["--experimental-strip-types", main, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
  cwd: process.cwd(),
});

let forwardedSignal = null;
const forward = (signal) => {
  forwardedSignal = signal;
  try {
    child.kill(signal);
  } catch {
    // 子进程已经走了，交给 exit 收尾。
  }
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.once("error", (err) => {
  console.error(`amber: 无法启动：${err.message}`);
  process.exitCode = 2;
});

child.once("exit", (code, signal) => {
  if (signal === "SIGINT" || forwardedSignal === "SIGINT") {
    process.exitCode = 130;
    return;
  }
  if (forwardedSignal === "SIGTERM" || signal === "SIGTERM") {
    process.exitCode = 143;
    return;
  }
  if (code === 3221225786) {
    process.exitCode = 130;
    return;
  }
  process.exitCode = code ?? 1;
});

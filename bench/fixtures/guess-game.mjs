#!/usr/bin/env node
/**
 * **交互式猜数字游戏**——`stdio` 应用支持器（游戏/任意交互式进程）的离线真实场景夹具。
 *
 * 为什么需要它：web 的完成真值是 DOM、cli/ssh 的是一次进程观察；而"游戏"这类应用是
 * **持续双向会话**：先看提示、再回一行、再看结果。这个夹具是一个真实进程（不是桩模型），
 * 用它验证 stdio 支持器的提示-应答-信号-超时四件事，CI 无条件可跑（只依赖 node）。
 *
 * 确定性（冻结语料不许依赖时钟/随机）：
 *   --secret=<n>   要猜的数字（缺省 42）
 *   --max=<n>      允许猜的次数（缺省 7）
 *
 * 协议（行文本，stdout）：
 *   `Guess a number between 1 and 100 (N tries)`   开局提示
 *   `Too low (k tries)` / `Too high (k tries)`     每次猜测后的反馈
 *   `Please enter a number`                        非数字输入
 *   `You win in K tries (secret=S)`                猜中（退出码 0）
 *   `You lose; the number was S`                   次数用尽（退出码 1）
 */
import readline from "node:readline";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return dflt;
  if (hit.includes("=")) return hit.slice(hit.indexOf("=") + 1);
  const i = args.indexOf(hit);
  return args[i + 1] ?? dflt;
};

const secret = Number(flag("secret", "42"));
const max = Number(flag("max", "7"));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let tries = 0;

console.log(`Guess a number between 1 and 100 (${max} tries)`);

rl.on("line", (line) => {
  const n = Number(String(line).trim());
  if (!Number.isFinite(n)) {
    console.log("Please enter a number");
    return;
  }
  tries += 1;
  if (n === secret) {
    console.log(`You win in ${tries} tries (secret=${secret})`);
    rl.close();
    // 显式退出：stdin 是管道、读端还开着时，Node 默认不会自己退出（这会把 stdio 支持器
    // 拖到超时）。一局结束就该结束——这是游戏自己的收尾责任，不是适配器的猜测。
    process.exit(0);
  }
  if (tries >= max) {
    console.log(`You lose; the number was ${secret}`);
    rl.close();
    process.exit(1);
  }
  console.log(n < secret ? `Too low (${tries} tries)` : `Too high (${tries} tries)`);
});

// 输入关闭（父进程不再写）= 这局没打完：如实退出非零，而不是挂起。
rl.on("close", () => {
  if (tries < max) process.exit(2);
});

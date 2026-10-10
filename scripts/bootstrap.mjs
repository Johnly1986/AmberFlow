#!/usr/bin/env node
/**
 * 插件安装期环境引导 —— pnpm 在安装本包（`dsh plugin add github:Johnly1986/AmberFlow` 的 git 依赖、
 * 或 checkout 里 `npm ci`/`pnpm install` 的开发安装）后运行本包的 `prepare` 脚本，此脚本即入口。
 *
 * 排查结论（2026-10，对着 ~/.dsh/profiles/web 的真实安装实测）：
 *   - Node 运行时依赖 **不缺**：pnpm 会装好根包的 dependencies（playwright / onnxruntime-node /
 *     @huggingface/transformers / exceljs，hoisted 到 profile 根）。
 *   - 缺的是 **chromium 二进制**：`playwright` 包的 postinstall 属于依赖构建脚本，pnpm 10+ 默认拦截，
 *     而且就算放行它也会下载全部浏览器（~700MB，杀鸡用牛刀）。浏览器世界从不随 `npm install` 到位，
 *     第一次跑浏览器旅程才炸 `Executable doesn't exist`。
 *   - 次缺（有 allowBuilds 就不缺）：`onnxruntime-node` 的原生 binding 也要 allowBuilds 放行
 *     （`onnxruntime-node: true` + `protobufjs: true`）；没放行时规则式/脚本运行时照常工作，
 *     只有真模型路径不可用。
 *   - 顺带体检：`jq`（repo-report 应用用）不在 PATH 时提示——npm 世界装不了 apt 包，只提示。
 *
 * 设计约束：**绝不失败**（exit 0，一切问题只打印提示行）。插件安装不能因为离线或网络慢而装不上；
 * 权威体检是 `npm run doctor`（它报真话，这里只负责"能自动装的自动装"）。
 * 跳过开关：`AMBERFLOW_BOOTSTRAP=0` 全部跳过；`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 只跳浏览器下载。
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const say = (line) => process.stderr.write(`[amberflow] ${line}\n`)
const onPath = (bin) => (process.env.PATH ?? '')
  .split(path.delimiter).filter(Boolean)
  .some((dir) => { try { return existsSync(path.join(dir, bin)) } catch { return false } })

function resolvePackage(name) {
  try {
    const require = createRequire(path.join(pkgDir, 'package.json'))
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    return undefined
  }
}

/** 跑一条子命令，返回 { code, output }；异常归一为 code=-1（fail-open 的底层保证）。 */
function run(bin, args) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf-8', timeout: 15 * 60_000 })
    return { code: r.status ?? (r.error ? -1 : 0), output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } catch {
    return { code: -1, output: '' }
  }
}

/* ---- ① playwright + chromium：随装的核心缺口 ------------------------------ */

function bootstrapChromium() {
  const pwDir = resolvePackage('playwright')
  if (pwDir === undefined) {
    say('playwright is not resolvable from this package — runtime deps did not install; '
      + 'check the package manager output above (a git install should not land here)')
    return
  }
  const cli = path.join(pwDir, 'cli.js')
  if (!existsSync(cli)) {
    say(`playwright resolved to ${pwDir} but its cli.js is missing — skipping browser install`)
    return
  }
  if (process.env.AMBERFLOW_BOOTSTRAP === '0' || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1') {
    say('browser download skipped (AMBERFLOW_BOOTSTRAP=0 / PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1); '
      + 'browser journeys need `npx playwright install chromium` in this checkout')
    return
  }
  // 幂等：已下载时这是一次几秒内的校验；没下载时它才是真正的随装。
  const r = run(process.execPath, [cli, 'install', 'chromium'])
  if (r.code === 0) {
    say('chromium is in place (playwright install chromium)')
  } else {
    say('playwright install chromium did not succeed — browser journeys will block until it does; '
      + `run it manually in this checkout (offline installs: this is expected). tail: `
      + `${r.output.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`)
  }
}

/* ---- ② onnxruntime-node 原生 binding：allowBuilds 的体检 ------------------ */

function checkOnnxRuntime() {
  const ortDir = resolvePackage('onnxruntime-node')
  if (ortDir === undefined) {
    say('onnxruntime-node is not installed — rules-only and scripted runs work, '
      + 'but the real decision model will not load')
    return
  }
  if (process.env.AMBERFLOW_BOOTSTRAP === '0') return
  // binding 的落点是 bin/napi-v<n>/<platform>/<arch>/onnxruntime_binding.node——包里是预编译产物，
  // allowBuilds 拦的是把它解开/链接的安装脚本。直接找文件，比 import 整个 dist 更便宜也更准。
  const napiDir = path.join(ortDir, 'bin')
  let found = false
  try {
    const stack = [napiDir]
    while (stack.length && !found) {
      const dir = stack.pop()
      for (const name of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
        const full = path.join(dir, name.name)
        if (name.isDirectory()) stack.push(full)
        else if (name.name.endsWith('.node')) found = true
      }
    }
  } catch {
    /* 读不了目录按缺失处理，走下面的提示 */
  }
  if (found) {
    say('onnxruntime-node native binding is in place')
  } else {
    say('onnxruntime-node native binding is missing — approve `onnxruntime-node: true` (and '
      + '`protobufjs: true`) under allowBuilds in the profile pnpm-workspace.yaml, then re-run the '
      + 'install; until then only rules-only / scripted runs work')
  }
}

/* ---- ③ npm 世界装不了的东西：只点名 --------------------------------------- */

function checkSystemTools() {
  for (const [bin, why] of [['git', 'repo-report 应用与 git 安装通道'], ['jq', 'repo-report 应用']]) {
    if (!onPath(bin)) say(`${bin} is not on PATH (${why}) — install it with the system package manager`)
  }
}

bootstrapChromium()
checkOnnxRuntime()
checkSystemTools()
// 引导永不失败：插件安装不能因为离线/网络慢而装不上。
process.exit(0)

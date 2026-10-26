#!/usr/bin/env node
/**
 * Link what this package needs into `node_modules`.
 *
 * Two different owners:
 * - the TOOLCHAIN (typescript / @types) comes from this repository, because the package now
 *   lives inside AmberFlow and builds with that checkout's tooling;
 * - the HOST packages (`@deepseek-ai/*`) come from a DSH installation, because this package is a DSH
 *   plugin: the running DSH process provides those, and they are what it resolves at runtime too.
 *
 * The links are compile-time only. At runtime DSH loads the plugin under tsx from its own
 * checkout, whose path mappings resolve the host packages to the same sources — one module instance.
 *
 * `DSH_ROOT` selects the installation to build against.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_ROOT = process.env.DSH_ROOT ?? '/root/deepseek-harness'
const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoRoot = path.resolve(pkgRoot, '..', '..')

/** Host packages, relative to the DSH installation. */
const HOST = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-settings': 'packages/settings/settings',
  '@deepseek-ai/cordis-plugin-loader': 'vendor/loader',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
}
/** Tooling, relative to this repository's node_modules. */
const TOOLING = ['typescript', '@types']

let made = 0
let missing = 0

/**
 * Create one symlink, reporting what is missing instead of failing on the first one.
 * @param link - the symlink path to create.
 * @param source - the directory it points at.
 * @param what - label used in the error line.
 */
function link(link, source, what) {
  if (!fs.existsSync(source)) {
    process.stderr.write(`setup-links: no ${what} at ${source}\n`)
    missing += 1
    return
  }
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(source, link, 'dir')
  made += 1
}

for (const [name, target] of Object.entries(HOST)) {
  link(path.join(pkgRoot, 'node_modules', name), path.join(DSH_ROOT, target), `${name} (set DSH_ROOT)`)
}
for (const name of TOOLING) {
  link(path.join(pkgRoot, 'node_modules', name), path.join(repoRoot, 'node_modules', name), `${name} (run npm ci in the repo root)`)
}

process.stdout.write(`setup-links: ${made} link(s) ready (host: ${DSH_ROOT}; toolchain: ${repoRoot})\n`)
process.exit(missing === 0 ? 0 : 1)

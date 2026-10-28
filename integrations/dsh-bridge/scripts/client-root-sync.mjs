#!/usr/bin/env node
/**
 * Generate the repository-root client bundle from the package's `client.js`.
 *
 * The DSH bundle has TWO install doors:
 *   - `integrations/dsh-bridge` (this package) → client module id = the package name,
 *     row-config key `<package>#amberflow-bridge`;
 *   - the AmberFlow repository root (`dsh plugin add <repo>`) → the row is declared by the root
 *     package (`amberflow`), so the browser half has to register under that package name and key.
 *
 * Both bundles must stay byte-identical apart from those two identifiers, so this file is the ONE
 * generator: run it after editing `client.js`. the generated file is kept in sync by
 * this transform, so a stale copy fails the test instead of silently serving the wrong key.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SOURCE_PATH = path.join(PACKAGE_ROOT, 'client.js')
export const ROOT_PATH = path.resolve(PACKAGE_ROOT, '..', '..', 'integrations', 'dsh-bridge', 'client-root.js')

const HEADER = `/**
 * GENERATED FILE — edit \`integrations/dsh-bridge/client.js\` and run
 * \`node integrations/dsh-bridge/scripts/client-root-sync.mjs\`.
 *
 * Repository-root client bundle: identical to the package's client bundle except the module id and
 * row-config key use the ROOT package name (\`amberflow\`), because the repo-install door declares
 * the \`amberflow-bridge\` row from the root bundle.
 */
`

/**
 * Render the root-install client bundle from the package client bundle.
 * @param {string} source - contents of the package's client.js.
 * @returns {string} contents for client-root.js.
 */
export function renderRootClient(source) {
  const idReplaced = source.replace(
    "  id: '@deepseek-ai/dsh-amberflow-bridge',",
    "  id: 'amberflow',",
  )
  if (idReplaced === source) throw new Error('client-root-sync: client.js module id line not found')
  const rendered = idReplaced.replace(
    "    const PACKAGE = '@deepseek-ai/dsh-amberflow-bridge'",
    "    const PACKAGE = 'amberflow'",
  )
  if (rendered === idReplaced) throw new Error('client-root-sync: client.js PACKAGE line not found')
  return HEADER + rendered
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = fs.readFileSync(SOURCE_PATH, 'utf-8')
  const target = path.resolve(PACKAGE_ROOT, 'client-root.js')
  fs.writeFileSync(target, renderRootClient(source))
  const rootManifest = path.resolve(PACKAGE_ROOT, '..', '..', 'package.json')
  // The root package must export this bundle; check the manifest points at it.
  const manifest = JSON.parse(fs.readFileSync(rootManifest, 'utf-8'))
  const exported = manifest?.exports?.['./client']
  if (exported !== './integrations/dsh-bridge/client-root.js') {
    throw new Error(`client-root-sync: root package.json exports["./client"] must be `
      + `"./integrations/dsh-bridge/client-root.js" (found ${JSON.stringify(exported)})`)
  }
  console.log(`wrote client-root.js (${fs.statSync(target).size} bytes; root export verified)`)
}

/**
 * The browser half (`client.js`) is a plain-JavaScript module bundle: this spec loads it the way
 * the module table would (`window.__ModuleLoader__.load`) and exercises its **registration
 * contract** without a browser: the plugin object, the slot cell, the settings namespace it edits
 * and the locale dictionaries.
 *
 * It deliberately does not render the form (that needs a React renderer and the Harness page); the
 * behavioral checks for saving live in the Host-side tests plus the installed-plugin verification.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderRootClient } from '../scripts/client-root-sync.mjs'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(PKG_ROOT, '..', '..')
const SOURCE = fs.readFileSync(path.join(PKG_ROOT, 'client.js'), 'utf-8')
const ROOT_SOURCE = fs.readFileSync(path.join(PKG_ROOT, 'client-root.js'), 'utf-8')
const REPO_MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  icon?: string
  exports?: Record<string, string>
  dsh?: { client?: { platform?: string; inject?: string[] } }
}

interface Registered {
  options: { name: string; key?: string; [key: string]: unknown }
  component: unknown
}

/** Load the client bundle with a fake module table and a fake React. */
function loadClient(source: string, label = 'client.js'): { id: string; plugin: { inject: string[]; apply(ctx: unknown): void } } {
  let loaded: { id: string; factory: (require: (id: string) => unknown) => { inject: string[]; apply(ctx: unknown): void } } | undefined
  const fakeWindow = {
    __ModuleLoader__: {
      load(registration: typeof loaded): void { loaded = registration },
    },
  }
  // The bundle is a program, not an ESM module: evaluate it with `window` bound, as the script tag does.
  // eslint-disable-next-line no-new-func
  new Function('window', source)(fakeWindow)
  if (loaded === undefined) throw new Error(`${label} did not register with __ModuleLoader__`)
  const react = { createElement: () => null }
  return { id: loaded.id, plugin: loaded.factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected client module request: ${specifier}`)
  }) }
}

/** A minimal client context: records effects, locale dictionaries, slot cells and injected forms. */
function fakeContext(): {
  ctx: unknown
  dictionaries: Array<{ ns: string; dictionaries: Record<string, Record<string, string>> }>
  cells: Registered[]
  effectLabels: string[]
} {
  const dictionaries: Array<{ ns: string; dictionaries: Record<string, Record<string, string>> }> = []
  const cells: Registered[] = []
  const effectLabels: string[] = []
  const form = {
    getSnapshot: () => ({ status: 'loading', value: undefined, revision: undefined, writable: true }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const mirror = {
    getSnapshot: () => ({ status: 'idle', view: undefined }),
    subscribe: () => () => {},
  }
  const ctx = {
    effect: (callback: () => unknown, label?: string) => {
      if (label !== undefined) effectLabels.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: (ns: string, dicts: Record<string, Record<string, string>>) => {
        dictionaries.push({ ns, dictionaries: dicts })
        return () => {}
      },
      bind: () => (key: string) => key,
    },
    configForms: {
      get: () => form,
      describe: () => mirror,
      whileServed: (namespaces: string[], register: (served: ReadonlySet<string>) => () => void) =>
        register(new Set(namespaces)),
    },
    slots: {
      inject: (_owner: string, callback: () => () => void) => callback(),
      register: (options: Registered['options'], component: unknown) => {
        cells.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, dictionaries, cells, effectLabels }
}

describe('browser half: registration contract', () => {
  it('registers under the package name and exports the client plugin shape', () => {
    const { id, plugin } = loadClient(SOURCE)
    expect(id).toBe('@deepseek-ai/dsh-amberflow-bridge')
    expect(plugin.inject).toEqual(['slots', 'locale', 'configForms'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('registers the row configuration page for this bundle row and the three model labels', () => {
    const { plugin } = loadClient(SOURCE)
    const fake = fakeContext()
    plugin.apply(fake.ctx)
    // One locale dictionary pair, with the page's copy in both languages.
    expect(fake.dictionaries).toHaveLength(1)
    expect(fake.dictionaries[0]!.ns).toBe('settings.amberflowBridge')
    for (const lang of ['en', 'zh']) {
      const dictionary = fake.dictionaries[0]!.dictionaries[lang]!
      expect(Object.keys(dictionary)).toEqual(expect.arrayContaining([
        'modelBaseUrl', 'modelApiKey', 'modelName', 'save', 'saved', 'hint',
      ]))
    }
    // Exactly one slot cell: `plugins.row.config`, keyed `<package>#<row id>`.
    expect(fake.cells).toHaveLength(1)
    expect(fake.cells[0]!.options.name).toBe('plugins.row.config')
    expect(fake.cells[0]!.options.key).toBe('@deepseek-ai/dsh-amberflow-bridge#amberflow-bridge')
    expect(typeof fake.cells[0]!.component).toBe('function')
    // Resources are owned by effects (dictionary + page), so unload disposes both.
    expect(fake.effectLabels).toEqual([
      'amberflow-bridge: dictionaries',
      'amberflow-bridge: configuration page',
    ])
  })

  it('imports no Harness Client package (client bundle purity)', () => {
    expect(SOURCE).not.toMatch(/require\(['"]@deepseek-ai\//)
    expect(SOURCE).toContain("require('react')")
  })
})

describe('repository-root install door: generated client bundle', () => {
  it('client-root.js is in sync with client.js (only the module id and row key differ)', () => {
    // Editing client.js without regenerating would serve the wrong package id / row key; the
    // comparison is the guard (`node scripts/client-root-sync.mjs` regenerates).
    expect(ROOT_SOURCE).toBe(renderRootClient(SOURCE))
  })

  it('registers under the ROOT package name and root row-config key', () => {
    const { id, plugin } = loadClient(ROOT_SOURCE, 'client-root.js')
    expect(id).toBe('amberflow')
    const fake = fakeContext()
    plugin.apply(fake.ctx)
    expect(fake.cells).toHaveLength(1)
    expect(fake.cells[0]!.options).toMatchObject({
      name: 'plugins.row.config',
      key: 'amberflow#amberflow-bridge',
    })
    expect(fake.dictionaries[0]!.ns).toBe('settings.amberflowBridge')
  })

  it('the repository manifest exports the root client bundle, locale and icon', () => {
    // The DSH client scanner only serves a package-root row: the bundle row must name the package.
    expect(REPO_MANIFEST.exports?.['.']).toBe('./integrations/dsh-bridge/src/index.ts')
    expect(REPO_MANIFEST.exports?.['./dsh-plugin']).toBe('./integrations/dsh-bridge/src/index.ts')
    const bundlePatch = fs.readFileSync(path.join(REPO_ROOT, 'dsh-bundle.yml'), 'utf-8')
    expect(bundlePatch).toMatch(/id:\s*amberflow-bridge\s*\n\s*name:\s*amberflow\s*$/m)
    expect(REPO_MANIFEST.exports?.['./client']).toBe('./integrations/dsh-bridge/client-root.js')
    expect(REPO_MANIFEST.exports?.['./locale/*.json']).toBe('./integrations/dsh-bridge/locale/*.json')
    expect(REPO_MANIFEST.dsh?.client?.platform).toBe('web')
    expect(REPO_MANIFEST.dsh?.client?.inject).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-client-locale']))
    expect(REPO_MANIFEST.icon).toBe('./integrations/dsh-bridge/icon.svg')
    for (const target of [
      'integrations/dsh-bridge/client-root.js',
      'integrations/dsh-bridge/icon.svg',
      'integrations/dsh-bridge/locale/en.json',
      'integrations/dsh-bridge/locale/zh.json',
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, target)), target).toBe(true)
    }
  })
})

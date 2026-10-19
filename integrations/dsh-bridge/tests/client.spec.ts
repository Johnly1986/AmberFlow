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

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = fs.readFileSync(path.join(PKG_ROOT, 'client.js'), 'utf-8')

interface Registered {
  options: { name: string; key?: string; [key: string]: unknown }
  component: unknown
}

/** Load the client bundle with a fake module table and a fake React. */
function loadClient(): { id: string; plugin: { inject: string[]; apply(ctx: unknown): void } } {
  let loaded: { id: string; factory: (require: (id: string) => unknown) => { inject: string[]; apply(ctx: unknown): void } } | undefined
  const fakeWindow = {
    __ModuleLoader__: {
      load(registration: typeof loaded): void { loaded = registration },
    },
  }
  // The bundle is a program, not an ESM module: evaluate it with `window` bound, as the script tag does.
  // eslint-disable-next-line no-new-func
  new Function('window', SOURCE)(fakeWindow)
  if (loaded === undefined) throw new Error('client.js did not register with __ModuleLoader__')
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
    const { id, plugin } = loadClient()
    expect(id).toBe('@deepseek-ai/dsh-amberflow-bridge')
    expect(plugin.inject).toEqual(['slots', 'locale', 'configForms'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('registers the row configuration page for this bundle row and the three model labels', () => {
    const { plugin } = loadClient()
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

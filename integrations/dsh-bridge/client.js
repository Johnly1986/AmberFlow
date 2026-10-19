/**
 * AmberFlow bridge — browser half: the plugin's own configuration page.
 *
 * Registers into the Plugins settings page at `plugins.row.config`, keyed
 * `<package name>#<row id>`. The page edits the THREE model fields the bridge
 * exposes (Model URL / Token Key / ModelName) through the shared
 * `ctx.configForms` service, so a save persists into the active profile's patch
 * and the Host applies it through the normal Loader path (the bridge's
 * `loader/volatile-update` listener then re-reads the values without a remount).
 *
 * Deliberately plain JavaScript + `React.createElement` (no JSX, no Harness
 * Client package imports): this file IS the client bundle the module table
 * serves, and styling uses only `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-amberflow-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Bridge package name (also the client module id). */
    const PACKAGE = '@deepseek-ai/dsh-amberflow-bridge'
    /** Loader entry id / settings namespace (`cordis.patch.yml` row id). */
    const ENTRY = 'amberflow-bridge'
    /** `plugins.row.config` key: `<bundle package name>#<row id>`. */
    const ROW_KEY = PACKAGE + '#' + ENTRY
    /** Locale dictionary namespace owned by this plugin. */
    const NS = 'settings.amberflowBridge'

    const en = {
      modelBaseUrl: 'Model URL',
      modelBaseUrlHint: 'OpenAI-compatible endpoint, e.g. https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      modelApiKey: 'Token Key',
      modelApiKeyHint: 'Sent to the engine as OPENAI_API_KEY. Write-only: the saved value is never shown again.',
      modelApiKeySet: 'configured',
      modelApiKeyUnset: 'not set',
      modelApiKeyPlaceholderSet: 'Leave empty to keep the saved token',
      modelApiKeyPlaceholderUnset: 'Paste the token',
      modelName: 'ModelName',
      modelNameHint: 'Model id for the LLM planner and auditor, e.g. qwen3.8-flash.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The engine CLI calls started from now on use this endpoint.',
      rejected: 'The Host refused the change (it may have been edited elsewhere first). Reload and retry.',
      nothingChanged: 'Nothing changed.',
      saveFailed: 'Save failed',
      loading: 'Loading the current configuration…',
      unavailable: 'Configuration is not served by this Host (non-loopback browser or missing Settings service).',
      readOnly: 'This Host document is read-only.',
      hint: 'These settings drive AmberFlow\'s LLM doors (LLM planner, auditor, semantic escalation). '
        + 'Unset fields keep inheriting the environment. The local ONNX decision model is not affected.',
      summaryUnset: 'Model endpoint not configured',
      summaryConfigured: 'Model: ',
    }
    const zh = {
      modelBaseUrl: '模型 URL',
      modelBaseUrlHint: 'OpenAI 兼容端点，例如 https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      modelApiKey: 'Token Key',
      modelApiKeyHint: '作为 OPENAI_API_KEY 传给引擎。只写不读：保存后不会再回显。',
      modelApiKeySet: '已配置',
      modelApiKeyUnset: '未设置',
      modelApiKeyPlaceholderSet: '留空保持已保存的 Token',
      modelApiKeyPlaceholderUnset: '粘贴 Token',
      modelName: 'ModelName',
      modelNameHint: 'LLM 规划器与审计使用的模型 id，例如 qwen3.8-flash。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存。此后启动的引擎 CLI 调用都会使用该端点。',
      rejected: 'Host 拒绝了这次修改（可能已被其他页面先改过）。请刷新后重试。',
      nothingChanged: '没有改动。',
      saveFailed: '保存失败',
      loading: '正在读取当前配置…',
      unavailable: '当前 Host 未提供配置（非回环浏览器或缺少 Settings 服务）。',
      readOnly: '该 Host 文档是只读的。',
      hint: '这三项用于 AmberFlow 的 LLM 门（LLM 规划器、审计、语义升级）；留空则继续继承环境变量。'
        + '本地 ONNX 决策模型不受影响。',
      summaryUnset: '未配置模型端点',
      summaryConfigured: '模型：',
    }

    const INPUT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
    }
    const LABEL_STYLE = { color: 'var(--dsw-alias-label-primary)', fontWeight: '600', fontSize: '13px' }
    const HINT_STYLE = { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '1.5' }
    const BUTTON_STYLE = {
      padding: '7px 16px',
      borderRadius: '8px',
      border: 'none',
      cursor: 'pointer',
      background: 'var(--dsw-alias-brand-primary)',
      color: 'var(--dsw-alias-bg-base)',
      font: 'inherit',
      fontWeight: '600',
    }

    /** Subscribe to a {getSnapshot, subscribe} source with the React state bridge. */
    function useSnapshot(source) {
      const [snapshot, setSnapshot] = React.useState(() => source.getSnapshot())
      React.useEffect(() => {
        const off = source.subscribe(() => setSnapshot(source.getSnapshot()))
        setSnapshot(source.getSnapshot())
        return off
      }, [source])
      return snapshot
    }

    /** A small labelled field row. */
    function Field(props) {
      return h('label', { style: { display: 'grid', gap: '6px' } },
        h('span', { style: LABEL_STYLE }, props.label),
        props.control,
        h('span', { style: HINT_STYLE }, props.hint))
    }

    /**
     * One row's configuration page. `view: 'summary'` is the row's one-liner fallback;
     * `view: 'page'` is the form opened by the row's Configure control.
     */
    function BridgeConfigPage(props) {
      const { form, mirror, t } = props
      const snapshot = useSnapshot(form)
      const described = useSnapshot(mirror)
      const current = snapshot.value ?? {}
      const [draft, setDraft] = React.useState({ baseUrl: '', name: '', token: '' })
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)

      const hostBaseUrl = typeof current.modelBaseUrl === 'string' ? current.modelBaseUrl : ''
      const hostName = typeof current.modelName === 'string' ? current.modelName : ''
      const namespaceView = (described.view?.namespaces ?? []).find((view) => view.ns === ENTRY)
      const tokenSet = (namespaceView?.secrets ?? []).some((secret) =>
        Array.isArray(secret.path) && secret.path[0] === 'modelApiKey' && secret.set === true)

      // Host values are the single source: a new revision (save elsewhere, reload) resets the draft.
      // The token field is never filled from the Host — it is write-only.
      React.useEffect(() => {
        // A new revision (initial load, save, external edit) rebases the visible fields; the
        // write-only token field is always emptied. The status message is not cleared here so a
        // just-saved confirmation survives the revision bump it caused.
        setDraft({ baseUrl: hostBaseUrl, name: hostName, token: '' })
      }, [snapshot.revision, snapshot.status])

      const suffix = hostBaseUrl === '' ? '' : ' @ ' + hostBaseUrl.replace(/^https?:\/\//, '')
      if (props.view === 'summary') {
        const text = hostName === '' && hostBaseUrl === ''
          ? t('summaryUnset')
          : t('summaryConfigured') + (hostName === '' ? '—' : hostName) + suffix
        return h('span', null, text)
      }

      const ready = snapshot.status === 'ready' && snapshot.writable !== false
      const save = async () => {
        const ops = []
        const nextBaseUrl = draft.baseUrl.trim()
        const nextName = draft.name.trim()
        if (nextBaseUrl !== hostBaseUrl) ops.push({ op: 'set', path: ['modelBaseUrl'], value: nextBaseUrl })
        if (nextName !== hostName) ops.push({ op: 'set', path: ['modelName'], value: nextName })
        if (draft.token !== '') ops.push({ op: 'set', path: ['modelApiKey'], value: draft.token })
        if (ops.length === 0) {
          setMessage({ kind: 'warn', text: t('nothingChanged') })
          return
        }
        setBusy(true)
        setMessage(null)
        try {
          const accepted = await form.mutate(ops, snapshot.revision)
          if (accepted) {
            setDraft((previous) => ({ ...previous, token: '' }))
            setMessage({ kind: 'ok', text: t('saved') })
          } else {
            setMessage({ kind: 'error', text: t('rejected') })
          }
        } catch (error) {
          setMessage({
            kind: 'error',
            text: t('saveFailed') + ': ' + (error && error.message ? error.message : String(error)),
          })
        } finally {
          setBusy(false)
        }
      }

      const statusLine = snapshot.status === 'loading'
        ? t('loading')
        : snapshot.status === 'unavailable'
          ? t('unavailable')
          : snapshot.writable === false ? t('readOnly') : null
      const messageColor = message?.kind === 'error'
        ? 'var(--dsw-alias-state-error-primary)'
        : message?.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)'

      return h('div', { style: { display: 'grid', gap: '16px', maxWidth: '640px' }, 'data-amberflow-config': '' },
        statusLine === null ? null : h('p', { style: HINT_STYLE }, statusLine),
        h(Field, {
          label: t('modelBaseUrl'),
          hint: t('modelBaseUrlHint'),
          control: h('input', {
            type: 'url',
            value: draft.baseUrl,
            placeholder: 'https://…/compatible-mode/v1',
            spellCheck: false,
            autoComplete: 'off',
            style: INPUT_STYLE,
            onChange: (event) => setDraft((previous) => ({ ...previous, baseUrl: event.target.value })),
          }),
        }),
        h(Field, {
          label: t('modelApiKey') + ' · ' + (tokenSet ? t('modelApiKeySet') : t('modelApiKeyUnset')),
          hint: t('modelApiKeyHint'),
          control: h('input', {
            type: 'password',
            value: draft.token,
            placeholder: tokenSet ? t('modelApiKeyPlaceholderSet') : t('modelApiKeyPlaceholderUnset'),
            autoComplete: 'new-password',
            style: INPUT_STYLE,
            onChange: (event) => setDraft((previous) => ({ ...previous, token: event.target.value })),
          }),
        }),
        h(Field, {
          label: t('modelName'),
          hint: t('modelNameHint'),
          control: h('input', {
            type: 'text',
            value: draft.name,
            placeholder: 'qwen3.8-flash',
            spellCheck: false,
            autoComplete: 'off',
            style: INPUT_STYLE,
            onChange: (event) => setDraft((previous) => ({ ...previous, name: event.target.value })),
          }),
        }),
        h('p', { style: HINT_STYLE }, t('hint')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('button', {
            type: 'button',
            style: { ...BUTTON_STYLE, opacity: busy || !ready ? '0.55' : '1', cursor: busy || !ready ? 'default' : 'pointer' },
            disabled: busy || !ready,
            onClick: () => { void save() },
          }, busy ? t('saving') : t('save')),
          message === null ? null : h('span', { style: { ...HINT_STYLE, color: messageColor } }, message.text)))
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'amberflow-bridge: dictionaries')
        const form = ctx.configForms.get(ENTRY)
        const mirror = ctx.configForms.describe()
        // The Configure control on the bundle's row exists only while this cell is registered;
        // `whileServed` ties it to the Host actually serving the settings namespace (the plugin
        // being active with its volatile fields projected), so a Settings-less deployment shows
        // no trace of the page.
        ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
        }, (props) => h(BridgeConfigPage, { ...props, form, mirror, t })))), 'amberflow-bridge: configuration page')
      },
    }
  },
})

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
      modelBaseUrl: 'Decision model URL',
      modelBaseUrlHint: 'token-plan compatible-mode base URL, e.g. https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 (the plugin appends /systemone).',
      modelApiKey: 'Decision Token Key',
      modelApiKeyHint: 'Sent to the engine as TOKEN_PLAN_API_KEY. Write-only: the saved value is never shown again.',
      modelApiKeySet: 'configured',
      modelApiKeyUnset: 'not set',
      modelApiKeyPlaceholderSet: 'Leave empty to keep the saved token',
      modelApiKeyPlaceholderUnset: 'Paste the token',
      modelName: 'Decision ModelName',
      modelNameHint: 'Decision model id (TOKEN_PLAN_MODEL); leave empty for the provider default, decision-model-preview.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. App runs started from now on use this online decision model (token-plan).',
      rejected: 'The Host refused the change (it may have been edited elsewhere first). Reload and retry.',
      nothingChanged: 'Nothing changed.',
      saveFailed: 'Save failed',
      loading: 'Loading the current configuration…',
      unavailable: 'Configuration is not served by this Host (non-loopback browser or missing Settings service).',
      readOnly: 'This Host document is read-only.',
      hint: 'These three fields configure AmberFlow\'s ONLINE DECISION MODEL (token-plan SystemOne). '
        + 'With URL and token set, app runs use the token-plan decision provider; empty keeps the local ONNX '
        + 'model (or rules-only). LLM doors (planner/auditor/escalation) are separate and still read OPENAI_* '
        + 'from the environment.',
      summaryUnset: 'Online decision model not configured',
      summaryConfigured: 'Decision model: ',
      remoteSummary: 'Configuration is editable on the Host machine only (loopback).',
      remoteTitle: 'Configuration is available from the Host machine only',
      remoteBody: 'This page is open from a non-loopback address, and DSH does not expose plugin '
        + 'settings to non-loopback pages (it never reads or writes the Host configuration there). '
        + 'Open the DSH web URL on the Host machine — http://127.0.0.1:… with the token printed by '
        + '`dsh web`, or through an SSH tunnel such as `ssh -L 8080:127.0.0.1:3080 <host>` — and edit '
        + 'the three decision-model fields there. The saved values apply to every run, including '
        + 'runs started from this remote page.',
    }
    const zh = {
      modelBaseUrl: '决策模型 URL',
      modelBaseUrlHint: 'token-plan 兼容模式基址，例如 https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1（插件会自动补 /systemone）',
      modelApiKey: '决策模型 Token Key',
      modelApiKeyHint: '作为 TOKEN_PLAN_API_KEY 传给引擎。只写不读：保存后不会再回显。',
      modelApiKeySet: '已配置',
      modelApiKeyUnset: '未设置',
      modelApiKeyPlaceholderSet: '留空保持已保存的 Token',
      modelApiKeyPlaceholderUnset: '粘贴 Token',
      modelName: '决策模型名 ModelName',
      modelNameHint: '决策模型 id（TOKEN_PLAN_MODEL）；留空用 provider 默认 decision-model-preview。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存。此后启动的引擎运行默认使用该线上决策模型（token-plan）。',
      rejected: 'Host 拒绝了这次修改（可能已被其他页面先改过）。请刷新后重试。',
      nothingChanged: '没有改动。',
      saveFailed: '保存失败',
      loading: '正在读取当前配置…',
      unavailable: '当前 Host 未提供配置（非回环浏览器或缺少 Settings 服务）。',
      readOnly: '该 Host 文档是只读的。',
      hint: '这三项配置 AmberFlow 的**线上决策模型**（token-plan SystemOne）：URL 与 Token 都设置后，'
        + '应用运行默认走 token-plan 决策 provider；留空则继续用本地 ONNX 模型（或 rules-only）。'
        + 'LLM 门（规划器/审计/语义升级）是另一条路径，仍从环境变量读 OPENAI_*。',
      summaryUnset: '未配置线上决策模型',
      summaryConfigured: '决策模型：',
      remoteSummary: '配置只能在 Host 本机（loopback）编辑。',
      remoteTitle: '配置只能在 Host 本机编辑',
      remoteBody: '当前页面是经非 loopback 地址打开的，DSH 不向非 loopback 页面暴露插件配置'
        + '（那边既不读也不写 Host 配置）。请在 Host 本机打开 DSH Web（http://127.0.0.1:… 加 '
        + '`dsh web` 打印的 token），或使用 SSH 隧道（如 `ssh -L 8080:127.0.0.1:3080 <host>`）后'
        + '编辑这三个决策模型字段。保存后的值对所有运行生效，也包括从当前远程页面发起的运行。',
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

      // Non-loopback pages never receive the Host settings document (ui-settings switches to
      // memory mode there). Say so explicitly instead of rendering an empty configuration body:
      // the row page exists on every page, but editing is a loopback-only capability.
      const remoteReadOnly = described.status === 'unavailable'
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
        if (remoteReadOnly) return h('span', null, t('remoteSummary'))
        const text = hostName === '' && hostBaseUrl === ''
          ? t('summaryUnset')
          : t('summaryConfigured') + (hostName === '' ? '—' : hostName) + suffix
        return h('span', null, text)
      }
      if (remoteReadOnly) {
        return h('div', { style: { display: 'grid', gap: '10px', maxWidth: '680px' }, 'data-amberflow-config': 'remote' },
          h('p', { style: { ...LABEL_STYLE, fontSize: '14px' } }, t('remoteTitle')),
          h('p', { style: HINT_STYLE }, t('remoteBody')))
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
            placeholder: 'decision-model-preview',
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
        // Register the row page unconditionally: even when the Host does not serve settings to this
        // page (non-loopback access, or a Host without the settings service), the Configure control
        // must exist so the page can explain WHY it is read-only instead of showing an empty body.
        ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
        }, (props) => h(BridgeConfigPage, { ...props, form, mirror, t }))), 'amberflow-bridge: configuration page')
      },
    }
  },
})

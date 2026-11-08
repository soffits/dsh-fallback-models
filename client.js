/*
 * Browser half of dsh-fallback-models: the plugin's settings page.
 *
 * Plain JavaScript in DSH's Client module format (no build step). React comes
 * from the page's module table. The page is a `plugins.row.config` entry, so
 * Plugins > dsh-fallback-models shows a Configure control on the plugin row.
 * Values are read and saved through the `form` the Plugins page passes in
 * (DSH's settings service writes the profile config); the model pickers list
 * DSH's own model catalog (`remote.session.modelCatalog`, the list the
 * composer's model picker shows). Styles use only host theme tokens (--dsw-*).
 */
window.__ModuleLoader__.load({
  id: 'dsh-fallback-models',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo } = React

    const NS = 'dsh-fallback-models'
    const KEY = 'dsh-fallback-models#fallback-models'
    const STYLE_ID = 'dsh-fallback-models'

    // Keep in step with src/policy.js DEFAULT_CODES.
    const DEFAULT_CODES = ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'QUOTA', 'ACCOUNT_QUOTA', 'PI_AI_ERROR']
    // Codes a model stream can report that stay off by default.
    const OPTIONAL_CODES = ['AUTH', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED']

    // ---------------------------------------------------------------- text

    const en = {
      'summary.off': 'Off: no fallback models',
      'summary.on': '{count} fallback model(s)',
      'unavailable': 'This plugin is not running, so its settings cannot be changed right now.',
      'readOnly': 'This deployment stores settings read-only.',
      'chain.title': 'Fallback models',
      'chain.help': 'When a model request still fails after DSH\'s own retries, the work continues on the next model here. Each model is tried at most once per failure. An empty list turns the plugin off.',
      'chain.empty': 'No fallback models.',
      'chain.add': 'Add model',
      'route.provider': 'Provider',
      'route.model': 'Model',
      'route.effort': 'Reasoning effort',
      'route.effortDefault': 'Model default',
      'route.choose': 'Choose…',
      'route.missing': '{id} (not available now)',
      'route.up': 'Move up',
      'route.down': 'Move down',
      'route.remove': 'Remove',
      'presets.title': 'Per agent preset',
      'presets.help': 'A preset listed here uses its own fallback list instead of the one above. Leave its list empty to turn fallback off for that preset.',
      'presets.add': 'Add preset',
      'presets.id': 'Preset id',
      'presets.remove': 'Remove preset',
      'presets.duplicate': 'Each preset can be listed once.',
      'scope.title': 'After a fallback answers',
      'scope.turn': 'Go back to the session\'s own model when that turn ends',
      'scope.session': 'Keep the fallback for the rest of the session',
      'codes.title': 'Switch on these failures',
      'codes.help': 'DSH\'s own retries run first. A cancelled request never switches. Rejected credentials and invalid requests are off by default, because switching would hide a problem you probably want to fix.',
      'code.RATE_LIMIT': 'Rate limited',
      'code.SERVER': 'Provider server error',
      'code.TIMEOUT': 'Timed out',
      'code.TRANSPORT': 'Connection failed',
      'code.EMPTY_RESPONSE': 'Empty response',
      'code.QUOTA': 'Quota or balance used up',
      'code.ACCOUNT_QUOTA': 'Account quota used up',
      'code.PI_AI_ERROR': 'Other provider error (for example, model not found)',
      'code.AUTH': 'Authentication failed',
      'code.CONTEXT_WINDOW_EXCEEDED': 'Context window exceeded',
      'code.INVALID_REQUEST': 'Request rejected as invalid',
      'catalog.loading': 'Loading models…',
      'catalog.error': 'Could not load the model list: {message}',
      'catalog.partial': 'Some providers did not answer; their models are missing from the lists.',
      'save': 'Save',
      'saving': 'Saving…',
      'saved': 'Saved.',
      'discard': 'Discard changes',
      'saveFailed': 'DSH did not accept these values; they are still here to correct.',
      'invalid': 'Every row needs a provider and a model.',
    }

    const zh = {
      'summary.off': '已关闭：没有备用模型',
      'summary.on': '{count} 个备用模型',
      'unavailable': '插件没有在运行，暂时无法修改设置。',
      'readOnly': '此部署的设置是只读的。',
      'chain.title': '备用模型',
      'chain.help': '模型请求在 DSH 自己的重试之后仍然失败时，改用这里的下一个模型继续。每次失败中每个模型最多试一次。列表为空时插件不起作用。',
      'chain.empty': '没有备用模型。',
      'chain.add': '添加模型',
      'route.provider': '提供方',
      'route.model': '模型',
      'route.effort': '推理强度',
      'route.effortDefault': '模型默认',
      'route.choose': '选择…',
      'route.missing': '{id}（当前不可用）',
      'route.up': '上移',
      'route.down': '下移',
      'route.remove': '移除',
      'presets.title': '按智能体预设',
      'presets.help': '列在这里的预设使用自己的备用列表，而不是上面的列表。列表留空即对该预设关闭。',
      'presets.add': '添加预设',
      'presets.id': '预设 ID',
      'presets.remove': '移除预设',
      'presets.duplicate': '每个预设只能列一次。',
      'scope.title': '备用模型回答之后',
      'scope.turn': '这一轮结束后回到会话原来的模型',
      'scope.session': '本会话之后一直用备用模型',
      'codes.title': '遇到这些失败时切换',
      'codes.help': 'DSH 自己的重试先进行。取消的请求从不切换。凭据被拒和无效请求默认不切换，因为切换会掩盖你多半想修好的问题。',
      'code.RATE_LIMIT': '被限流',
      'code.SERVER': '提供方服务器错误',
      'code.TIMEOUT': '超时',
      'code.TRANSPORT': '连接失败',
      'code.EMPTY_RESPONSE': '空回复',
      'code.QUOTA': '额度或余额用完',
      'code.ACCOUNT_QUOTA': '账户额度用完',
      'code.PI_AI_ERROR': '其他提供方错误（例如找不到模型）',
      'code.AUTH': '认证失败',
      'code.CONTEXT_WINDOW_EXCEEDED': '超出上下文窗口',
      'code.INVALID_REQUEST': '请求被判为无效',
      'catalog.loading': '正在加载模型…',
      'catalog.error': '无法加载模型列表：{message}',
      'catalog.partial': '部分提供方没有响应，列表里缺少它们的模型。',
      'save': '保存',
      'saving': '正在保存…',
      'saved': '已保存。',
      'discard': '放弃修改',
      'saveFailed': 'DSH 没有接受这些值，它们还留在这里，可以改正。',
      'invalid': '每一行都需要选提供方和模型。',
    }

    const CSS = `
.dfm-page { display: flex; flex-direction: column; gap: 20px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dfm-section { display: flex; flex-direction: column; gap: 8px; }
.dfm-title { font-weight: 600; font-size: 14px; }
.dfm-help { color: var(--dsw-alias-label-tertiary); line-height: 1.5; }
.dfm-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px; border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); }
.dfm-index { width: 20px; color: var(--dsw-alias-label-tertiary); text-align: right; }
.dfm-select, .dfm-input { min-width: 120px; max-width: 260px; flex: 1 1 140px; padding: 4px 6px; border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
.dfm-button { padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; }
.dfm-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dfm-button:disabled { opacity: 0.5; cursor: default; }
.dfm-button:focus-visible, .dfm-select:focus-visible, .dfm-input:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }
.dfm-primary { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dfm-icon { padding: 4px 7px; }
.dfm-preset { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); }
.dfm-preset-head { display: flex; gap: 6px; align-items: center; }
.dfm-check { display: flex; gap: 8px; align-items: center; }
.dfm-checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 16px; }
.dfm-code { color: var(--dsw-alias-label-caption); font-family: var(--dsw-font-mono); font-size: 11px; }
.dfm-footer { display: flex; gap: 8px; align-items: center; }
.dfm-error { color: var(--dsw-alias-state-error-primary); }
.dfm-note { color: var(--dsw-alias-label-tertiary); }
`

    // ---------------------------------------------------------------- data

    const clean = (route) => ({
      provider: String(route?.provider ?? ''),
      model: String(route?.model ?? ''),
      ...(route?.reasoningEffort ? { reasoningEffort: String(route.reasoningEffort) } : {}),
    })

    /** Editable copy of the accepted values. */
    function toDraft(value) {
      const presets = value?.presets && typeof value.presets === 'object' ? value.presets : {}
      return {
        chain: (Array.isArray(value?.chain) ? value.chain : []).map(clean),
        presets: Object.keys(presets).map(preset => ({ preset, chain: (presets[preset] ?? []).map(clean) })),
        codes: Array.isArray(value?.codes) ? [...value.codes] : [...DEFAULT_CODES],
        scope: value?.scope === 'session' ? 'session' : 'turn',
      }
    }

    /** Draft back to config field values. */
    function fromDraft(draft) {
      const presets = {}
      for (const entry of draft.presets) presets[entry.preset.trim()] = entry.chain.map(clean)
      return { chain: draft.chain.map(clean), presets, codes: [...draft.codes], scope: draft.scope }
    }

    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

    function problems(draft) {
      const chains = [draft.chain, ...draft.presets.map(entry => entry.chain)]
      const incomplete = chains.some(chain => chain.some(route => !route.provider || !route.model))
      const ids = draft.presets.map(entry => entry.preset.trim())
      const badPreset = ids.some(id => id === '') || new Set(ids).size !== ids.length
      return { incomplete, badPreset }
    }

    /** The shared model catalog, loaded once per page visit. */
    function useCatalog(session) {
      const [state, setState] = useState({ status: 'loading', groups: [], partial: false, error: null })
      useEffect(() => {
        let live = true
        Promise.resolve()
          .then(() => session.modelCatalog())
          .then((response) => {
            if (!live) return
            if (!response.ok) throw new Error(response.error?.message ?? 'error')
            setState({ status: 'ready', groups: response.value.groups ?? [], partial: (response.value.failures ?? []).length > 0, error: null })
          })
          .catch((error) => {
            if (live) setState({ status: 'error', groups: [], partial: false, error: error instanceof Error ? error.message : String(error) })
          })
        return () => { live = false }
      }, [session])
      return state
    }

    // ---------------------------------------------------------------- view

    function RouteRow({ route, index, count, groups, t, onChange, onMove, onRemove, disabled }) {
      const group = groups.find(item => item.id === route.provider)
      const model = group?.models.find(item => item.id === route.model)
      const efforts = model?.reasoning?.efforts ?? []
      const label = (text) => ({ 'aria-label': `${text} ${index + 1}` })

      const providerOptions = [h('option', { key: '', value: '' }, t('route.choose'))]
      for (const item of groups) providerOptions.push(h('option', { key: item.id, value: item.id }, item.name || item.id))
      if (route.provider && !group) providerOptions.push(h('option', { key: route.provider, value: route.provider }, t('route.missing', { id: route.provider })))

      const modelOptions = [h('option', { key: '', value: '' }, t('route.choose'))]
      for (const item of group?.models ?? []) modelOptions.push(h('option', { key: item.id, value: item.id }, item.name || item.id))
      if (route.model && !model) modelOptions.push(h('option', { key: route.model, value: route.model }, t('route.missing', { id: route.model })))

      const effortOptions = [h('option', { key: '', value: '' }, t('route.effortDefault'))]
      for (const item of efforts) effortOptions.push(h('option', { key: item.id, value: item.id }, item.name || item.id))
      if (route.reasoningEffort && !efforts.some(item => item.id === route.reasoningEffort)) {
        effortOptions.push(h('option', { key: route.reasoningEffort, value: route.reasoningEffort }, route.reasoningEffort))
      }

      return h('div', { className: 'dfm-row', role: 'group', ...label(t('route.model')) },
        h('span', { className: 'dfm-index' }, `${index + 1}.`),
        h('select', {
          className: 'dfm-select', value: route.provider, disabled, ...label(t('route.provider')),
          onChange: event => onChange({ provider: event.target.value, model: '' }),
        }, providerOptions),
        h('select', {
          className: 'dfm-select', value: route.model, disabled: disabled || !route.provider, ...label(t('route.model')),
          onChange: event => onChange({ ...route, model: event.target.value, reasoningEffort: undefined }),
        }, modelOptions),
        h('select', {
          className: 'dfm-select', value: route.reasoningEffort ?? '', disabled: disabled || !route.model, ...label(t('route.effort')),
          onChange: event => onChange({ ...route, reasoningEffort: event.target.value || undefined }),
        }, effortOptions),
        h('button', { type: 'button', className: 'dfm-button dfm-icon', disabled: disabled || index === 0, title: t('route.up'), 'aria-label': t('route.up'), onClick: () => onMove(-1) }, '↑'),
        h('button', { type: 'button', className: 'dfm-button dfm-icon', disabled: disabled || index === count - 1, title: t('route.down'), 'aria-label': t('route.down'), onClick: () => onMove(1) }, '↓'),
        h('button', { type: 'button', className: 'dfm-button dfm-icon', disabled, title: t('route.remove'), 'aria-label': t('route.remove'), onClick: onRemove }, '×'))
    }

    function ChainEditor({ chain, groups, t, disabled, onChange }) {
      const update = (index, route) => onChange(chain.map((item, i) => (i === index ? clean(route) : item)))
      const move = (index, by) => {
        const next = [...chain]
        const [item] = next.splice(index, 1)
        next.splice(index + by, 0, item)
        onChange(next)
      }
      return h('div', { className: 'dfm-section' },
        chain.length === 0 && h('div', { className: 'dfm-note' }, t('chain.empty')),
        chain.map((route, index) => h(RouteRow, {
          key: index, route, index, count: chain.length, groups, t, disabled,
          onChange: next => update(index, next),
          onMove: by => move(index, by),
          onRemove: () => onChange(chain.filter((_, i) => i !== index)),
        })),
        h('div', null, h('button', {
          type: 'button', className: 'dfm-button', disabled,
          onClick: () => onChange([...chain, { provider: '', model: '' }]),
        }, t('chain.add'))))
    }

    function SettingsPage({ form, session, t }) {
      const state = form.state
      const accepted = useMemo(() => toDraft(state.value), [state.value])
      const [draft, setDraft] = useState(accepted)
      const [status, setStatus] = useState(null)
      // Follow Host changes while nothing is staged.
      const [base, setBase] = useState(accepted)
      useEffect(() => {
        if (same(draft, base)) setDraft(accepted)
        setBase(accepted)
      }, [accepted])
      const catalog = useCatalog(session)

      const disabled = !state.writable || status === 'saving'
      const dirty = !same(fromDraft(draft), fromDraft(accepted))
      const { incomplete, badPreset } = problems(draft)

      const save = async () => {
        const next = fromDraft(draft)
        const current = fromDraft(accepted)
        const ops = []
        for (const field of ['chain', 'presets', 'codes', 'scope']) {
          if (!same(next[field], current[field])) ops.push({ op: 'set', path: [field], value: next[field] })
        }
        if (ops.length === 0) return
        setStatus('saving')
        try {
          setStatus((await form.mutate(ops, state.revision)) ? 'saved' : 'failed')
        } catch {
          setStatus('failed')
        }
      }

      const set = (patch) => { setStatus(null); setDraft({ ...draft, ...patch }) }
      const codes = [...DEFAULT_CODES, ...OPTIONAL_CODES, ...draft.codes.filter(code => !DEFAULT_CODES.includes(code) && !OPTIONAL_CODES.includes(code))]
      const toggle = (code) => set({ codes: draft.codes.includes(code) ? draft.codes.filter(item => item !== code) : [...draft.codes, code] })
      const codeLabel = (code) => {
        const text = t(`code.${code}`)
        return text === `code.${code}` ? code : text
      }

      return h('div', { className: 'dfm-page' },
        !state.writable && h('div', { className: 'dfm-note' }, t('readOnly')),
        catalog.status === 'loading' && h('div', { className: 'dfm-note', role: 'status' }, t('catalog.loading')),
        catalog.status === 'error' && h('div', { className: 'dfm-error', role: 'alert' }, t('catalog.error', { message: catalog.error })),
        catalog.partial && h('div', { className: 'dfm-note' }, t('catalog.partial')),

        h('section', { className: 'dfm-section' },
          h('div', { className: 'dfm-title' }, t('chain.title')),
          h('div', { className: 'dfm-help' }, t('chain.help')),
          h(ChainEditor, { chain: draft.chain, groups: catalog.groups, t, disabled, onChange: chain => set({ chain }) })),

        h('section', { className: 'dfm-section' },
          h('div', { className: 'dfm-title' }, t('scope.title')),
          ['turn', 'session'].map(scope => h('label', { key: scope, className: 'dfm-check' },
            h('input', { type: 'radio', name: 'dfm-scope', checked: draft.scope === scope, disabled, onChange: () => set({ scope }) }),
            t(`scope.${scope}`)))),

        h('section', { className: 'dfm-section' },
          h('div', { className: 'dfm-title' }, t('presets.title')),
          h('div', { className: 'dfm-help' }, t('presets.help')),
          draft.presets.map((entry, index) => h('div', { key: index, className: 'dfm-preset' },
            h('div', { className: 'dfm-preset-head' },
              h('input', {
                className: 'dfm-input', value: entry.preset, placeholder: t('presets.id'), 'aria-label': t('presets.id'), disabled,
                onChange: event => set({ presets: draft.presets.map((item, i) => (i === index ? { ...item, preset: event.target.value } : item)) }),
              }),
              h('button', {
                type: 'button', className: 'dfm-button', disabled,
                onClick: () => set({ presets: draft.presets.filter((_, i) => i !== index) }),
              }, t('presets.remove'))),
            h(ChainEditor, {
              chain: entry.chain, groups: catalog.groups, t, disabled,
              onChange: chain => set({ presets: draft.presets.map((item, i) => (i === index ? { ...item, chain } : item)) }),
            }))),
          h('div', null, h('button', {
            type: 'button', className: 'dfm-button', disabled,
            onClick: () => set({ presets: [...draft.presets, { preset: '', chain: [] }] }),
          }, t('presets.add')))),

        h('section', { className: 'dfm-section' },
          h('div', { className: 'dfm-title' }, t('codes.title')),
          h('div', { className: 'dfm-help' }, t('codes.help')),
          h('div', { className: 'dfm-checks' }, codes.map(code => h('label', { key: code, className: 'dfm-check' },
            h('input', { type: 'checkbox', checked: draft.codes.includes(code), disabled, onChange: () => toggle(code) }),
            h('span', null, codeLabel(code), ' ', h('span', { className: 'dfm-code' }, code)))))),

        h('div', { className: 'dfm-footer' },
          h('button', {
            type: 'button', className: 'dfm-button dfm-primary',
            disabled: disabled || !dirty || incomplete || badPreset, onClick: save,
          }, status === 'saving' ? t('saving') : t('save')),
          h('button', {
            type: 'button', className: 'dfm-button', disabled: disabled || !dirty,
            onClick: () => { setStatus(null); setDraft(accepted) },
          }, t('discard')),
          incomplete && h('span', { className: 'dfm-error' }, t('invalid')),
          badPreset && h('span', { className: 'dfm-error' }, t('presets.duplicate')),
          status === 'saved' && !dirty && h('span', { className: 'dfm-note', role: 'status' }, t('saved')),
          status === 'failed' && h('span', { className: 'dfm-error', role: 'alert' }, t('saveFailed'))))
    }

    function FallbackConfig({ view, form, session, translate: t }) {
      const value = form?.state?.value
      if (view === 'summary') {
        const count = Array.isArray(value?.chain) ? value.chain.length : 0
        return count === 0 ? t('summary.off') : t('summary.on', { count })
      }
      if (!form || form.state.status !== 'ready') return h('div', { className: 'dfm-note' }, t('unavailable'))
      return h(SettingsPage, { form, session, t })
    }

    // ---------------------------------------------------------------- plugin

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = [ctx.locale.register(NS, 'en', en), ctx.locale.register(NS, 'zh', zh)]
          return () => { for (const dispose of disposers) dispose() }
        }, 'fallback-models: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return () => {}
          const tag = document.createElement('style')
          tag.id = STYLE_ID
          tag.dataset.plugin = 'dsh-fallback-models'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'fallback-models: styles')

        const session = ctx.remote.session
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: KEY,
          locale: NS,
          inject: () => ({ session, translate: t }),
        }, FallbackConfig))
      },
    }
  },
})

// Loads the browser half the way DSH's module loader does and renders the
// settings page with React, so a broken page fails here instead of in the GUI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

async function loadClient() {
  let entry
  globalThis.window = { __ModuleLoader__: { load: (module) => { entry = module } } }
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  new Function(source)()
  delete globalThis.window
  assert.equal(entry.id, '@soffits/dsh-fallback-models')
  return entry.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected module ${name}`)
  })
}

/** A Client context with just what apply() uses, capturing the registration. */
function fakeContext() {
  const dictionaries = {}
  const registrations = []
  const definitions = []
  return {
    registrations,
    definitions,
    uiConversation: { events: { register(definition) { definitions.push(definition); return () => {} } } },
    effect(fn) { fn() },
    locale: {
      register(ns, lang, dict) { dictionaries[lang] = dict; return () => {} },
      bind() {
        return (key, params = {}) => (dictionaries.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
      },
    },
    remote: { session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }) } },
    slots: {
      inject(name, fn) { fn() },
      register(options, component) { registrations.push({ options, component }) },
    },
  }
}

const form = (value, extra = {}) => ({
  state: { status: 'ready', value, base: undefined, user: undefined, revision: 1, writable: true, ...extra },
  mutate: async () => true,
})

test('registers a Configure page for its own row and renders summary and page', async () => {
  const plugin = await loadClient()
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'remote', 'remote.session', 'uiConversation'])
  const ctx = fakeContext()
  plugin.apply(ctx)
  const { options, component } = ctx.registrations.find(entry => entry.options.name === 'plugins.row.config')
  assert.equal(options.name, 'plugins.row.config')
  assert.equal(options.key, '@soffits/dsh-fallback-models#fallback-models')
  const props = options.inject()

  const value = {
    chain: [{ provider: 'deepseek', model: 'deepseek-chat' }, { provider: 'other', model: 'x', reasoningEffort: 'high' }],
    presets: { coder: [] },
    codes: ['RATE_LIMIT', 'MY_CODE'],
    scope: 'turn',
  }
  assert.equal(renderToStaticMarkup(React.createElement(component, { ...props, view: 'summary', form: form(value) })), '2 fallback model(s)')
  assert.equal(renderToStaticMarkup(React.createElement(component, { ...props, view: 'summary', form: form({ chain: [] }) })), 'Off: no fallback models')

  const page = renderToStaticMarkup(React.createElement(component, { ...props, view: 'page', form: form(value) }))
  assert.match(page, /Fallback models/)
  assert.match(page, /deepseek-chat \(not available now\)/)
  assert.match(page, /value="coder"/)
  assert.match(page, /MY_CODE/)
  assert.match(page, /Loading models/)

  const missing = renderToStaticMarkup(React.createElement(component, { ...props, view: 'page', form: undefined }))
  assert.match(missing, /not running/)
  const readOnly = renderToStaticMarkup(React.createElement(component, { ...props, view: 'page', form: form(value, { writable: false }) }))
  assert.match(readOnly, /read-only/)
})

test('the settings page offers the same default codes as the host', async () => {
  const { DEFAULT_CODES } = await import('../src/policy.js')
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const match = source.match(/const DEFAULT_CODES = (\[[^\]]*\])/)
  assert.ok(match)
  assert.deepEqual(JSON.parse(match[1].replace(/'/g, '"')), [...DEFAULT_CODES])
})

/** A turn/end the Host plugin records when it interrupts a turn for a switch. */
function switchEnd(reason, turn = 3) {
  return {
    type: 'turn/end',
    seq: 40,
    time: '2026-11-10T21:00:00.000Z',
    data: { turn, reason: { kind: 'aborted', reason: { kind: 'hook', reason } } },
  }
}

function bannerFor(ctx, event) {
  const [definition] = ctx.definitions
  const matched = definition.match(event)
  if (matched === null) return null
  const location = { kind: 'turn', turn: { turn: event.data.turn } }
  const start = { event, role: 'start', location }
  const context = { key: 'k', kind: definition.kind, id: matched.id, matches: [start], start, state: undefined, current: new Map() }
  const node = definition.buildViewNode({ ...context, state: definition.start(context, start, { previous: () => undefined }) })
  const banner = ctx.registrations.find(entry => entry.options.name === 'conversation.chat.node')
  const t = (key, params = {}) => ctx.translate(key, params)
  return { node, html: renderToStaticMarkup(React.createElement(banner.component, { node, t })) }
}

test('a switch shows a banner at the interrupted turn, worded apart for a refusal', async () => {
  const { switchReason } = await import('../src/fallback.js')
  const plugin = await loadClient()
  const ctx = fakeContext()
  plugin.apply(ctx)
  ctx.translate = ctx.locale.bind()
  assert.equal(ctx.definitions.length, 1)
  assert.equal(ctx.definitions[0].target, 'chat')
  const registration = ctx.registrations.find(entry => entry.options.name === 'conversation.chat.node')
  assert.equal(registration.options.key, ctx.definitions[0].kind)

  const a = { provider: 'main', model: 'm1' }
  const b = { provider: 'openrouter', model: 'deepseek/deepseek-v4' }
  const failed = bannerFor(ctx, switchEnd(switchReason(a, b, { code: 'SERVER', message: 'down' })))
  assert.equal(failed.node.kind, registration.options.key)
  assert.equal(failed.node.target, 'chat')
  assert.equal(failed.node.groupTree, 'turn')
  assert.equal(failed.node.anchorSeq, 40)
  assert.match(failed.html, /Model switched: main\/m1 failed/)
  assert.match(failed.html, /\(SERVER\)\. The work continues on openrouter\/deepseek\/deepseek-v4/)

  const refused = bannerFor(ctx, switchEnd(switchReason(a, b, { code: 'REFUSAL', message: 'no' })))
  assert.match(refused.html, /Model switched: main\/m1 refused to answer/)
  assert.match(refused.html, /it was hidden\. openrouter\/deepseek\/deepseek-v4 is answering instead/)
  assert.match(refused.html, /data-model-fallback="refusal"/)

  // Other turn ends, including other plugins' hook cancels, draw nothing.
  assert.equal(bannerFor(ctx, switchEnd('someone-else: stop')), null)
  assert.equal(ctx.definitions[0].match({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), null)
  assert.equal(ctx.definitions[0].match({ type: 'user/message', data: {} }), null)
})

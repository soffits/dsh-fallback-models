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
  assert.equal(entry.id, 'dsh-fallback-models')
  return entry.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected module ${name}`)
  })
}

/** A Client context with just what apply() uses, capturing the registration. */
function fakeContext() {
  const dictionaries = {}
  const registrations = []
  return {
    registrations,
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
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'remote', 'remote.session'])
  const ctx = fakeContext()
  plugin.apply(ctx)
  assert.equal(ctx.registrations.length, 1)
  const { options, component } = ctx.registrations[0]
  assert.equal(options.name, 'plugins.row.config')
  assert.equal(options.key, 'dsh-fallback-models#fallback-models')
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

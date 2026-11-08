import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.js'
import {
  DEFAULT_CODES, boundSummary, candidates, chainFor, failureText, read, routeKey, switches, toSelection,
} from '../src/policy.js'
import { noticeMessage } from '../src/fallback.js'

const A = { provider: 'a', model: 'a1' }
const B = { provider: 'b', model: 'b1' }
const C = { provider: 'c', model: 'c1' }

test('chainFor uses the preset list when the preset is named, else the global one', () => {
  const config = { chain: [A, B], presets: { coder: [C], quiet: [] } }
  assert.deepEqual(chainFor(config, undefined), [A, B])
  assert.deepEqual(chainFor(config, 'other'), [A, B])
  assert.deepEqual(chainFor(config, 'coder'), [C])
  assert.deepEqual(chainFor(config, 'quiet'), [])
  assert.deepEqual(chainFor({ chain: [{ provider: '', model: 'x' }, B] }, null), [B])
})

test('toSelection drops an empty effort and keeps a set one', () => {
  assert.deepEqual(toSelection({ ...A, reasoningEffort: '' }), A)
  assert.deepEqual(toSelection({ ...A, reasoningEffort: 'high' }), { ...A, reasoningEffort: 'high' })
})

test('candidates move forward, wrap, and skip tried routes and duplicates', () => {
  assert.deepEqual(candidates([A, B, C], { provider: 'x', model: 'y' }, new Set()), [A, B, C])
  assert.deepEqual(candidates([A, B, C], B, new Set()), [C, A])
  assert.deepEqual(candidates([A, B, C], C, new Set([routeKey(A)])), [B])
  assert.deepEqual(candidates([A, A, B], { provider: 'x', model: 'y' }, new Set()), [A, B])
  // effort does not make a different route
  assert.deepEqual(candidates([{ ...A, reasoningEffort: 'high' }, B], A, new Set()), [B])
  assert.deepEqual(candidates([], A, new Set()), [])
})

test('switches follows the configured codes but never on ABORTED', () => {
  assert.equal(switches(undefined, 'RATE_LIMIT'), true)
  assert.equal(switches(DEFAULT_CODES, 'AUTH'), false)
  assert.equal(switches(['AUTH'], 'AUTH'), true)
  assert.equal(switches(['ABORTED'], 'ABORTED'), false)
})

test('Config defaults: empty chain, turn scope, default codes, all live-editable', () => {
  const config = Config({})
  assert.deepEqual(read(config.chain), [])
  assert.deepEqual(read(config.presets), {})
  assert.equal(read(config.scope), 'turn')
  assert.deepEqual(read(config.codes), [...DEFAULT_CODES])
  assert.throws(() => Config({ chain: [{ provider: 'a' }] }))
  assert.throws(() => Config({ scope: 'forever' }))
})

test('the notice is a one-line UI notice with the failure and both routes', () => {
  const message = noticeMessage(A, B, { code: 'SERVER', message: 'upstream\n  overloaded' })
  assert.equal(message.role, 'user')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.summary, 'a/a1 failed (SERVER); switched to b/b1')
  assert.match(message.content[0].text, /a\/a1 failed \(SERVER: upstream overloaded\)/)
  assert.ok(Object.isFrozen(message.content[0]))
  assert.equal(failureText({ code: 'X', message: '' }), 'X')
  assert.equal(boundSummary('x'.repeat(200)).length, 120)
})

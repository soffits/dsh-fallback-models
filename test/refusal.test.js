import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/config.js'
import { read } from '../src/policy.js'
import { noticeMessage, switchReason, switchText } from '../src/fallback.js'
import {
  DEFAULT_REFUSAL_MAX_LENGTH, DEFAULT_REFUSAL_PATTERNS, compilePatterns, refusalMatch, toolSucceededThisTurn, watchRefusal,
} from '../src/refusal.js'

const patterns = compilePatterns(DEFAULT_REFUSAL_PATTERNS)
const refused = (text) => refusalMatch(text, patterns) !== undefined

test('refusal and filter-block signatures are detected', () => {
  for (const text of [
    'This request was blocked by Google\'s safety filters.',
    'I\'m sorry, but I can\'t help with that.',
    'Sorry — I cannot assist with this request.',
    'I\'m not able to assist with that.',
    'I won\'t help with that.',
    'I’m unable to help with this.',
    '抱歉，我不能协助完成这个请求。',
    '我无法帮助你处理这类内容。',
    '对不起，无法提供这类内容。',
  ]) assert.ok(refused(text), text)
})

test('ordinary answers that mention a refusal phrase are not refusals', () => {
  for (const text of [
    'Here is the fixed function. It returns early when the list is empty, so the caller can\'t help with that edge case anymore.',
    '"I can\'t help with that" is what the old model said; the new prompt avoids it.',
    `${'Step one: open the settings page and pick the provider. '.repeat(3)}After that, I can't help with that part remotely.`,
    `I can't help with that alone, but here is the full plan:\n${'- a detailed step\n'.repeat(40)}`,
    'I can\'t do that from here; run `make test` on your machine and paste the output.',
    '我不能确定原因，不过日志显示是权限问题。',
    '',
  ]) assert.equal(refused(text), false, text)
  assert.ok(DEFAULT_REFUSAL_MAX_LENGTH >= 200)
})

test('patterns are configurable; invalid ones are skipped and reported', () => {
  const warnings = []
  const custom = compilePatterns(['^nope\\b', '(', ''], (source) => warnings.push(source))
  assert.equal(custom.length, 1)
  assert.deepEqual(warnings, ['('])
  assert.ok(refusalMatch('Nope, not today.', custom))
  assert.equal(refusalMatch('I can\'t help with that.', custom), undefined)
  assert.equal(refusalMatch('I can\'t help with that.', patterns, 10), undefined)
  const config = Config({})
  assert.deepEqual(read(config.refusalPatterns), [...DEFAULT_REFUSAL_PATTERNS])
  assert.equal(read(config.refusalMaxLength), DEFAULT_REFUSAL_MAX_LENGTH)
  assert.deepEqual(read(Config({ notify: { via: 'telegramTopics', to: '7' } }).notify), { via: 'telegramTopics', to: '7' })
})

test('a successful tool call since the user\'s last message rules a refusal out', () => {
  const user = { role: 'user', source: { kind: 'user' } }
  const call = { role: 'assistant', source: { kind: 'model' } }
  assert.equal(toolSucceededThisTurn([user]), false)
  assert.equal(toolSucceededThisTurn([user, call, { role: 'tool', isError: true }]), false)
  assert.equal(toolSucceededThisTurn([user, call, { role: 'tool', isError: false }]), true)
  // A tool result from an earlier turn does not count.
  assert.equal(toolSucceededThisTurn([user, call, { role: 'tool', isError: false }, user]), false)
  // The plugin's own continuation notice is not the user's message.
  assert.equal(toolSucceededThisTurn([user, call, { role: 'tool' }, { role: 'user', source: { kind: 'model-fallback' } }]), true)
})

async function collect(stream) {
  const out = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

async function * reply(blocks) {
  let index = 0
  for (const block of blocks) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
    yield { type: 'block-end', index, block }
    index++
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('the stream wrapper rewrites only a confirmed refusal finish', async () => {
  const options = { patterns, maxLength: 500 }
  const yes = async () => true
  const no = async () => false
  const refusal = [{ type: 'text', text: 'I can\'t help with that.' }]

  const rewritten = await collect(watchRefusal(reply(refusal), yes, options))
  assert.equal(rewritten.length, 4)
  assert.equal(rewritten.at(-1).reason.kind, 'error')
  assert.equal(rewritten.at(-1).reason.failure.code, 'REFUSAL')

  assert.equal((await collect(watchRefusal(reply(refusal), no, options))).at(-1).reason.kind, 'stop')
  const withTool = [...refusal, { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }]
  let asked = false
  const kept = await collect(watchRefusal(reply(withTool), async () => { asked = true; return true }, options))
  assert.equal(kept.at(-1).reason.kind, 'stop')
  assert.equal(asked, false)
})

test('a refusal switch has its own wording everywhere it is shown', () => {
  const a = { provider: 'a', model: 'a1' }
  const b = { provider: 'b', model: 'b1' }
  const refusal = { code: 'REFUSAL', message: 'the model declined to answer: "no"' }
  assert.equal(switchReason(a, b, refusal), 'dsh-fallback-models: a/a1 refused to answer (REFUSAL); continuing on b/b1')
  assert.equal(switchReason(a, b, { code: 'SERVER', message: '' }), 'dsh-fallback-models: a/a1 failed (SERVER); continuing on b/b1')
  const notice = noticeMessage(a, b, refusal)
  assert.equal(notice.source.summary, 'a/a1 refused to answer; switched to b/b1')
  assert.doesNotMatch(notice.content[0].text, /declined|"no"/)
  assert.match(switchText({ from: a, to: b, failure: refusal, refusal: true, sessionId: 's1' }), /refused to answer.*hidden.*b\/b1 is answering instead/)
  assert.match(switchText({ from: a, to: b, failure: { code: 'SERVER', message: 'down' }, refusal: false, sessionId: 's1' }), /a\/a1 failed \(SERVER: down\).*continues on b\/b1/)
})

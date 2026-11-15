import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PARENT_HOPS, conversationPlace, sendNotice, switchText } from '../src/notify.js'

const quiet = { warn() {}, info() {} }

/** A context whose sessions are split between live agents and storage. */
function fakeCtx({ live = {}, stored = {}, services = {} } = {}) {
  const agents = { get: id => live[id] && { session: { header: live[id] } } }
  const sessionPersistence = { stat: async id => stored[id] && { header: stored[id] } }
  const provided = { agents, sessionPersistence, ...services }
  return { get: name => provided[name] }
}

const sub = (id, parentSession) => ({ id, parentSession, origin: 'subagent', delegationDepth: 1 })
const topic = (sessionId, threadId, chatId = -100) => ({ chatId, threadId, name: null, sessionId })

const info = (sessionId, header) => ({
  agent: { session: { header } },
  sessionId,
  from: { provider: 'a', model: 'a1' },
  to: { provider: 'b', model: 'b1' },
  failure: { code: 'SERVER', message: 'down' },
  refusal: false,
})

test('a session bound to a place is its own place', async () => {
  const place = await conversationPlace(fakeCtx(), [topic('other', 1), topic('root', 2)], { id: 'root' })
  assert.deepEqual(place, { topic: topic('root', 2), relation: 'own' })
})

test('a subagent goes up to the nearest ancestor with a place, live or stored', async () => {
  const ctx = fakeCtx({ live: { mid: sub('mid', 'root') }, stored: { root: { id: 'root' } } })
  const place = await conversationPlace(ctx, [topic('root', 9)], sub('leaf', 'mid'))
  assert.deepEqual(place, { topic: topic('root', 9), relation: 'parent' })
  const nearer = await conversationPlace(ctx, [topic('root', 9), topic('mid', 5)], sub('leaf', 'mid'))
  assert.equal(nearer.topic.threadId, 5)
})

test('no place anywhere in the chain, an ordinary fork, a cycle or a lost parent find nothing', async () => {
  const ctx = fakeCtx({
    stored: { root: { id: 'root' }, a: sub('a', 'b'), b: sub('b', 'a') },
  })
  assert.equal(await conversationPlace(ctx, [topic('elsewhere', 1)], sub('leaf', 'root')), undefined)
  // An ordinary fork names its source but is a conversation of its own.
  assert.equal(await conversationPlace(ctx, [topic('root', 1)], { id: 'fork', parentSession: 'root' }), undefined)
  assert.equal(await conversationPlace(ctx, [topic('root', 1)], sub('leaf', 'a')), undefined)
  assert.equal(await conversationPlace(ctx, [topic('root', 1)], sub('leaf', 'gone')), undefined)
  assert.equal(await conversationPlace(ctx, undefined, { id: 'root' }), undefined)
})

test('the walk up stops after MAX_PARENT_HOPS links', async () => {
  const stored = { root: { id: 'root' } }
  let parent = 'root'
  for (let i = 0; i < MAX_PARENT_HOPS + 1; i++) {
    stored[`s${i}`] = sub(`s${i}`, parent)
    parent = `s${i}`
  }
  const ctx = fakeCtx({ stored })
  assert.equal(await conversationPlace(ctx, [topic('root', 1)], sub('leaf', parent)), undefined)
  assert.ok(await conversationPlace(ctx, [topic('root', 1)], sub('leaf', `s${MAX_PARENT_HOPS - 2}`)))
})

test('the message says where the switch happened', () => {
  const base = info('s1', { id: 's1' })
  assert.match(switchText(base), /failed \(SERVER: down\) in session s1\. The work continues on b\/b1/)
  assert.match(switchText(base, 'own'), / in this conversation\./)
  assert.match(switchText(base, 'parent'), / in a subagent of this conversation \(session s1\)\./)
  assert.match(switchText({ ...base, refusal: true }, 'parent'), /refused to answer.*in a subagent of this conversation.*b\/b1 is answering instead/)
})

function recordingService(topics) {
  const sent = []
  const service = { sent, send: async (request) => { sent.push(request) } }
  if (topics) service.topics = () => topics
  return service
}

test('without notify.to, a subagent switch goes to its parent conversation\'s place', async () => {
  const service = recordingService([topic('root', 196576, -42)])
  const ctx = fakeCtx({ live: { root: { id: 'root' } }, services: { topicsService: service } })
  await sendNotice(ctx, quiet, info('child', sub('child', 'root')), { via: 'topicsService' })
  assert.equal(service.sent.length, 1)
  assert.equal(service.sent[0].to, '196576')
  assert.equal(service.sent[0].chat, -42)
  assert.match(service.sent[0].text, /in a subagent of this conversation \(session child\)/)
  assert.deepEqual(service.sent[0].from, { label: 'dsh-fallback-models', sessionId: 'child' })
})

test('without notify.to, a session with no place, or a service without topics, sends nothing', async () => {
  const listed = recordingService([topic('other', 1)])
  const bare = recordingService(undefined)
  const ctx = fakeCtx({ services: { listed, bare } })
  await sendNotice(ctx, quiet, info('web', { id: 'web' }), { via: 'listed', to: '' })
  await sendNotice(ctx, quiet, info('web', { id: 'web' }), { via: 'bare' })
  assert.equal(listed.sent.length, 0)
  assert.equal(bare.sent.length, 0)
})

test('a fixed notify.to gets every message, whatever the session', async () => {
  const service = recordingService([topic('root', 5)])
  const ctx = fakeCtx({ services: { fixed: service } })
  await sendNotice(ctx, quiet, info('root', { id: 'root' }), { via: 'fixed', to: ' 777 ' })
  assert.deepEqual(service.sent.map(request => request.to), ['777'])
  assert.equal(service.sent[0].chat, undefined)
  assert.match(service.sent[0].text, /in session root/)
})

test('a failing service or topics call is logged and never throws', async () => {
  const warnings = []
  const logger = { info() {}, warn: (...args) => warnings.push(args) }
  const ctx = fakeCtx({
    services: {
      throwsSend: { send: async () => { throw new Error('offline') } },
      throwsTopics: { send: async () => {}, topics: () => { throw new Error('not ready') } },
    },
  })
  await sendNotice(ctx, logger, info('root', { id: 'root' }), { via: 'throwsSend', to: '1' })
  await sendNotice(ctx, logger, info('root', { id: 'root' }), { via: 'throwsTopics' })
  await sendNotice(ctx, logger, info('root', { id: 'root' }), { via: 'missing' })
  assert.equal(warnings.length, 3)
})

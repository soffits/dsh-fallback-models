// Runs the plugin inside DSH's real agent loop, LLM runtime, session store and
// llm-retry plugin, with an in-process adapter whose models fail or answer on
// demand. This checks the part a fake cannot: that the loop really starts the
// next turn on the fallback model and that DSH's own retries run first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../index.js'
import { NOTICE_KIND, REASON_PREFIX } from '../src/fallback.js'

const FAST_RETRY = {
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
  initialDelayMs: 1,
  maxDelayMs: 1,
  jitterRatio: 0,
}

/** One adapter for several providers; `behaviour[provider/model]` decides each call. */
class ScriptedAdapter extends LlmAdapter {
  constructor(behaviour, policy = FAST_RETRY) {
    super()
    this.behaviour = behaviour
    this.policy = policy
    this.calls = []
  }

  providerInfo(provider) { return { id: provider, name: provider } }
  providerRetryPolicy() { return this.policy }
  async listModels() { return [] }

  async * stream(options) {
    const key = `${options.provider}/${options.model}`
    this.calls.push(key)
    // A list is consumed one outcome per call, then answers 'ok'.
    const planned = this.behaviour[key]
    const outcome = (Array.isArray(planned) ? planned.shift() : planned) ?? 'ok'
    if (outcome !== 'ok') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: outcome, message: `${key} is down` } } }
      return
    }
    const text = `hello from ${key}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function userMessage(text) {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

async function host(t, behaviour, config, policy) {
  const ctx = new Context()
  t.after(() => ctx.dispose?.() ?? ctx.scope?.dispose?.())
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter(behaviour, policy)
  ctx.llm.registerAdapter(['main', 'backup', 'spare'], adapter)
  await ctx.plugin(LlmRetry)
  await ctx.plugin(plugin, config)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`s-${Math.random().toString(36).slice(2)}`), { provider: 'main', model: 'm1' })
  return { ctx, adapter, agent }
}

async function runTurn(agent, text) {
  agent.followup(userMessage(text))
  // whenIdle follows the continuation turn the plugin starts.
  for (let i = 0; i < 5; i++) {
    await agent.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 10))
    if (agent.status === 'idle') break
  }
}

function events(agent, type) {
  return agent.session.snapshotEvents(0).filter(event => event.type === type)
}

function turnEnds(agent) {
  return events(agent, 'turn/end').map(event => event.data.reason)
}

test('an empty chain changes nothing: the failure ends the turn', async (t) => {
  const { agent, adapter } = await host(t, { 'main/m1': 'SERVER' }, { chain: [] })
  await runTurn(agent, 'hi')
  // first try + 2 DSH retries, then the error stands
  assert.deepEqual(adapter.calls, ['main/m1', 'main/m1', 'main/m1'])
  assert.deepEqual(turnEnds(agent).map(reason => reason.kind), ['error'])
  assert.equal(events(agent, 'model/selection').length, 0)
})

test('after DSH retries run out, the work continues on the next model and returns next turn', async (t) => {
  const { agent, adapter } = await host(t, { 'main/m1': 'SERVER' }, {
    chain: [{ provider: 'backup', model: 'b1' }, { provider: 'spare', model: 's1' }],
  })
  await runTurn(agent, 'hi')
  assert.deepEqual(adapter.calls, ['main/m1', 'main/m1', 'main/m1', 'backup/b1'])

  const ends = turnEnds(agent)
  assert.equal(ends.length, 2)
  assert.equal(ends[0].kind, 'aborted')
  assert.equal(ends[0].reason.kind, 'hook')
  assert.match(ends[0].reason.reason, new RegExp(`^${REASON_PREFIX}: main/m1 failed \\(SERVER\\); continuing on backup/b1`))
  assert.equal(ends[1].kind, 'completed')

  const notices = events(agent, 'user/message').filter(event => event.data.source.kind === NOTICE_KIND)
  assert.equal(notices.length, 1)
  assert.equal(notices[0].data.source.form, 'notice')
  assert.equal(notices[0].data.source.summary, 'main/m1 failed (SERVER); switched to backup/b1')

  const answer = events(agent, 'assistant/message').at(-1)
  assert.equal(answer.data.message.source.model, 'b1')
  // Turn scope: the session's own model is selected again for the next turn.
  assert.deepEqual(agent.model.current(), { provider: 'main', model: 'm1' })

  adapter.behaviour['main/m1'] = 'ok'
  await runTurn(agent, 'again')
  assert.equal(adapter.calls.at(-1), 'main/m1')
})

test('each model is tried once; when all fail the turn ends with the error and the model is restored', async (t) => {
  const { agent, adapter } = await host(t, {
    'main/m1': 'QUOTA', 'backup/b1': 'QUOTA', 'spare/s1': 'QUOTA',
  }, {
    chain: [{ provider: 'backup', model: 'b1' }, { provider: 'spare', model: 's1' }, { provider: 'main', model: 'm1' }],
  })
  await runTurn(agent, 'hi')
  // QUOTA is not in DSH's retry codes, so each model gets exactly one request.
  assert.deepEqual(adapter.calls, ['main/m1', 'backup/b1', 'spare/s1'])
  assert.deepEqual(turnEnds(agent).map(reason => reason.kind), ['aborted', 'aborted', 'error'])
  assert.deepEqual(agent.model.current(), { provider: 'main', model: 'm1' })
})

test('codes outside the list never switch', async (t) => {
  const { agent, adapter } = await host(t, { 'main/m1': 'AUTH' }, {
    chain: [{ provider: 'backup', model: 'b1' }],
  })
  await runTurn(agent, 'hi')
  assert.deepEqual(adapter.calls, ['main/m1'])
  assert.deepEqual(turnEnds(agent).map(reason => reason.kind), ['error'])
})

test('session scope keeps the fallback after the turn', async (t) => {
  const { agent } = await host(t, { 'main/m1': 'RATE_LIMIT' }, {
    chain: [{ provider: 'backup', model: 'b1', reasoningEffort: '' }],
    scope: 'session',
  })
  await runTurn(agent, 'hi')
  assert.deepEqual(agent.model.current(), { provider: 'backup', model: 'b1' })
})

test('fallbacks on unregistered providers are skipped', async (t) => {
  const { agent, adapter } = await host(t, { 'main/m1': 'SERVER' }, {
    chain: [{ provider: 'nowhere', model: 'x' }, { provider: 'spare', model: 's1' }],
  })
  await runTurn(agent, 'hi')
  assert.equal(adapter.calls.at(-1), 'spare/s1')
  assert.equal(turnEnds(agent).at(-1).kind, 'completed')
})

test('the continuation runs before a message queued meanwhile, which then uses the session model', async (t) => {
  const { agent, adapter } = await host(t, { 'main/m1': ['SERVER', 'SERVER', 'SERVER'] }, {
    chain: [{ provider: 'backup', model: 'b1' }],
  })
  agent.followup(userMessage('first'))
  agent.followup(userMessage('second'))
  await runTurn(agent, 'third')
  assert.deepEqual(adapter.calls, ['main/m1', 'main/m1', 'main/m1', 'backup/b1', 'main/m1', 'main/m1'])
  const firstUserAfterNotice = events(agent, 'user/message').map(event => event.data.source.kind)
  assert.equal(firstUserAfterNotice.indexOf(NOTICE_KIND), 1)
  assert.deepEqual(turnEnds(agent).map(reason => reason.kind), ['aborted', 'completed', 'completed', 'completed'])
})

test('with an always-mode retry policy, the fallback is asked first', async (t) => {
  const always = { mode: 'always', initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
  const { agent, adapter } = await host(t, { 'main/m1': 'SERVER' }, {
    chain: [{ provider: 'backup', model: 'b1' }],
  }, always)
  await runTurn(agent, 'hi')
  assert.deepEqual(adapter.calls, ['main/m1', 'backup/b1'])
  assert.equal(turnEnds(agent).at(-1).kind, 'completed')
})

test('a user Stop while DSH waits to retry never switches models', async (t) => {
  const slow = { ...FAST_RETRY, initialDelayMs: 2000, maxDelayMs: 2000 }
  const { agent, adapter } = await host(t, { 'main/m1': 'SERVER' }, {
    chain: [{ provider: 'backup', model: 'b1' }],
  }, slow)
  agent.followup(userMessage('hi'))
  for (let i = 0; i < 100 && events(agent, 'llm/retry').length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(events(agent, 'llm/retry').length, 1)
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(adapter.calls, ['main/m1'])
  assert.equal(events(agent, 'model/selection').length, 0)
  assert.equal(events(agent, 'user/message').filter(event => event.data.source.kind === NOTICE_KIND).length, 0)
  const ends = turnEnds(agent)
  assert.equal(ends.length, 1)
  assert.equal(ends[0].kind, 'aborted')
  assert.equal(ends[0].reason.kind, 'user')
  assert.equal(agent.status, 'idle')
})

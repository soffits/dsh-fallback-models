// The fallback chain on DSH's model-request recovery point.
//
// DSH's agent loop fixes a step's provider/model before the step starts and
// re-runs the same selection when a recovery listener answers "retry"
// (agent/request now rejects a changed model). So a switch cannot happen
// inside the failed step. Instead, once nothing downstream retries, this
// plugin records the fallback as the session's next selection
// (agent.model.select, never the saved default model), interrupts the failed
// turn with a "hook" cancel that keeps the inbox, and queues one short notice
// that starts the next turn on the fallback. The cancel avoids the error path,
// so a subagent's parent or the session list does not see a failed turn that
// is in fact continuing.
import { randomUUID } from 'node:crypto'
import {
  boundSummary, candidates, chainFor, failureText, read, routeKey, routeLabel,
  sameRoute, switches, toSelection,
} from './policy.js'

/** User-message source kind of the continuation notice. */
export const NOTICE_KIND = 'model-fallback'

/** Prefix of the cancel reason recorded on the interrupted turn's turn/end. */
export const REASON_PREFIX = 'dsh-fallback-models'

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) freeze(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * The continuation message. It is model-visible on purpose: DSH starts a turn
 * only for inbox input, and the model has to know why the reply restarts on
 * another model. The `notice` form makes the Web UI show it as one collapsed
 * row with the summary.
 */
export function noticeMessage(from, to, failure) {
  return freeze({
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: `[model fallback: the request to ${routeLabel(from)} failed (${failureText(failure)}). `
        + `Continuing on ${routeLabel(to)}: resume the interrupted work where it stopped.]`,
    }],
    source: {
      kind: NOTICE_KIND,
      form: 'notice',
      summary: boundSummary(`${routeLabel(from)} failed (${failure.code}); switched to ${routeLabel(to)}`),
    },
  })
}

/**
 * The route the failed request used: the logged request header when it
 * belongs to the failing provider, else the agent's current selection.
 */
function failedRoute(agent, provider) {
  const header = agent.session.requestHeader?.()?.config
  if (header && header.provider === provider) return toSelection(header)
  const current = agent.model.current()
  if (current && current.provider === provider) return toSelection(current)
  return { provider, model: current?.model ?? '' }
}

/**
 * Install the fallback chain.
 * @param ctx - plugin context; uses `ctx.llm` to skip unusable fallbacks.
 * @param config - Config value; fields may be volatile references.
 */
export function installFallback(ctx, config) {
  const logger = ctx.logger('fallback-models')
  // One failure chain per Session: what the session used before the first
  // switch, the routes tried since, and the turn that was interrupted last.
  const chains = new Map()
  let disposed = false

  function settings() {
    return {
      chain: read(config.chain) ?? [],
      presets: read(config.presets) ?? {},
      codes: read(config.codes),
      scope: read(config.scope) ?? 'turn',
    }
  }

  function presetOf(agent) {
    try {
      return ctx.get('agentPresets')?.presetForSession?.(agent.session) ?? undefined
    } catch {
      return undefined
    }
  }

  /** First candidate whose provider is registered and whose call config DSH accepts. */
  async function pick(list, tried, signal) {
    let providers
    try {
      providers = new Set(ctx.llm.listProviders().map(info => info.id))
    } catch {
      providers = undefined
    }
    for (const route of list) {
      tried.add(routeKey(route))
      if (providers && !providers.has(route.provider)) {
        logger.warn('skipping fallback %s: provider is not registered', routeLabel(route))
        continue
      }
      try {
        await ctx.llm.resolveCallConfig(route, signal)
      } catch (error) {
        if (signal.aborted) return undefined
        logger.warn('skipping fallback %s: %s', routeLabel(route), error instanceof Error ? error.message : String(error))
        continue
      }
      return route
    }
    return undefined
  }

  async function recover(payload, next) {
    // DSH's own retry and any other recovery go first; act only when nobody
    // downstream retried the request.
    const downstream = await next()
    if (downstream?.kind === 'retry') return downstream
    const { agent, failure, signal, provider, turn } = payload
    if (disposed || signal.aborted || !agent || !failure) return downstream
    const current = settings()
    if (!switches(current.codes, failure.code)) return downstream
    const chain = chainFor(current, presetOf(agent))
    if (chain.length === 0) return downstream

    const session = agent.session
    const failed = failedRoute(agent, provider)
    let state = chains.get(session)
    if (state === undefined) {
      const original = agent.model.current()
      state = { original: original ? toSelection(original) : failed, tried: new Set(), target: undefined, turn }
    }
    state.tried.add(routeKey(failed))
    const target = await pick(candidates(chain, failed, state.tried), state.tried, signal)
    if (disposed || signal.aborted) return downstream
    if (target === undefined) {
      // The turn ends with the original error; its turn/end restores the
      // session's own model when an earlier switch made one.
      logger.warn('%s failed (%s); no untried fallback left', routeLabel(failed), failureText(failure))
      return downstream
    }

    state.agent = agent
    state.target = target
    state.turn = turn
    chains.set(session, state)
    const reason = `${REASON_PREFIX}: ${routeLabel(failed)} failed (${failure.code}); continuing on ${routeLabel(target)}`
    try {
      agent.model.select(target)
      agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
      const notice = noticeMessage(failed, target, failure)
      agent.followup(notice)
      // Run the continuation before anything the user queued meanwhile.
      if (agent.inbox.nextTurn[0]?.id !== notice.id && agent.inbox.remove(notice.id)) {
        agent.inbox.prepend('next-turn', notice)
      }
    } catch (error) {
      logger.error('could not switch %s to %s: %s', routeLabel(failed), routeLabel(target),
        error instanceof Error ? error.message : String(error))
      return downstream
    }
    logger.warn('%s failed (%s); switched to %s', routeLabel(failed), failureText(failure), routeLabel(target))
    return undefined
  }

  ctx.on('agent/request-error', recover)

  ctx.on('agent/disposed', ({ agent }) => {
    if (chains.get(agent.session)?.agent === agent) chains.delete(agent.session)
  })

  // When the plugin goes away mid-chain, hand turn-scoped sessions back.
  ctx.effect(() => () => {
    disposed = true
    const pending = [...chains.values()]
    chains.clear()
    if (settings().scope !== 'turn') return
    for (const state of pending) restore(state)
  }, 'fallback-models: lifetime')

  // A failure chain ends with the first turn that ends after the last switch:
  // the continuation finished, failed for good, or was stopped by the user.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const state = chains.get(session)
    if (state === undefined || event.data?.turn <= state.turn) return
    chains.delete(session)
    // A session refuses appends while it publishes one, so select after this
    // event; the microtask still runs before the loop prepares another turn.
    if (!disposed && settings().scope === 'turn') queueMicrotask(() => restore(state))
  })

  function restore(state) {
    const agent = state.agent
    if (!agent || state.target === undefined) return
    try {
      // Leave it alone when someone picked another model meanwhile.
      if (!sameRoute(agent.model.current(), state.target)) return
      agent.model.select(state.original)
      logger.info('back to %s', routeLabel(state.original))
    } catch (error) {
      logger.warn('could not restore %s: %s', routeLabel(state.original), error instanceof Error ? error.message : String(error))
    }
  }
}

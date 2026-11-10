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
//
// A refused or filter-blocked answer is a successful response to DSH. The
// plugin's `llm/stream` listener (src/refusal.js) turns one into a REFUSAL
// failure, so it reaches the same recovery point as any other failure.
//
// Each switch is announced three ways, none of which needs another plugin:
// a banner in the Web UI conversation (client.js renders the interrupted
// turn's end), a `fallback-models/switch` event other plugins may listen to,
// and, when `notify` names a service, one `send({ to, text, from })` call to
// it (for example a Telegram plugin's topic service).
import { randomUUID } from 'node:crypto'
import {
  REFUSAL_CODE, boundSummary, candidates, chainFor, failureText, isRefusal, read,
  routeKey, routeLabel, sameRoute, switches, toSelection,
} from './policy.js'
import {
  DEFAULT_REFUSAL_MAX_LENGTH, DEFAULT_REFUSAL_PATTERNS, compilePatterns,
  toolSucceededThisTurn, watchRefusal,
} from './refusal.js'

/** User-message source kind of the continuation notice. */
export const NOTICE_KIND = 'model-fallback'

/** Prefix of the cancel reason recorded on the interrupted turn's turn/end. */
export const REASON_PREFIX = 'dsh-fallback-models'

/** Event emitted once per switch: `(payload: SwitchInfo) => void`. */
export const SWITCH_EVENT = 'fallback-models/switch'

/**
 * The cancel reason of an interrupted turn. client.js parses this exact form
 * to draw the banner, so keep the two in step.
 */
export function switchReason(from, to, failure) {
  const what = isRefusal(failure) ? 'refused to answer' : 'failed'
  return `${REASON_PREFIX}: ${routeLabel(from)} ${what} (${failure.code}); continuing on ${routeLabel(to)}`
}

/**
 * The message sent through `notify` for one switch. A refusal is worded
 * apart: the reply was hidden, not lost to an error.
 */
export function switchText(info) {
  const from = routeLabel(info.from)
  const to = routeLabel(info.to)
  if (info.refusal) {
    return `Model fallback: ${from} refused to answer or its filter blocked the reply, in session ${info.sessionId}. `
      + `The refused reply was hidden, and ${to} is answering instead.`
  }
  return `Model fallback: ${from} failed (${failureText(info.failure)}) in session ${info.sessionId}. `
    + `The work continues on ${to}.`
}

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
  // The refusal wording stays neutral and omits the refused text: the new
  // model should answer the request, not weigh another model's refusal.
  const text = isRefusal(failure)
    ? `[model fallback: the reply from ${routeLabel(from)} could not be used. `
      + `Continuing on ${routeLabel(to)}: answer the latest request.]`
    : `[model fallback: the request to ${routeLabel(from)} failed (${failureText(failure)}). `
      + `Continuing on ${routeLabel(to)}: resume the interrupted work where it stopped.]`
  const summary = isRefusal(failure)
    ? `${routeLabel(from)} refused to answer; switched to ${routeLabel(to)}`
    : `${routeLabel(from)} failed (${failure.code}); switched to ${routeLabel(to)}`
  return freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_KIND, form: 'notice', summary: boundSummary(summary) },
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
      refusalPatterns: read(config.refusalPatterns) ?? DEFAULT_REFUSAL_PATTERNS,
      refusalMaxLength: read(config.refusalMaxLength) ?? DEFAULT_REFUSAL_MAX_LENGTH,
      notify: read(config.notify),
    }
  }

  // Compiled refusal patterns, rebuilt when the configured list changes.
  let compiled = { key: undefined, patterns: [] }
  function patterns(sources) {
    const key = JSON.stringify(sources)
    if (compiled.key !== key) {
      compiled = {
        key,
        patterns: compilePatterns(sources, (source, message) => logger.warn('ignoring refusal pattern %s: %s', source, message)),
      }
    }
    return compiled.patterns
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
    const reason = switchReason(failed, target, failure)
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
      // No continuation will run, so let this turn's end restore the model.
      state.turn = turn - 1
      return downstream
    }
    logger.warn('%s failed (%s); switched to %s', routeLabel(failed), failureText(failure), routeLabel(target))
    announce({
      agent,
      sessionId: String(session.id),
      turn,
      from: failed,
      to: target,
      failure,
      refusal: isRefusal(failure),
    }, current.notify)
    return undefined
  }

  /** Tell listeners and the configured notifier about one switch. */
  function announce(info, notify) {
    try {
      ctx.emit(SWITCH_EVENT, info)
    } catch (error) {
      logger.warn('a %s listener failed: %s', SWITCH_EVENT, error instanceof Error ? error.message : String(error))
    }
    const via = typeof notify?.via === 'string' ? notify.via.trim() : ''
    if (via === '') return
    let service
    try {
      service = ctx.get(via)
    } catch {
      service = undefined
    }
    if (typeof service?.send !== 'function') {
      logger.warn('notify: no running service %s with a send method', via)
      return
    }
    const request = {
      to: typeof notify.to === 'string' ? notify.to.trim() : notify.to,
      text: switchText(info),
      files: [],
      from: { label: 'dsh-fallback-models', sessionId: info.sessionId },
    }
    Promise.resolve()
      .then(() => service.send(request))
      .catch(error => logger.warn('notify through %s failed: %s', via, error instanceof Error ? error.message : String(error)))
  }

  /**
   * Whether a refusal of this request should become a REFUSAL failure: the
   * code switches, the agent's chain has a model that is not used up, and no
   * tool call succeeded in this turn. Otherwise the reply stays the answer.
   */
  async function refusalSwitches(options, current, signal) {
    if (disposed || signal?.aborted || !switches(current.codes, REFUSAL_CODE)) return false
    if (toolSucceededThisTurn(options.messages)) return false
    let agent
    try {
      agent = ctx.get('agents')?.get(options.sessionId)
    } catch {
      agent = undefined
    }
    if (!agent) return false
    const chain = chainFor(current, presetOf(agent))
    if (chain.length === 0) return false
    const failed = { provider: options.provider, model: options.model }
    const tried = new Set(chains.get(agent.session)?.tried ?? [])
    tried.add(routeKey(failed))
    const target = await pick(candidates(chain, failed, tried), tried, signal ?? new AbortController().signal)
    return target !== undefined
  }

  // Watch only conversation requests the agent loop builds: they carry the
  // session id and no auxiliary purpose (titles, summaries and the like do).
  ctx.on('llm/stream', (options, next) => {
    const current = settings()
    const list = patterns(current.refusalPatterns)
    if (disposed || list.length === 0 || options?.sessionId === undefined || options.purpose !== undefined
      || !switches(current.codes, REFUSAL_CODE) || chainFor(current, undefined).length === 0 && Object.keys(current.presets).length === 0) {
      return next()
    }
    return watchRefusal(next(), () => refusalSwitches(options, settings(), options.signal), {
      patterns: list,
      maxLength: current.refusalMaxLength,
    })
  })

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

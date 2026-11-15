// The optional message sent through another plugin's service for each switch.
//
// `notify.via` names a running DSH service with `send({ to, chat, text, files,
// from })`. With `notify.to` set, every message goes to that one address. With
// `notify.to` empty, the message goes to the place of the conversation the
// switch happened in: the service's `topics()` lists the places it knows, each
// bound to a session, and a subagent's switch goes to the nearest ancestor
// session that has one. No place in the chain means no message.
import { failureText, routeLabel } from './policy.js'

/** Stop walking up a parent chain after this many links. */
export const MAX_PARENT_HOPS = 32

/**
 * Where the message is going, relative to the switching session.
 * - `address`: a fixed `notify.to`, maybe unrelated to the session.
 * - `own`: the place bound to the switching session itself.
 * - `parent`: the place of an ancestor; the switch happened in a subagent.
 */
function whereText(info, relation) {
  if (relation === 'own') return 'in this conversation'
  if (relation === 'parent') return `in a subagent of this conversation (session ${info.sessionId})`
  return `in session ${info.sessionId}`
}

/**
 * The message for one switch. A refusal is worded apart: the reply was
 * hidden, not lost to an error.
 * @param info - the switch, as emitted on `fallback-models/switch`.
 * @param relation - `address` (default), `own` or `parent`; see whereText.
 */
export function switchText(info, relation = 'address') {
  const from = routeLabel(info.from)
  const to = routeLabel(info.to)
  const where = whereText(info, relation)
  if (info.refusal) {
    return `Model fallback: ${from} refused to answer or its filter blocked the reply, ${where}. `
      + `The refused reply was hidden, and ${to} is answering instead.`
  }
  return `Model fallback: ${from} failed (${failureText(info.failure)}) ${where}. `
    + `The work continues on ${to}.`
}

/** Header of a session by id: a live agent's first, else the stored one. */
async function headerOf(ctx, id) {
  try {
    const live = ctx.get('agents')?.get(id)?.session?.header
    if (live) return live
  } catch {
    // no agent registry: fall through to storage
  }
  try {
    return (await ctx.get('sessionPersistence')?.stat(id))?.header
  } catch {
    return undefined
  }
}

/**
 * The place of a session or of its nearest subagent ancestor.
 * Only `origin: 'subagent'` links are followed: an ordinary fork is a
 * conversation of its own, even when its header names a source session.
 * @param ctx - plugin context, for reading parent headers.
 * @param topics - the service's places: `[{ sessionId, threadId, chatId? }]`.
 * @param header - the switching session's header.
 * @returns `{ topic, relation }`, or undefined when no session in the chain has a place.
 */
export async function conversationPlace(ctx, topics, header) {
  const places = new Map()
  for (const topic of Array.isArray(topics) ? topics : []) {
    if (topic?.sessionId == null || topic.threadId == null) continue
    const key = String(topic.sessionId)
    if (!places.has(key)) places.set(key, topic)
  }
  const seen = new Set()
  let current = header
  for (let hops = 0; current && hops <= MAX_PARENT_HOPS; hops++) {
    const id = String(current.id)
    if (seen.has(id)) return undefined
    seen.add(id)
    const topic = places.get(id)
    if (topic) return { topic, relation: hops === 0 ? 'own' : 'parent' }
    if (current.origin !== 'subagent' || current.parentSession === undefined) return undefined
    current = await headerOf(ctx, current.parentSession)
  }
  return undefined
}

/**
 * Send one switch message through `notify`, when it names a service.
 * Never throws: a missing service, an unknown place or a failed send is
 * logged and changes nothing else.
 * @param ctx - plugin context.
 * @param logger - the plugin's logger.
 * @param info - the switch; `info.agent.session.header` locates the conversation.
 * @param notify - the `notify` setting: `{ via, to }`.
 */
export async function sendNotice(ctx, logger, info, notify) {
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
  const to = typeof notify.to === 'string' ? notify.to.trim() : notify.to == null ? '' : String(notify.to)
  const from = { label: 'dsh-fallback-models', sessionId: info.sessionId }
  try {
    let request
    if (to !== '') {
      request = { to, text: switchText(info, 'address'), files: [], from }
    } else {
      if (typeof service.topics !== 'function') {
        logger.warn('notify: service %s cannot say where a conversation lives (no topics method); set notify.to', via)
        return
      }
      const place = await conversationPlace(ctx, await service.topics(), info.agent?.session?.header)
      if (place === undefined) {
        logger.info('notify: session %s has no place in %s; no message sent', info.sessionId, via)
        return
      }
      request = {
        to: String(place.topic.threadId),
        ...place.topic.chatId == null ? {} : { chat: place.topic.chatId },
        text: switchText(info, place.relation),
        files: [],
        from,
      }
    }
    await service.send(request)
  } catch (error) {
    logger.warn('notify through %s failed: %s', via, error instanceof Error ? error.message : String(error))
  }
}

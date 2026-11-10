// Refusal detection. A provider's content filter or a model that declines
// answers with an ordinary successful response, so DSH reports no failure and
// no recovery runs. This module recognises such a reply at the end of its
// stream and replaces the stream's `stop` finish with an `error` finish of
// code REFUSAL. The agent loop then records the reply as a failed attempt
// (kept in the log, never shown as the answer and never sent to a model) and
// asks `agent/request-error`, where the ordinary fallback chain takes over.
//
// Detection is deliberately narrow, because a false positive throws away a
// good answer and pays for a second model. All of these must hold:
// - the reply has text and no tool calls, and stopped normally;
// - no tool call succeeded since the user's last message (a turn that already
//   did work is not refused, whatever its last words are);
// - the reply is short (`maxLength` characters);
// - a pattern matches within its opening (`OPENING` characters), not right
//   after a quotation mark, so a reply that quotes or discusses a refusal
//   later on is left alone.

import { REFUSAL_CODE } from './policy.js'

/**
 * Built-in refusal signatures: regular-expression sources, matched
 * case-insensitively. They cover provider filter notices and the common
 * opening sentences of a declined request, in English and Chinese.
 */
export const DEFAULT_REFUSAL_PATTERNS = Object.freeze([
  // Provider filter notices (Gemini: "This request was blocked by Google's filters").
  String.raw`\b(?:this|the|your) (?:request|prompt|response|content|message) (?:was|has been|is) blocked\b`,
  String.raw`\bblocked by (?:[\w'’ ]{0,40})?(?:safety|content) (?:filters?|policy|system)\b`,
  // "I can't help with that", "I cannot assist with this request", "I won't help with ...".
  String.raw`\bI (?:can['’]?t|cannot|can not|won['’]?t|will not|am unable to|am not able to) (?:help|assist)(?: you)? with (?:that|this|it|your request|the request)\b`,
  // "I'm not able to assist", "I'm unable to help with that", "Sorry, I'm not able to help".
  String.raw`\bI['’]?m (?:not able|unable|not going) to (?:help|assist)\b`,
  // "I can't provide/fulfil/comply with that".
  String.raw`\bI (?:can['’]?t|cannot|won['’]?t|will not) (?:provide|fulfill|fulfil|comply with) (?:that|this)(?: request)?\b`,
  // Chinese: 我不能协助 / 我无法帮助 / 抱歉，不能提供这类内容 ...
  String.raw`我(?:不能|无法|没法|不可以|不会|不便)(?:协助|帮助|帮你|帮您|帮忙|提供|满足|完成|回答|处理)`,
  String.raw`(?:抱歉|对不起)[，,。！!\s]*(?:不能|无法)(?:协助|帮助|提供|满足|回答)(?:这|此|你|您)`,
])

/** Default upper bound on a refusal's length, in characters. */
export const DEFAULT_REFUSAL_MAX_LENGTH = 500

/** A signature must start within this many characters of the reply. */
export const OPENING = 160

const QUOTES = new Set(['"', '“', '”', '\'', '‘', '’', '「', '『', '`', '«'])

/**
 * Compile configured pattern sources, skipping (and reporting) invalid ones.
 * @param sources - regular-expression sources.
 * @param warn - called with (source, message) for each invalid pattern.
 * @returns compiled case-insensitive Unicode expressions.
 */
export function compilePatterns(sources, warn = () => {}) {
  const out = []
  for (const source of sources ?? []) {
    if (typeof source !== 'string' || source.trim() === '') continue
    try {
      out.push(new RegExp(source, 'iu'))
    } catch (error) {
      warn(source, error instanceof Error ? error.message : String(error))
    }
  }
  return out
}

/**
 * Whether a finished reply's text reads as a refusal or a filter block.
 * @param text - the reply's visible text.
 * @param patterns - compiled signatures.
 * @param maxLength - longest text still treated as a refusal.
 * @returns the matched snippet, or undefined.
 */
export function refusalMatch(text, patterns, maxLength = DEFAULT_REFUSAL_MAX_LENGTH) {
  const reply = String(text ?? '').trim()
  if (reply === '' || reply.length > maxLength) return undefined
  const opening = reply.slice(0, OPENING + 80)
  for (const pattern of patterns) {
    const match = pattern.exec(opening)
    if (!match || match.index > OPENING) continue
    if (QUOTES.has(opening[match.index - 1])) continue
    return match[0]
  }
  return undefined
}

/**
 * Whether a tool call succeeded since the last message the user wrote, read
 * from the request's history (a loop-built request is the session's
 * model-visible log).
 * @param messages - the request messages.
 */
export function toolSucceededThisTurn(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'tool') {
      if (message.isError !== true) return true
      continue
    }
    if (message.role === 'user' && message.source?.kind === 'user') return false
  }
  return false
}

/** The reply's visible text and whether it called tools, from its stream chunks. */
class ReplyReader {
  constructor() {
    this.deltas = new Map()
    this.blocks = new Map()
    this.toolCalls = false
  }

  push(chunk) {
    if (chunk.type === 'text-delta') this.deltas.set(chunk.index, (this.deltas.get(chunk.index) ?? '') + chunk.text)
    else if (chunk.type === 'tool-call-delta') this.toolCalls = true
    else if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') this.toolCalls = true
    else if (chunk.type === 'block-end') {
      if (chunk.block?.type === 'text') this.blocks.set(chunk.index, chunk.block.text)
      else if (chunk.block?.type === 'tool-call') this.toolCalls = true
    }
  }

  text() {
    const indexes = [...new Set([...this.deltas.keys(), ...this.blocks.keys()])].sort((a, b) => a - b)
    return indexes.map(index => this.blocks.get(index) ?? this.deltas.get(index)).join('\n')
  }
}

/** The failure reported for a detected refusal. */
export function refusalFailure(text) {
  const reply = String(text).replace(/\s+/g, ' ').trim()
  const short = reply.length > 160 ? `${reply.slice(0, 159)}…` : reply
  return Object.freeze({ code: REFUSAL_CODE, message: `the model declined to answer: "${short}"` })
}

/**
 * Pass a model stream through unchanged, except that a normal finish of a
 * reply that `check` accepts as a refusal becomes an error finish with code
 * REFUSAL. Chunks are not held back, so answers stream as before.
 * @param stream - the inner stream.
 * @param check - async (text) => boolean, asked only for a finished, short,
 *   tool-free reply whose opening matched a pattern.
 * @param options - `{ patterns, maxLength }`.
 */
export async function * watchRefusal(stream, check, { patterns, maxLength }) {
  const reader = new ReplyReader()
  for await (const chunk of stream) {
    if (chunk.type !== 'finish') {
      reader.push(chunk)
      yield chunk
      continue
    }
    if (chunk.reason?.kind === 'stop' && !reader.toolCalls) {
      const text = reader.text()
      if (refusalMatch(text, patterns, maxLength) !== undefined && await check(text)) {
        yield { type: 'finish', reason: { kind: 'error', failure: refusalFailure(text) } }
        continue
      }
    }
    yield chunk
  }
}

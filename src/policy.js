// Pure decisions of the fallback chain: which chain applies, which failures
// switch, and which model comes next. No DSH services here, so every rule is
// unit-testable on plain data.

/**
 * Failure codes that switch to the next model by default. They mean the model
 * could not answer right now (overloaded, down, out of quota), so another
 * model can. DSH's own retry runs first for the transient ones.
 *
 * Only failures a model stream reports reach the recovery point. Errors DSH
 * raises while preparing a request (UNKNOWN_MODEL, MODEL_UNSUPPORTED,
 * MISSING_CREDENTIAL, NO_ADAPTER) end the turn before any request is sent, so
 * listing them would do nothing. PI_AI_ERROR is the pi-ai adapter's code for
 * a provider error it cannot classify, such as a 404 for a model the provider
 * no longer serves.
 */
export const DEFAULT_CODES = Object.freeze([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'PI_AI_ERROR',
  'REFUSAL',
])

/**
 * The code for a refused or filter-blocked answer. Most adapters deliver a
 * refusal as an ordinary successful response, and the plugin's `llm/stream`
 * listener turns a detected one into a failure with this code (see
 * src/refusal.js). An adapter that knows a reply was refused may report the
 * code itself (dsh-oh-my-claude's `refusalAsFailure`); that failure switches
 * like any other.
 */
export const REFUSAL_CODE = 'REFUSAL'

/**
 * Codes that never switch, whatever the config says: a cancelled request is
 * the user's (or a plugin's) decision, not a model failure.
 */
export const NEVER_CODES = Object.freeze(['ABORTED'])

/** Read a schemastery volatile field (`{ get() }`) or a plain value. */
export function read(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/** Stable identity of a provider/model route; effort is not part of it. */
export function routeKey(route) {
  return JSON.stringify([route.provider, route.model])
}

export function sameRoute(a, b) {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.model === b.model
}

/** `provider/model`, the way the Web UI names a route. */
export function routeLabel(route) {
  return `${route.provider}/${route.model}`
}

/** A detached selection, omitting an absent or empty reasoning effort. */
export function toSelection(route) {
  const effort = route.reasoningEffort
  return {
    provider: route.provider,
    model: route.model,
    ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}),
  }
}

/**
 * The chain for one agent: its preset's own list when the config names that
 * preset (an empty list there turns fallback off for the preset), otherwise
 * the global list. Routes missing a provider or model are dropped.
 * @param config - resolved config values `{ chain, presets }`.
 * @param preset - the agent's preset id, or undefined.
 */
export function chainFor(config, preset) {
  const presets = config.presets ?? {}
  const list = preset !== undefined && preset !== null && Object.hasOwn(presets, preset)
    ? presets[preset]
    : config.chain
  return (list ?? []).filter(route => route && route.provider && route.model).map(toSelection)
}

/** Whether a failure code may switch models under the configured codes. */
export function switches(codes, code) {
  if (NEVER_CODES.includes(code)) return false
  return (codes ?? DEFAULT_CODES).includes(code)
}

/**
 * Candidates after a failure, in order: when the failed route is in the
 * chain, the entries after it and then the ones before it (so the chain moves
 * forward); otherwise the whole chain. The failed route and everything
 * already tried in this failure chain are left out, so each model is tried at
 * most once per failure chain.
 * @param chain - ordered fallback selections.
 * @param failed - the route whose request failed.
 * @param tried - route keys already used in this failure chain.
 */
export function candidates(chain, failed, tried) {
  const at = chain.findIndex(route => sameRoute(route, failed))
  const rest = at === -1 ? chain : [...chain.slice(at + 1), ...chain.slice(0, at)]
  const seen = new Set(tried)
  const out = []
  for (const route of rest) {
    const key = routeKey(route)
    if (sameRoute(route, failed) || seen.has(key)) continue
    seen.add(key)
    out.push(route)
  }
  return out
}

/** Short account of a failure for notices and logs. */
export function failureText(failure) {
  const message = String(failure.message ?? '').replace(/\s+/g, ' ').trim()
  const short = message.length > 160 ? `${message.slice(0, 159)}…` : message
  return short ? `${failure.code}: ${short}` : String(failure.code)
}

/** Whether a failure is a refused answer rather than a failed request. */
export function isRefusal(failure) {
  return failure?.code === REFUSAL_CODE
}

/** Bound a one-line UI summary to DSH's notice limit (120 characters). */
export function boundSummary(text) {
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`
}

import z from '@deepseek-ai/schemastery'
import { DEFAULT_CODES } from './policy.js'
import { DEFAULT_REFUSAL_MAX_LENGTH, DEFAULT_REFUSAL_PATTERNS } from './refusal.js'

const Route = z.object({
  provider: z.string().required().description('Provider id, as in the model picker (for example deepseek).'),
  model: z.string().required().description('Model id within that provider.'),
  reasoningEffort: z.string().description('Reasoning effort id for this model. The model\'s default when empty.'),
})

const Chain = z.array(Route)

// Every field is volatile: the Settings page and config-file edits apply to
// the next failure without restarting the plugin.
export const Config = z.object({
  chain: Chain.default([]).volatile()
    .description('Fallback models, tried in order when a model request keeps failing. Empty turns the plugin off.'),
  presets: z.dict(Chain).default({}).volatile()
    .description('Per agent preset: a preset id mapped to its own fallback list, used instead of the global one. An empty list turns fallback off for that preset.'),
  codes: z.array(z.string()).default([...DEFAULT_CODES]).volatile()
    .description('Failure codes that switch to the next model (after DSH\'s own retries). ABORTED never switches. REFUSAL is the plugin\'s own code for a refused or filter-blocked answer (see refusalPatterns); leave it out to keep such answers. Add AUTH to also switch on rejected credentials. Errors raised before a request is sent (unknown model, missing credential) end the turn without reaching this plugin.'),
  scope: z.union(['turn', 'session']).default('turn').volatile()
    .description('turn: go back to the session\'s own model when the turn that used the fallback ends. session: keep the fallback for the rest of the session.'),
  refusalPatterns: z.array(z.string()).default([...DEFAULT_REFUSAL_PATTERNS]).volatile()
    .description('Refusal signatures: regular expressions, matched case-insensitively. A reply counts as refused (code REFUSAL) only when one matches within its first 160 characters (not right after a quotation mark), the reply is at most refusalMaxLength characters, it calls no tools, and no tool call succeeded since the user\'s last message. The default list covers provider filter notices and common English and Chinese refusals. Empty turns refusal detection off.'),
  refusalMaxLength: z.natural().default(DEFAULT_REFUSAL_MAX_LENGTH).volatile()
    .description('Longest reply, in characters, that can count as a refusal.'),
  notify: z.object({
    via: z.string().description('Name of a running DSH service with a send({ to, text, files, from }) method, such as a Telegram plugin\'s topic service. Empty: no message.'),
    to: z.string().description('Address that service understands, such as a topic\'s thread id.'),
  }).default({}).volatile()
    .description('Optional: also send one short message per switch through another plugin\'s service. Nothing is required; the switch is always shown in the conversation and emitted as the fallback-models/switch event.'),
})

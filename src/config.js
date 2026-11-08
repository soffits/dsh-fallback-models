import z from '@deepseek-ai/schemastery'
import { DEFAULT_CODES } from './policy.js'

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
    .description('Failure codes that switch to the next model (after DSH\'s own retries). ABORTED never switches. Add AUTH, MISSING_CREDENTIAL or INVALID_CREDENTIAL to also switch on credential problems.'),
  scope: z.union(['turn', 'session']).default('turn').volatile()
    .description('turn: go back to the session\'s own model when the turn that used the fallback ends. session: keep the fallback for the rest of the session.'),
})

/**
 * DeepSeek Harness Host plugin: a fallback model chain. When a model request
 * keeps failing after DSH's own retries, the work continues on the next model
 * in a configured list instead of ending the turn. See src/fallback.js for
 * how the switch is made, and README.md for the behaviour.
 */
import { Config } from './src/config.js'
import { installFallback } from './src/fallback.js'

export const name = 'dsh-fallback-models'
export const inject = ['llm']
export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ chain: unknown, presets: unknown, codes: unknown, scope: unknown }} config
 */
export function apply(ctx, config) {
  installFallback(ctx, config)
}

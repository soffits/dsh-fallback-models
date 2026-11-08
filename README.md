# dsh-fallback-models

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that adds a fallback model chain. When a model request keeps failing after DSH's own retries, the work continues on the next model in your list instead of the turn ending with an error.

- An ordered list of fallback models (provider, model, optional reasoning effort), global and optionally per agent preset.
- Runs after DSH's retry plugin (`@deepseek-ai/dsh-llm-retry`) has given up, and only for failures where another model can help.
- Each model is tried at most once per failure, so it never loops.
- By default the session goes back to its own model when the turn that needed the fallback ends.
- The conversation shows a notice row such as `deepseek/deepseek-chat failed (RATE_LIMIT); switched to openrouter/qwen3`.
- Edited on the plugin's settings page with model pickers, or in the profile config.
- An empty list (the default) changes nothing.

## Install

Install it into a profile (here `web`) straight from GitHub:

```sh
dsh plugin --profile web add github:soffits/dsh-fallback-models
```

or from the Plugins page, or with the plugin manager (`install_bundle` with `github:soffits/dsh-fallback-models` or the path of a local clone). Then open **Plugins > dsh-fallback-models** and press **Configure** on the `fallback-models` row. Requires DSH 0.2.2-rc.1 or later within 0.2.x, and Node.js 22 or later.

## Configure

The settings page lists the models from DSH's model catalog (the same list as the composer's model picker), so you pick a provider, a model and, when the model has them, a reasoning effort. Rows can be reordered. The same values live on the plugin's row in the profile patch:

```yaml
- id: fallback-models
  name: 'dsh-fallback-models'
  config:
    chain:
      - provider: deepseek
        model: deepseek-reasoner
      - provider: openrouter
        model: qwen/qwen3-coder
        reasoningEffort: high
    presets:
      reviewer:
        - provider: openrouter
          model: anthropic/claude-sonnet-4.5
      quick: []            # no fallback for this preset
    scope: turn            # or: session
    # codes: [...]         # optional, see below
```

| Field | Default | Meaning |
|---|---|---|
| `chain` | `[]` | Fallback models, tried in order. Empty turns the plugin off. |
| `presets` | `{}` | Preset id mapped to its own list, used instead of `chain` for agents of that preset. An empty list turns fallback off for that preset. |
| `scope` | `turn` | `turn`: go back to the session's own model when the turn that used the fallback ends. `session`: keep the fallback for the rest of the session. |
| `codes` | see below | Failure codes that switch models. |

All fields apply to the next failure without restarting DSH.

### Which failures switch

DSH's adapters report each failed request with a provider-neutral code. These switch by default:

| Code | Meaning |
|---|---|
| `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE` | Overloaded, down, slow or broken connection. DSH retries these on the same model first. |
| `QUOTA`, `ACCOUNT_QUOTA` | Balance or quota used up. DSH does not retry these, so the switch is immediate. |
| `UNKNOWN_MODEL`, `MODEL_UNSUPPORTED` | The model is gone or cannot take the request. |

These never switch by default, because changing models would hide a problem you probably want to fix: `AUTH`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL` (credentials), `NO_ADAPTER` (provider not set up), `CONTEXT_WINDOW_EXCEEDED` (DSH's compaction handles it), `INVALID_REQUEST`. Add any of them to `codes`, or tick them on the settings page, if you want the switch anyway. A cancelled request (`ABORTED`, or a turn you stopped) never switches.

## How it works

DSH's agent loop offers one public place for model-request recovery: the `agent/request-error` waterfall (declared in `@deepseek-ai/dsh-agent`). `dsh-llm-retry` is a listener there, and when its budget is used up or the failure is not one it retries, it hands the failure to the next listener ("downstream recovery"). This plugin is that next listener. It calls `next()` first, so DSH's retry and any other recovery (context compaction, image offload) always get their turn, and it acts only when nobody asked for a retry.

The model of a step is fixed before the step starts: a `retry` answer re-runs the same provider and model, and the 0.2.2 loop rejects a model change made in `agent/request`. DSH's documented way to change models is `agent.model.select()` before the next step. So the plugin:

1. picks the next model in the list that has a registered provider and that DSH's LLM service accepts (`llm.resolveCallConfig`); unusable entries are skipped;
2. records it as the session's next model with `agent.model.select()` (a `model/selection` session event; the saved default model is not touched);
3. stops the failed turn with a plugin cancel (`{ kind: 'hook' }`, keeping queued messages), which records why on the turn's `turn/end` event;
4. queues a short notice message, put ahead of anything you queued meanwhile, which starts the next turn on the fallback model.

The new turn sees the whole conversation, including your last message and any tool results, plus the plugin's notice (and, in Web UI sessions, DSH's own `[model changed: ...]` note), and carries on. If the fallback fails too, the same happens with the next model. When the list runs out, the turn ends with the original error. With `scope: turn`, the session's own model is selected again as soon as that continuation turn ends (unless you picked another model in the meantime).

### What you see

- In the conversation, the notice row: `<old model> failed (<code>); switched to <new model>`. Expanding it shows the full text the model got.
- The interrupted turn ends as stopped, with the reason `dsh-fallback-models: <old> failed (<code>); continuing on <new>` in the session log.
- The composer's model picker shows the fallback model while it is in use.
- Host log lines from `fallback-models` for every switch, skipped entry and restore.

### What the model sees

One user-role notice per switch, for example:

```text
[model fallback: the request to deepseek/deepseek-chat failed (RATE_LIMIT: Too many requests). Continuing on openrouter/qwen/qwen3-coder: resume the interrupted work where it stopped.]
```

DSH starts a turn only when there is input, so this message is what starts the continuation, and it also tells the model why its reply restarts. Nothing else of the plugin reaches the model. The failed attempt itself stays out of the model's view, as with DSH's own retries.

## Limits

- **A switch costs one turn boundary.** The failed turn shows as stopped and a new turn begins. DSH has no public way to change the model inside a running step, so this is the closest honest option.
- **Goals pause.** If the failure happens during an automatic goal round, DSH's goal driver sees the stopped turn and pauses the goal; the work itself continues, and you resume the goal afterwards.
- **Always-mode retry.** With a provider `retryPolicy` of `mode: always`, DSH asks downstream recovery first, so the switch happens on the first failure, without same-model retries. Once the list is used up, always mode retries the last model forever, as configured.
- **Restarts.** The chain state (which models were tried, what to go back to) is kept in memory. If DSH restarts while a fallback is in use, the session stays on the fallback model until you change it.
- **Billing.** Each fallback request is a new, billed request to that provider, and the continuation re-sends the conversation.

## Development

```sh
npm ci
npm run check
npm test
```

`test/loop.test.js` runs the plugin inside DSH's real agent loop, LLM service, session store and `dsh-llm-retry`, with an in-process adapter whose models fail on demand. `test/client.test.js` loads the settings page the way DSH's module loader does and renders it.

## License

[MIT](LICENSE)

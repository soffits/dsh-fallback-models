# dsh-fallback-models

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that adds a fallback-model chain. When a model request still fails after DSH uses up its own retries, work continues using the next model you listed instead of ending the turn with an error.

- An ordered list of fallback models (provider, model, and optionally reasoning effort), set globally and, if you like, per agent preset.
- Kicks in after DSH's retry plugin (`@deepseek-ai/dsh-llm-retry`) runs out of attempts, and only when a different model could plausibly fix the failure.
- Also kicks in when a model refuses to answer or a provider's content filter blocks the reply, which DSH otherwise treats as a normal answer.
- For any one failure, each model gets at most one attempt, so loops cannot occur.
- By default, once the turn needing the fallback ends, the session goes back to the model it started with.
- Every switch shows a banner in the conversation, such as **Model switched: deepseek/deepseek-chat failed**, and can also be sent to another plugin's message service (a Telegram topic, for example).
- You can change it through model pickers from the plugin's settings page or in the profile configuration.
- An empty list, the default, leaves behavior unchanged.

## Installation

Install it from npm, adding it to a profile (`web` here):

```sh
dsh plugin --profile web add @soffits/dsh-fallback-models
```

You can also use the Plugins page, or the plugin manager (`install_bundle` with `@soffits/dsh-fallback-models` or a local clone's path). Then open **Plugins > @soffits/dsh-fallback-models** and press **Configure** on the `fallback-models` row. Requirements are DSH 0.2.2-rc.1 or later in the 0.2.x series and Node.js 22 or later.

## Configuration

The settings page lists models from DSH's catalog (the same set the model picker inside the composer shows), so you can pick a provider, choose a model, and set a reasoning effort when the model supports one. Rows can be reordered. The same values live inside the profile patch attached to the plugin's row:

```yaml
- id: fallback-models
  name: '@soffits/dsh-fallback-models'
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
    # refusalPatterns: [...]   # optional, see "Refused answers"
    notify:                # optional, see "Notifications"
      via: telegramTopics
      to: "196554"
```

| Field | Default | Meaning |
|---|---|---|
| `chain` | `[]` | Fallback models tried in order. An empty value disables the plugin. |
| `presets` | `{}` | Maps a preset id to a separate list that overrides `chain` for agents in that preset. An empty list turns fallback off for it. |
| `scope` | `turn` | `turn`: switch back to the model the session started with when the fallback-using turn ends. `session`: keep the fallback until the session ends. |
| `codes` | see below | Failure codes that cause a switch to another model. |
| `refusalPatterns` | built-in list | Regular expressions that mark a reply as refused. An empty list turns refusal detection off. |
| `refusalMaxLength` | `500` | Longest reply, in characters, that can count as a refusal. |
| `notify` | none | `{ via, to }`: a DSH service with a `send({ to, text, files, from })` method, and the address to pass it. |

All fields apply at the next failure; DSH does not need a restart.

### Failures that cause a switch

DSH's adapters report every failed request with a code independent of the provider. By default, these codes cause a switch:

| Code | Meaning |
|---|---|
| `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE` | Service overload, outage, slowness, or a broken connection. DSH retries these before any model switch. |
| `QUOTA`, `ACCOUNT_QUOTA` | Balance or quota used up. DSH does not retry these, so the switch is immediate. |
| `PI_AI_ERROR` | A provider error the pi-ai adapter failed to classify, for example a 404 for a withdrawn model. |
| `REFUSAL` | The model refused to answer, or a content filter blocked the reply. This plugin's own code, which an adapter may also report itself; see below. |

`AUTH` (rejected credentials), `INVALID_REQUEST`, and `CONTEXT_WINDOW_EXCEEDED` (handled by DSH compaction) do not switch models by default, because a model change would hide a problem you probably need to fix. To allow it anyway, include them in `codes` or tick them via the settings page. Cancelled requests (`ABORTED`, or any turn you stopped) never switch.

### Refused answers

A refusal arrives as an ordinary successful reply, so DSH reports no failure for it. The plugin watches each conversation request's stream and, when the reply finishes, treats it as a `REFUSAL` failure only if all of these hold:

- one of `refusalPatterns` matches within the first 160 characters, and not right after a quotation mark. The built-in list covers filter notices ("This request was blocked by ... filters") and the usual opening refusals ("I can't help with that", "I'm not able to assist", "I won't help with", 我不能协助, 我无法帮助 and similar);
- the reply is at most `refusalMaxLength` characters and calls no tools;
- no tool call succeeded since your last message;
- the chain still has an untried, usable model.

Then DSH records the reply as a failed attempt, which is kept in the session log but is not shown as the answer and is not sent to any model, and the switch works as it does for an error. The refused text can flash briefly while it streams. When none of these hold, the reply stays the answer, and when every model refuses, the last refusal is the answer. A reply that only quotes or discusses a refusal, or a long answer that happens to say "I can't help with that part", is left alone. Remove `REFUSAL` from `codes` to keep refusals as answers.

An adapter that knows a reply was refused can also end the request with a failure of code `REFUSAL` itself; [dsh-oh-my-claude](https://github.com/lcestou/dsh-oh-my-claude) does that for Claude Code with `refusalAsFailure: true`, including a reply a safety classifier stopped. Such a failure switches like any other code in `codes`: the patterns, the length limit and the tool-call rule above do not apply, since nothing has to be guessed.

This plugin sees only failures reported by the model request. When DSH hits an error while it prepares a request (a model id that does not exist, or a missing API key), nothing is sent, the turn ends, and fallback does not happen.

## How it works

DSH's agent loop exposes one public route for recovering model requests: the `agent/request-error` waterfall (declared in `@deepseek-ai/dsh-agent`). `dsh-llm-retry` listens there; after its budget runs out, or when it does not retry that kind of failure, it hands the failure to the next listener ("downstream recovery"). This plugin is that next listener. Since it invokes `next()` first, DSH's retry and other recovery paths (context compaction, image offload) always get their turn, and it acts only when nothing asked for a retry.

The model for a step is fixed before the step starts: a `retry` answer reruns that same provider/model, and the 0.2.2 loop forbids changing models inside `agent/request`. DSH's documented way to change models is calling `agent.model.select()` ahead of the next step. So the plugin does this:

1. picks the next listed model with a registered provider that DSH's LLM service will accept (`llm.resolveCallConfig`), skipping unusable entries;
2. makes it the model the session uses next through `agent.model.select()` (a `model/selection` session event; the stored default model stays as it was);
3. closes the failed turn with a plugin cancel (`{ kind: 'hook' }`, keeping queued messages), recording the reason on that turn's `turn/end` event;
4. queues a short notice message ahead of anything you queued meanwhile, and that message launches the following turn using the fallback model.

The new turn sees the whole conversation (your latest message, any tool results, the plugin's notice, and in the Web UI DSH's own `[model changed: ...]` note) and carries on. If the fallback fails too, the next model goes through the same process. When the list runs out, the turn ends with the original error. With `scope: turn`, the session's starting model is reselected as soon as that continuation turn ends (unless you picked another model in between).

### What you see

- A banner at the end of the interrupted turn: **Model switched: `<old>` failed** with the code and the model taking over, or for a refusal **Model switched: `<old>` refused to answer**, saying the reply was hidden. The continuation turn below it starts with DSH's collapsed "Execution requested" card, which holds the text the model got.
- The turn that was interrupted is flagged as stopped, and the session log stores this reason: `dsh-fallback-models: <old> failed (<code>); continuing on <new>`.
- While active, the fallback model appears in the composer picker.
- Host log entries tagged `fallback-models` appear whenever a switch, skip, or restore happens.

### Notifications

The plugin depends on no other plugin. Each switch is also:

- emitted as the Host event `fallback-models/switch`, with `{ agent, sessionId, turn, from, to, failure, refusal }`, for any plugin that wants to listen;
- sent through `notify`, when set: the plugin looks up the service named by `via` at the time of the switch and calls its `send({ to, text, files: [], from: { label: 'dsh-fallback-models', sessionId } })` with one short message (worded apart for a refusal). Any plugin that provides such a service can receive these messages, for example a Telegram plugin's topic service with a topic's thread id as `to`. A missing service or a failed send is logged and changes nothing else.

### What reaches the model

Each switch produces one user-role notice, for example:

```text
[model fallback: the request to deepseek/deepseek-chat failed (RATE_LIMIT: Too many requests). Continuing on openrouter/qwen/qwen3-coder: resume the interrupted work where it stopped.]
```

After a refusal it reads `[model fallback: the reply from <old> could not be used. Continuing on <new>: answer the latest request.]`, without the refused text, so the new model answers the request instead of weighing another model's refusal.

DSH starts a turn only when input arrives, so this message starts the continuation; it also tells the model why its reply is starting over. The model sees nothing else from the plugin. Just like DSH's own retries, the failed attempt stays invisible to the model.

## Constraints

- **Each switch uses up a turn boundary.** The failed turn looks stopped and a fresh turn begins. DSH offers no public way to swap models inside an active step, so this is the closest available method.
- **Goals stop.** If a failure happens during a goal's automatic round, DSH's goal driver notices the stopped turn and turns the goal off; work continues, and you can restart the goal later.
- **Always-mode retries.** With a provider `retryPolicy` of `mode: always`, DSH asks downstream recovery first, so the switch happens on the first failure without retrying the same model. When the chain is exhausted, always mode will keep retrying that last model forever, per configuration.
- **Restarts.** Chain state (which models were tried and which model to return to) lives in memory. If DSH restarts with a fallback active, the session keeps using that fallback model unless you change it.
- **Code that waits for "the turn" a prompt starts.** Such code first runs into the stopped turn. To get the final answer, keep reading past a `turn/end` whose reason is `{ kind: 'aborted', reason: { kind: 'hook', reason: 'dsh-fallback-models: ...' } }`; the continuation arrives in the following turn.
- **Billing.** Each fallback request is billed separately by its provider, and the continuation sends the conversation again.

## Development

```sh
npm ci
npm run check
npm test
```

`test/loop.test.js` runs the plugin inside DSH's real agent loop, session store, LLM service, and `dsh-llm-retry`, with an in-process adapter whose models fail or refuse on request. `test/refusal.test.js` covers refusal detection. `test/client.test.js` pulls in the settings page and the switch banner the way DSH's module loader does and renders them.

## License

[MIT](LICENSE)

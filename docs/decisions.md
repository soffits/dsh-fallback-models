# Decisions

Implementation choices and their reasons. One line each, grouped by system; a newer choice replaces the line it supersedes.

## Notifications

- `notify.to` empty sends to the switching conversation's own place, set sends to that fixed address: one field covers both, and the fixed form keeps working for setups without per-conversation places.
- The place comes from the notify service's `topics()` list (`sessionId` to `threadId`/`chatId`), not a new service method: dsh-telegram-bot already provides it, so no other plugin has to change.
- A subagent's switch goes to its nearest ancestor with a place, so it is seen where the work was asked for; nothing is sent when no session in the chain has one, rather than falling back to some other channel.
- The parent chain follows `parentSession` only on headers with `origin: 'subagent'`, because DSH documents that an ordinary fork may keep its source id there while being its own conversation.
- Parent headers are read from the live agent registry first and from `sessionPersistence.stat` second (header only, no log read), both looked up optionally so the plugin still loads without them.
- The walk stops after 32 links and on a repeated id, so a broken or cyclic lineage cannot hang a notice.

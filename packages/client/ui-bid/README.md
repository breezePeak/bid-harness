# @deepseek-ai/dsh-client-ui-bid

English | [中文](README.zh.md)

Bid Session browser UI. The plugin contributes `BidStagePanel` to the conversation-declared `conversation.input.dock` list and renders only when the Host-resolved Session preset is `bid` and the `bid.runtime` projection is available. The five MVP stages are presentation labels over `projection.runtime`; the client does not fold Bid events, advance stages, derive permissions, or keep a local stage or status.

`projection.allowedActions` controls which upload, retry, and outline-confirmation controls appear, and the Host-projected file limits configure the picker and its rule text. File selection keeps browser `File` objects locally for display and removal only; it never calls `session.prompt()` or reports upload or parsing success. Retry and confirmation callbacks remain unavailable until the Bid Host action API is composed, so admitted controls render disabled rather than bypassing Host admission.

The panel mirrors `projection.composer.enabled` and its stable reason code into `ctx.conversation.blocks` for the same Session. A non-Bid preset or unavailable projection clears the block and hides the panel, preserving the ordinary composer and attachment path for non-Bid Sessions. The shipped `bid` Agent Preset is discovered through the Host roster and displayed as “标书模式”; the preset seat contains no Bid-specific branch or toggle.

## Model Experience

None directly. This package adds no prompt content and sends no ordinary Session prompt; the Host owns every model-visible Bid input and action.

#### KV Cache effect

None. Rendering a projection and selecting local files do not change the model request prefix.

## Known Limitations and Deferred Work

- **Bid action transport is not composed** — retry and outline-confirmation remain disabled, and selected files remain browser-local until the Host upload and action API is available.
- **The panel shows only the five MVP stages** — later Host stages keep the panel visible without introducing a second client stage model.

# Agent Note: Projection-owned Bid Session UI

Status: implemented

English | [中文](2026-08-29-bid-session-ui-shell.zh.md)

## Problem

A Bid Session needs a stage panel, file selection, and user actions in the existing Web conversation. If the browser reconstructs stages or permissions from session events, it becomes a second workflow engine whose state can diverge from Host admission. A separate Bid toggle, attachment pipeline, or chat surface would also split the Session identity and bypass the existing plugin composition.

## Decision

The browser-safe `@deepseek-ai/dsh-bid/control-plane` export owns `BidClientProjection`, `BidClientAction`, and composer capability types without importing workspace parsing code. The Host publishes the whole `bid.runtime` projection through the generic Session projection channel. The Host-resolved Session preset is the Bid identity; projection presence alone does not classify a Session because the registry is process-wide.

`@deepseek-ai/dsh-client-ui-bid` contributes one `BidStagePanel` entry to `conversation.input.dock`. The component requires the resolved `bid` preset, reads `useProjection(BID_RUNTIME_PROJECTION_KEY)`, and renders the current stage and status as a compact DSH composer-dock row. It reuses the shared state indicator and button primitives plus the composer geometry and typography; the ordinary DSH transcript, Todo, and tool renderers remain the execution-progress UI. The panel shows controls only for actions listed by the Host and does not fold events, infer completed stages, derive permissions from runtime status, or apply optimistic stage and status changes.

The panel maps only `projection.composer` into the existing per-session composer block registry. Browser-selected `File` objects and request-pending or error feedback are component-local UI state. File selection never reaches `session.prompt()`; the generated `bid/uploadFiles` Remote is an explicit injected callback, so its absence cannot fall back to ordinary chat admission. Stage, status, allowed actions, and durable failure reasons still come only from the Host projection. The panel does not reproduce the fixed Bid stage sequence because that would present a second task-progress model beside DSH's own execution views.

The shipped `bid` Agent Preset supplies the roster identity and “标书模式” display metadata. `AgentPresetSeat` remains generic and lists the Host roster without a Bid-specific toggle.

## Alternatives considered

**Fold Bid events in the browser.** This duplicates Host workflow policy and lets client versions disagree about current stage and allowed actions.

**Put Bid branches into ConversationRoot, InputBar, or AgentPresetSeat.** Those packages would gain knowledge of an optional domain and every later workflow UI would enlarge the same central branch table.

**Render the full Bid stage sequence as a bespoke progress card.** This duplicates task progress beside the DSH Todo and tool views and makes an optional domain visually diverge from the shared composer stack.

**Reuse ordinary message attachments.** The existing attachment path serializes images into `session.prompt()`; Bid documents are workspace inputs admitted by a separate Host action.

**Keep a client `isBidMode` toggle.** A local toggle can outlive or misidentify the selected Session and cannot prove that the Host composed Bid capabilities.

## Consequences

Non-Bid Sessions render and submit through the existing conversation without a Bid block or attachment change even though the Host registry contains `bid.runtime`. Bid Sessions require both the resolved preset identity and projection, and unavailable Host actions remain disabled rather than simulated. The Bid row stays visually consistent with other composer docks but does not show the complete business sequence at once. File upload uses the generated Host Remote; retry, confirmation, and any later Bid message admission still require dedicated Host actions.

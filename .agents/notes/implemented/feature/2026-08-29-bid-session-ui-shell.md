# Agent Note: Projection-owned Bid Session UI

Status: implemented

English | [中文](2026-08-29-bid-session-ui-shell.zh.md)

## Problem

A Bid Session needs a stage panel, file selection, and user actions in the existing Web conversation. If the browser reconstructs stages or permissions from session events, it becomes a second workflow engine whose state can diverge from Host admission. A separate Bid toggle, attachment pipeline, or chat surface would also split the Session identity and bypass the existing plugin composition.

## Decision

The browser-safe `@deepseek-ai/dsh-bid/control-plane` export owns `BidClientProjection`, `BidClientAction`, and composer capability types without importing workspace parsing code. The Host publishes the whole `bid.runtime` projection through the generic Session projection channel. The Host-resolved Session preset is the Bid identity; projection presence alone does not classify a Session because the registry is process-wide.

`@deepseek-ai/dsh-client-ui-bid` contributes one `BidStagePanel` entry to `conversation.input.dock`. The component requires the resolved `bid` preset, reads `useProjection(BID_RUNTIME_PROJECTION_KEY)`, maps the first five `BidStage` values to localized labels, and shows controls only for actions listed by the Host. It does not fold events, infer completed stages, derive permissions from runtime status, or apply optimistic stage and status changes.

The panel maps only `projection.composer` into the existing per-session composer block registry. Browser-selected `File` objects and request-pending or error feedback are component-local UI state. File selection never reaches `session.prompt()`; Host upload and action calls remain explicit injected callbacks, so their absence cannot fall back to ordinary chat admission.

The shipped `bid` Agent Preset supplies the roster identity and “标书模式” display metadata. `AgentPresetSeat` remains generic and lists the Host roster without a Bid-specific toggle.

## Alternatives considered

**Fold Bid events in the browser.** This duplicates Host workflow policy and lets client versions disagree about current stage and allowed actions.

**Put Bid branches into ConversationRoot, InputBar, or AgentPresetSeat.** Those packages would gain knowledge of an optional domain and every later workflow UI would enlarge the same central branch table.

**Reuse ordinary message attachments.** The existing attachment path serializes images into `session.prompt()`; Bid documents are workspace inputs admitted by a separate Host action.

**Keep a client `isBidMode` toggle.** A local toggle can outlive or misidentify the selected Session and cannot prove that the Host composed Bid capabilities.

## Consequences

Non-Bid Sessions render and submit through the existing conversation without a Bid block or attachment change even though the Host registry contains `bid.runtime`. Bid Sessions require both the resolved preset identity and projection, and unavailable Host actions remain disabled rather than simulated. Final upload, retry, confirmation, and Bid message admission require the Host action API to supply the injected callbacks.

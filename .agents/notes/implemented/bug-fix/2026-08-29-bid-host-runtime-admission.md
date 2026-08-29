# Agent Note: Keep Bid workflow admission on the Host

Status: implemented

English | [中文](2026-08-29-bid-host-runtime-admission.zh.md)

## Problem

The Bid browser projection used two keys, exported Host runtime functions through its browser entry, and advertised message, retry, and confirmation actions without production routes. A Bid session could therefore reach the generic prompt path and append a user message before the Host rejected unsupported workflow input.

## Decision

`@deepseek-ai/dsh-bid/control-plane` exports only browser-safe constants and types, and `bid.runtime` is the sole Bid projection key. The Bid Host plugin registers that projection and rejects generic prompt admission for sessions whose resolved preset is `bid` before `createUserMessage`, follow-up, or steering can run. Until dedicated action routes exist, the projection advertises only file upload and keeps the composer disabled with a canonical reason. The reducer accepts completion only from the current running stage or the waiting outline-confirmation stage and ignores other completion events.

## Alternatives considered

**Keep generic prompt delivery and reject inside the Bid agent.** Rejected because the user message would already be durable and model-visible before the workflow authority evaluated it.

**Advertise actions backed only by local UI callbacks.** Rejected because projection actions describe Host capabilities; presenting an action without a production route creates false authority in the browser.

**Register a second client alias for compatibility.** Rejected because the project has no released compatibility obligation and one key avoids divergent projections.

## Consequences

Bid sessions cannot use the generic composer until a production Bid action route is implemented. Standard sessions retain generic prompt delivery. Browser code no longer imports Node-backed Bid runtime modules, and replay cannot advance from unrelated or out-of-order stage events.

# Agent Note: Keep Bid workflow admission on the Host

Status: implemented

English | [中文](2026-08-29-bid-host-runtime-admission.zh.md)

## Problem

The Bid browser projection used two keys, exported Host runtime functions through its browser entry, and advertised message, retry, and confirmation actions without production routes. A Bid session could therefore reach the generic prompt path and append a user message before the Host rejected unsupported workflow input.

## Decision

`@deepseek-ai/dsh-bid/control-plane` exports only browser-safe constants and types, and `bid.runtime` is the sole Bid projection key. The Bid Host plugin registers that projection with its configured file limits and rejects generic prompt admission for sessions whose resolved preset is `bid` before `createUserMessage`, follow-up, or steering can run. ApiProxy dispatches prompt admission from the root Context so sibling Host composition plugins participate in the same Host-wide decision. The projection advertises only actions with Host routes: file upload is available while `file_intake` is pending or failed, and the composer remains disabled with a canonical reason. The reducer accepts stage completion only from the current running stage; outline confirmation enters that state only after a required confirmation receives `confirmed: true`. Projection state version 3 includes the durable failure reason and invalidates cache entries derived under the earlier transition rules.

## Alternatives considered

**Keep generic prompt delivery and reject inside the Bid agent.** Rejected because the user message would already be durable and model-visible before the workflow authority evaluated it.

**Advertise actions backed only by local UI callbacks.** Rejected because projection actions describe Host capabilities; presenting an action without a production route creates false authority in the browser.

**Register a second client alias for compatibility.** Rejected because the project has no released compatibility obligation and one key avoids divergent projections.

## Consequences

Bid sessions cannot use the generic composer. They upload intake files through the dedicated Bid Remote, while Standard sessions retain generic prompt delivery. Browser code does not import Node-backed Bid runtime modules, and replay cannot advance from unrelated or out-of-order stage events.

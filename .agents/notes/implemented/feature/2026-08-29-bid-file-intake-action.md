# Agent Note: Dedicated Bid file-intake action

Status: implemented

English | [中文](2026-08-29-bid-file-intake-action.zh.md)

## Problem

The Bid panel could select files, but S1 had no production route from browser bytes to the Session workspace. Sending those bytes through `session.prompt()` would make a generic chat message the workflow authority, while advancing the stage in the browser would create state that could not be recovered from the Session log.

## Decision

The Bid package exposes browser-safe upload request and result types and generates one Typert Remote, `bid/uploadFiles`. The Host resolves the live Session, requires its resolved preset to be `bid`, takes the workspace root only from `Session.header.cwd`, applies Host-configured file limits, and serializes intake with a per-Session lock. The MVP request carries one complete batch as canonical base64 JSON.

After all bytes pass admission, the Host starts the current program-owned `file_intake` stage and delegates persistence, extraction, and chunking to `BidWorkspace.import()`. The file-intake validator reads the current `manifest.json`, matches each record from that exact batch, and checks the original file, parsed document, required extraction sidecars, chunk index, and every indexed chunk. The orchestrator records completion or failure, the Session projection derives client state, and terminal events are flushed before the Remote returns. Success stops at `tender_analysis/pending`; a failed intake retains its durable records and accepts a new upload attempt.

The browser keeps only selection and request feedback locally. It calls the generated Remote after an explicit upload click and never derives workflow completion or falls back to `session.prompt()`.

## Alternatives considered

**Reuse ordinary message attachments.** Rejected because that path is owned by generic prompt admission and does not provide the Bid stage event sequence.

**Add a second upload server outside the existing Remote assembly.** Rejected because Typert already supplies Session resolution, result framing, and the browser API contribution.

**Advance `file_intake` in the browser.** Rejected because reload and concurrent clients must recover the same state from Host-owned events.

## Consequences

S1 has one Host-owned intake path with stable business errors and deterministic replay. The JSON/base64 MVP buffers the encoded batch within configured limits. Tender Analysis and all later business execution remain unimplemented.

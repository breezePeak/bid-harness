# Agent Note: Confirmed-outline chapter writing

Status: implemented

## Problem

The confirmed technical-bid outline needed a bounded writing stage that could produce every independently writable section without turning the control plane into one stage per chapter or sending the entire bid context to one model request.

## Decision

`chapter_writing` derives a deterministic parent/order worklist from `outline/confirmed-outline.json` and runs the existing live DSH Agent sequentially once per writable section. Each task carries a compact project context, its own Blueprint, related Requirement, Scoring, Compliance, and S3 Evidence records. The Agent writes one Markdown body and a metadata sidecar; the Executor alone writes `chapters/manifest.json`.

The S6 Validator ties the manifest to the confirmed-outline hash, requires one non-empty non-linked body per writable section, checks section mappings and must-answer metadata, and validates every recorded local Evidence chunk and line range. Retrying S6 removes the prior `chapters/` tree before regeneration. Chapter-level web research remains unavailable; the task may use the existing local `grep` then `read` loop for a focused evidence gap.

## Alternatives considered

**One whole-book Agent request.** It would accumulate unrelated context and leave partial coverage and per-chapter recovery unverifiable.

**A control-plane stage for each chapter.** It would multiply a fixed business workflow into document-size-dependent state.

**A new model client or chapter workflow runtime.** The existing Agent, tool restriction, session, and orchestrator mechanisms already own the required execution path.

## Consequences

S6 advances to `book_review/pending` only after the complete manifest validates. Metadata is an execution record rather than technical-bid prose, and later review and DOCX stages can map each confirmed section to exactly one Markdown file. Sequential execution favors reproducible workspace writes and failure diagnosis over throughput.

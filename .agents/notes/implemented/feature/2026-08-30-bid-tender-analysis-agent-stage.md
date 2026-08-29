# Agent Note: Bid tender analysis through the live Agent

Status: implemented

English | [中文](2026-08-30-bid-tender-analysis-agent-stage.zh.md)

## Problem

Bid file intake produced a durable corpus, but Tender Analysis had no production execution path. Advancing the stage from a browser or a second ad hoc model client would bypass the Session Agent, while accepting model-produced JSON without checking its citations would let later stages rely on unsupported tender facts.

## Decision

The Bid Host starts exactly one automatic stage after successful file intake. For `tender_analysis`, it resolves the live Session Agent, waits for existing work to quiesce, removes the four stage-owned output files, restricts the turn to `grep`, `read`, and `write`, injects a dynamic follow-up, and waits for the Agent to become idle again. The assignment names the Session workspace, the four strict JSON schemas, the tender-only authority rule, and the required stopping point. Preset prose remains stable; Session paths and current stage data stay in the dynamic assignment.

The Agent writes `analysis/project.json`, `analysis/requirements.json`, `analysis/scoring.json`, and `analysis/compliance.json`. Every extracted fact cites a manifest file identifier, an indexed chunk path, and an inclusive line range. `project.json` also declares the complete set of successfully parsed tender files that the analysis covered.

The Validator, not Agent idleness, decides completion. It rejects a missing or extra Artifact, invalid JSON or schema fields, duplicate item identifiers, incomplete tender coverage, references to non-tender or failed files, unknown chunk paths, linked paths, and line ranges outside the cited chunk. Only validated output records `bid.stage.completed`; failure records `bid.stage.failed`. The Host then stops at `evidence_mapping/pending` and does not start S3.

## Alternatives considered

**Treat `whenIdle()` as stage completion.** Rejected because an idle Agent can still have omitted, malformed, or unsupported output.

**Add a Bid-specific search tool.** Rejected because the existing filesystem `grep`, `read`, and `write` tools already expose the corpus while keeping the normal Agent loop and tool logging intact.

**Run all remaining automatic stages after upload.** Rejected because S3 and later stages do not yet have production executors and validators; the Host bridge therefore advances one automatic stage per explicit call.

**Keep previous S2 output on retry.** Rejected because a partial retry could otherwise pass validation using stale files from an earlier attempt.

## Consequences

S2 now uses the same Agent loop, tool registry, Session log, and workspace as ordinary Harness work, while deterministic validation retains authority over workflow state. The validator performs additional filesystem reads after the Agent turn, and each retry intentionally replaces all four S2 Artifacts. S3 remains unavailable.

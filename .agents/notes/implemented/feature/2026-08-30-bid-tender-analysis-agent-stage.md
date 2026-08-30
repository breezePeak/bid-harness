# Agent Note: Bid tender analysis through the live Agent

Status: implemented

English | [中文](2026-08-30-bid-tender-analysis-agent-stage.zh.md)

## Problem

Bid file intake produced a durable corpus, but Tender Analysis had no production execution path. Advancing the stage from a browser or a second ad hoc model client would bypass the Session Agent, while accepting model-produced JSON without checking its citations would let later stages rely on unsupported tender facts.

## Decision

After successful file intake and on every `agent/session-start`, the Bid Host calls the same `BidOrchestrator.drive()` operation. The loop derives the current stage from the Session log, follows its `StagePolicy`, and executes it only when the production Executor reports `canExecute(stage)`. That Executor supports only `tender_analysis`, so the current implementation stops at `evidence_mapping/pending` without recording an S3 start.

For `tender_analysis`, the Host resolves the live Session Agent, waits for existing work to quiesce, removes the four stage-owned output files, restricts the turn to `grep`, `read`, and `write`, injects a dynamic follow-up, and waits for the Agent to become idle again. The assignment names the Session workspace, the four strict JSON schemas, the tender-only authority rule, and the required stopping point. Preset prose remains stable; Session paths and current stage data stay in the dynamic assignment.

The Agent writes `analysis/project.json`, `analysis/requirements.json`, `analysis/scoring.json`, and `analysis/compliance.json`. Every extracted fact cites a manifest file identifier, an indexed chunk path, and an inclusive line range. `project.json` also declares the complete set of successfully parsed tender files that the analysis covered.

The Validator, not Agent idleness, decides completion. It rejects a missing or extra Artifact, invalid JSON or schema fields, duplicate item identifiers, incomplete tender coverage, references to non-tender or failed files, unknown chunk paths, linked paths, and line ranges outside the cited chunk. Only validated output records `bid.stage.completed`; failure records `bid.stage.failed`. The Host then stops at `evidence_mapping/pending` and does not start S3.

## Alternatives considered

**Treat `whenIdle()` as stage completion.** Rejected because an idle Agent can still have omitted, malformed, or unsupported output.

**Add a Bid-specific search tool.** Rejected because the existing filesystem `grep`, `read`, and `write` tools already expose the corpus while keeping the normal Agent loop and tool logging intact.

**Dispatch stages by name at each Host entry.** Rejected because upload and Session recovery would each need another branch whenever an Executor is added. `StagePolicy`, `canExecute()`, and the log-derived runtime state already provide the complete continuation decision.

**Keep previous S2 output on retry.** Rejected because a partial retry could otherwise pass validation using stale files from an earlier attempt.

## Consequences

S2 uses the same Agent loop, tool registry, Session log, and workspace as ordinary Harness work, while deterministic validation retains authority over workflow state. Upload and Session recovery share one stage-independent continuation path; adding S3 requires its Executor and Validator plus `canExecute('evidence_mapping')`, without another Host stage branch. The validator performs additional filesystem reads after the Agent turn, and each retry intentionally replaces all four S2 Artifacts. S3 remains unavailable.

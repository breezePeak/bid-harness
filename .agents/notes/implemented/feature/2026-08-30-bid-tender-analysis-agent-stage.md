# Agent Note: Bid tender analysis through the live Agent

Status: implemented

English | [中文](2026-08-30-bid-tender-analysis-agent-stage.zh.md)

## Problem

Bid file intake produced a durable corpus, but Tender Analysis had no production execution path. Advancing the stage from a browser or a second ad hoc model client would bypass the Session Agent, while accepting model-produced JSON without checking its citations would let later stages rely on unsupported tender facts.

## Decision

After successful file intake and on every `agent/session-start`, the Bid Host calls the same `BidOrchestrator.drive()` operation. The loop derives the current stage from the Session log, follows its `StagePolicy`, and executes it only when the production Executor reports `canExecute(stage)`. The `tender_analysis` policy requires user confirmation after automatic validation, so a valid draft records `bid.user_confirmation.required` and remains `tender_analysis/waiting_user` without completing S2 or starting S3.

For `tender_analysis`, the Host resolves the live Session Agent, waits for existing work to quiesce, removes the four stage-owned output files, restricts the turn to `grep`, `read`, and `write`, injects a dynamic follow-up, and waits for the Agent to become idle again. The assignment names the Session workspace, the four strict JSON schemas, the tender-only authority rule, and the required stopping point. Preset prose remains stable; Session paths and current stage data stay in the dynamic assignment.

The Agent writes `analysis/project.json`, `analysis/requirements.json`, `analysis/scoring.json`, and `analysis/compliance.json`. Project analysis includes background, objectives, implementation constraints, and project-specific technical priorities. Scoring contains only technical items, and every item carries non-empty `response_points` that translate its criterion into technical-bid coverage. Every extracted fact cites a manifest file identifier, an indexed chunk path, and an inclusive line range.

The Validator, not Agent idleness, decides whether the draft may reach confirmation. The Host exposes only Project and Scoring through the confirmation Remote, accepts controlled edits to analysis conclusions, and preserves ids, tender text, scores, citations, and file coverage. It atomically replaces the canonical Project and Scoring paths, revalidates the complete S2 artifact set, and records user confirmation plus completion only on success. Invalid user input returns issues while the stage remains waiting.

## Alternatives considered

**Treat `whenIdle()` as stage completion.** Rejected because an idle Agent can still have omitted, malformed, or unsupported output.

**Add a Bid-specific search tool.** Rejected because the existing filesystem `grep`, `read`, and `write` tools already expose the corpus while keeping the normal Agent loop and tool logging intact.

**Dispatch stages by name at each Host entry.** Rejected because upload and Session recovery would each need another branch whenever an Executor is added. `StagePolicy`, `canExecute()`, and the log-derived runtime state already provide the complete continuation decision.

**Keep previous S2 output on retry.** Rejected because a partial retry could otherwise pass validation using stale files from an earlier attempt.

**Let the browser upload replacement JSON.** Rejected because it would allow source text, scores, citations, and file coverage to be forged outside Host validation.

## Consequences

S2 uses the same Agent loop, tool registry, Session log, and workspace as ordinary Harness work, while deterministic validation and explicit user confirmation retain authority over workflow state. User edits replace the existing canonical artifact paths rather than creating parallel final files. The browser holds an unsubmitted draft and can retry invalid edits; S3 cannot execute until the confirmed artifacts pass validation.

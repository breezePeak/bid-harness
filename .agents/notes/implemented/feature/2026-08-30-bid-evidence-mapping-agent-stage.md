# Agent Note: Bid technical material mapping through the live Agent

Status: implemented

English | [中文](2026-08-30-bid-evidence-mapping-agent-stage.zh.md)

## Problem

Tender Analysis identifies requirements and scoring criteria, but later technical proposal writing needs local technical material and explicit gaps rather than an unsupported assumption that a matching file exists.

## Decision

The existing Bid Host continuation registers `evidence_mapping` beside Tender Analysis. Its Executor waits for the live Session Agent, removes the previous `analysis/evidence-map.json`, limits the turn to `grep`, `read`, and `write`, and injects only the current Session paths and S3 assignment. The Agent reads the manifest and S2 Artifacts, chooses search terms, reads each candidate chunk after grep, and writes the evidence map.

The Artifact contains one mapping for every S2 Requirement and Scoring item. Each local material cites a manifest file, indexed chunk, inclusive range, summary, and one writing use: `reuse` for reusable logic, `adapt` for project-specific rewriting, `reference` for technical guidance, or `background` for project understanding. Empty material sets are valid when `missing_topics` identifies the needed technical content.

The Validator owns S3 completion. It validates the Artifact schema, exact S2 identifier coverage, manifest file and parse status, chunk ownership, linked paths, and cited lines. The Host records stage completion only after this validation and continues to `outline_generation/pending`. Retrying any failed automatic non-user stage uses the existing generic retry operation. Web research is not implemented because S3 has no existing stable web Tool registration to reuse.

## Alternatives considered

**Treat grep hits as materials.** Rejected because only reading the candidate chunk can establish context and a safe writing use.

**Create a second retrieval or model runtime.** Rejected because the Session Agent and filesystem tools already provide the required logged execution path.

**Require a material for every mapping.** Rejected because identifying missing technical content is a necessary S3 result.

## Consequences

S3 extends the existing control plane without a stage-specific browser flow or state machine. The Validator adds local filesystem reads after the Agent turn, and retries replace stale S3 output. Public standards and other external research remain a later capability.

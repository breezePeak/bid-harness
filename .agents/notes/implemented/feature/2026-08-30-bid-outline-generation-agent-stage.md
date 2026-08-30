# Agent Note: Bid technical-writing blueprint through the live Agent

Status: implemented

English | [中文](2026-08-30-bid-outline-generation-agent-stage.zh.md)

## Problem

Tender requirements, scoring, compliance, and mapped local material do not by themselves tell a later chapter writer what focused technical sections to produce.

## Decision

The Bid Host registers `outline_generation` as the next automatic Agent stage. The Agent reads the existing S2 Artifacts and S3 evidence map, writes only `outline/outline.json`, and is restricted to `read` and `write`. It does not search the corpus again, use Web Search, or write proposal prose.

The strict Artifact is a flat parent tree. Every section has a stable id, parent_id, sibling order, level, concise purpose, writing status, mappings, and writing guidance. Structural nodes have children; writable nodes have concrete `must_answer` entries. Requirements, scoring, and compliance remain complete references, while S3 material remains authoritative and contributes only short writing notes.

The Validator checks tree structure, reference existence and coverage, internal duplicate references, and writable coverage for mandatory requirements and priority scoring. Success advances through the existing control plane to `outline_confirmation/waiting_user`.

## Alternatives considered

**Use a nested outline document.** Rejected because parent_id and sibling order keep later editing, traversal, and numbering independent of stored numbers.

**Copy S3 material into every section.** Rejected because duplicate evidence references drift from the evidence map.

**Generate one heading per scoring item.** Rejected because coarse criteria do not provide enough chapter-writing guidance.

## Consequences

S4 adds one Agent turn and validation pass before human confirmation. Semantic quality remains prompt- and fixture-tested; the Validator intentionally limits itself to mechanical integrity and coverage.

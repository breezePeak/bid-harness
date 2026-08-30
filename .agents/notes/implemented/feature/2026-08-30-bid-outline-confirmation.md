# Agent Note: Bid outline confirmation artifacts

Status: implemented

English | [中文](2026-08-30-bid-outline-confirmation.zh.md)

## Problem

S4 produces an agent draft, while later writing needs a durable user-approved directory that preserves the draft and validates the user's changes.

## Decision

S5 reads `outline/outline.json` only in `outline_confirmation/waiting_user`, applies runtime-validated Host-owned edit operations, and writes `outline/confirmed-outline.json` plus `outline/confirmation.json`. Both draft and confirmed outlines use the same strict schema. The confirmation record contains the confirmed decision and SHA-256 values for both artifacts.

The Host retains control of section identifiers and mapped Requirement, Scoring, and Compliance IDs. It reuses S4 tree and coverage checks before writing either S5 artifact. The completion validator rereads both S5 artifacts, the S4 draft, and S2 analysis artifacts through workspace-safe regular-file reads, checks their schemas, tree, coverage, artifact set, and both hashes, then authorizes an event that records both S5 artifacts. Invalid user changes return actionable issues and leave the stage waiting for another edit; retry returns a failed S5 user stage to waiting. A successful confirmation advances the projection to `chapter_writing/pending`.

## Alternatives considered

**Record only a boolean confirmation.** Rejected because user edits would not become a durable input for later stages.

**Overwrite the S4 draft.** Rejected because it removes the distinction between the agent output and the user-approved version.

**Validate directory changes in the browser.** Rejected because coverage and graph invariants require the authoritative analysis artifacts and must survive reloads.

## Consequences

S6 can consume one formal technical-bid outline without treating the S4 draft as final. The Host accepts only the defined editing operation set, normalizes sibling order after moves, and recomputes moved subtree levels. The browser retains structured user-edit issues for display and offers basic section add, delete, ordering, and outdent actions.

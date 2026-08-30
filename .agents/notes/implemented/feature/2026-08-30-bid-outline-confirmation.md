# Agent Note: Bid outline confirmation artifacts

Status: implemented

English | [中文](2026-08-30-bid-outline-confirmation.zh.md)

## Problem

S4 produces an agent draft, while later writing needs a durable user-approved directory that preserves the draft and validates the user's changes.

## Decision

S5 reads `outline/outline.json` only in `outline_confirmation/waiting_user`, applies Host-owned edit operations, and writes `outline/confirmed-outline.json` plus `outline/confirmation.json`. Both draft and confirmed outlines use the same strict schema. The confirmation record contains the confirmed decision and SHA-256 values for both artifacts.

The Host retains control of section identifiers and mapped Requirement, Scoring, and Compliance IDs. It reuses S4 tree and coverage checks before writing either S5 artifact. Invalid user changes return actionable issues and leave the stage waiting for another edit. A successful confirmation records the normal user-confirmation and stage-completion events, so the existing projection advances to `chapter_writing/pending`.

## Alternatives considered

**Record only a boolean confirmation.** Rejected because user edits would not become a durable input for later stages.

**Overwrite the S4 draft.** Rejected because it removes the distinction between the agent output and the user-approved version.

**Validate directory changes in the browser.** Rejected because coverage and graph invariants require the authoritative analysis artifacts and must survive reloads.

## Consequences

S6 can consume one formal technical-bid outline without treating the S4 draft as final. The Host accepts only the defined editing operation set; richer browser editing remains a client concern.

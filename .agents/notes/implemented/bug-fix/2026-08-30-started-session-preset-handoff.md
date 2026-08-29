# Agent Note: Started Session Preset Handoff

Status: implemented

English | [中文](2026-08-30-started-session-preset-handoff.zh.md)

## Problem

A preset pick on a started Session could remain only in the preset chip while the Session continued to run its original composition. This made the chip claim that a Bid Session existed when the Session summary still named `standard`, so the Bid panel correctly remained absent.

## Decision

`AgentPresetSeatController` treats the current Session summary as the display authority. A staged preset is visible only while no Session is current. For a blank current Session, the controller selects the preset on that Session and records the Host-confirmed value in the session list.

For a started current Session, the controller calls `IWorkspaces.startFreshSession()`. `WorkspaceRuntime` creates a new Session directly in the current Session's Workspace rather than reusing a blank Session, opens it, and the controller applies the staged preset to that new blank Session. Creation or preset-selection failures clear the stage and restore the committed preset of the Session that remains current.

## Alternatives considered

**Show the staged preset until the Host rejects it.** The UI would still claim a composition the Session does not run.

**Change the started Session in place.** The Host intentionally preserves a started Session's composition and history.

**Add a Bid-only client mode.** A local mode cannot establish which preset the Host composed for a Session.

## Consequences

Choosing `bid` from a blank `standard` Session changes that Session to `bid`. Choosing it from a started `standard` Session keeps the original Session on `standard` and opens a new blank `bid` Session in the same Workspace. The assembled browser checks cover both paths and the Bid panel's existing Session-preset condition.

# Agent Note: Started Session Preset Handoff

Status: implemented

[English](2026-08-30-started-session-preset-handoff.md) | 中文

## Problem

已开始 Session 中的 preset 选择可能只停留在 preset chip，而 Session 仍运行原来的组装。于是 chip 宣称已经存在 Bid Session，但 Session 摘要仍为 `standard`，Bid 面板按既有条件正确地不显示。

## Decision

`AgentPresetSeatController` 将当前 Session 摘要作为显示权威。只有没有当前 Session 时才显示暂存 preset。当前 Session 为空白时，控制器在该 Session 上选择 preset，并把 Host 确认的值写回 Session List。

当前 Session 已开始时，控制器调用 `IWorkspaces.startFreshSession()`。`WorkspaceRuntime` 直接在当前 Session 的 Workspace 中创建新 Session，不复用空白 Session，打开它后由控制器将暂存 preset 应用到新的空白 Session。创建或 preset 选择失败时，控制器清除暂存值，并恢复仍为当前 Session 的已提交 preset。

## Alternatives considered

**在 Host 拒绝前显示暂存 preset。** UI 仍会宣称 Session 未运行的组装。

**直接修改已开始的 Session。** Host 有意保留已开始 Session 的组装与历史。

**增加 Bid 专用客户端模式。** 本地模式无法证明 Host 为 Session 组装了哪个 preset。

## Consequences

空白 `standard` Session 选择 `bid` 后，该 Session 变为 `bid`。已开始的 `standard` Session 选择 `bid` 后，原 Session 保持 `standard`，同一 Workspace 中会打开新的空白 `bid` Session。组装浏览器检查覆盖两个路径以及 Bid 面板既有的 Session-preset 条件。

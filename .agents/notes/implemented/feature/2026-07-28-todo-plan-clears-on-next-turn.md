# Agent Note: 下一轮次开始时清空 todo 计划条

Status: implemented

## Problem

`todo_write` 在会话日志中保存完整列表快照，Web 从 `todos` 投影读取最近一次清单。若投影把上一轮清单带入下一轮，模型尚未更新的旧计划会被误认为当前任务。投影需要准确界定清单所属轮次；计划条是否显示则由[临时执行计划](../simplification/2026-09-26-transient-conversation-plans.md)按 Agent 运行状态决定。[Web Todo 展示](2026-07-23-web-todo-display.md)与 [`todo_write` 工具](2026-06-29-todo-write-tool.md)仍拥有事件来源和展示入口。

## Decision

当前轮次清单是其后没有更晚 `turn/start` 的最近一次 `todo/write`。`turn/end` 不改变投影中的列表，保留模型刚写入的事实；下一次 `turn/start` 清空投影，直到模型再次写入。Web 计划条另外遵守运行态、条目数和未完成项的展示条件，不因投影仍有旧值就在空闲状态显示。

### Host 投影

`dsh-tool-todo` 的 `todos` 投影单元从每个 `todo/write` 取完整列表，在每个 `turn/start` 返回 `null`（`stateVersion` 2）。`dsh-host-apiproxy` 在历史尾页的 `projections` 块提供该值，并以 `session/projection` 帧推送；Web dock 经 `useProjection('todos')` 读取。无密钥 fixture 采用相同折叠规则供快照回放。

### 已移除的 TUI

TUI 原有的实时分支与冷恢复路径曾执行相同的轮次折叠；该包已[移除](../simplification/2026-08-04-remove-tui-package.md)，当前规则由 Host 投影拥有。

## Alternatives considered

**在 `turn/end` 清空投影。** 投影会丢掉本轮模型最后写出的清单事实，不能再由会话尾页重建；计划条的短暂展示由 UI 负责。

**仅在全部项为 `completed` 时清空。** 放弃或部分完成的清单仍会进入下一轮，不能按轮次区分当前计划。

**在轮次开始时追加空的 `todo/write`。** 为展示生命周期改写日志，并捏造模型从未写出的写入。

## Consequences

重新打开会话仅在没有更晚 `turn/start` 时从 Host 恢复该清单；Web 再根据当前运行状态决定是否显示。此记录拥有投影的轮次边界，[临时执行计划](../simplification/2026-09-26-transient-conversation-plans.md)拥有计划条展示周期。tool-todo 投影测试固定 `turn/start` 清空与 `turn/end` 保留，Web 无密钥 fixture 固定推送帧的同一折叠。

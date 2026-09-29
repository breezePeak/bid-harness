# Agent Note: 投标阶段面板精简重复运行文字

Status: implemented

## Problem

投标阶段面板在计划之外显示章节任务折叠摘要、运行范围与步骤详情、导出消息及进度同步失败提示。这些文字占用聊天区域，并与计划、正式任务或导出结果重复。

## Decision

运行中的阶段只显示现有阶段、能力和导出计划，不附加章节任务摘要和独立状态段落。主 Agent 的具体说明保存在[实际能力步骤](../feature/2026-09-24-bid-capability-plan-and-export.md)中。S4 进度读取继续轮询并保留同一工作已读到的统计，面板不另行显示 S4 统计同步失败文案。任务状态及错误仍由正式计划、阶段状态和结果呈现。

## Alternatives considered

将这些文字折叠或移动到其他位置仍会保留重复入口；直接移除不改变 Host 状态或轮询。

## Consequences

聊天区域减少重复信息；运行中的进度读取失败不再有独立文字提示。保留[能力计划与独立导出展示](../feature/2026-09-24-bid-capability-plan-and-export.md)的真实计划读取和[进度投影一致性](../bug-fix/2026-09-15-s4-progress-projection-sync.md)的缓存、重试机制。

## Verification

`bid-stage-panel.client.spec.tsx` 覆盖章节摘要、运行提示和同步失败文案的缺席，并验证进度读取继续轮询。

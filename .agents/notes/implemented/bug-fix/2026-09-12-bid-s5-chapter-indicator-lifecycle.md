# Agent Note: S5 章节状态灯生命周期投影

Status: implemented

## Problem

S5 工作台把正文存在和审核结论拼接为章节状态，无法区分排队、编写、修复和实际审核中的章节，也会把没有审核报告的正文误报为“正在审核”。可选状态字段和客户端回退推导使同一章节在 Host 与浏览器中出现不同状态。

## Decision

`execution-log.json` schema v4 为每个章节持久化 `phase` 与 `failure_phase`。排队、Writer 初稿、Writer 修复和 Reviewer 运行前分别记录 `queued`、`writing`、`repairing` 和 `reviewing`；完成清空 phase，失败将最后 phase 转入 `failure_phase`，依赖失败记录 `blocked`。Host 在读取边界将 schema v3 确定性迁移为 v4：已完成章节保持完成，待执行和中断运行章节排队，失败章节按最后未接受尝试恢复可确认的 Writer 或 Reviewer 失败角色；无法判断时保留通用执行失败。

工作台 schema v5 的 `chapter_indicator` 为必填字段。Host 以失败、活动 phase、已保存审核报告、正文存在和未开始的顺序生成状态与 tooltip；活动 `queued` 优先于旧正文和审核报告，`repairing` 与 `needs_input` 保留为独立结构化状态；不可写目录项生成概述文字状态。浏览器只映射该字段。具体字段归属由[章节状态指标投影](../feature/2026-09-12-bid-chapter-indicator-contract.md)约束。

## Alternatives considered

**从正文存在推断“正在审核”。** 不采用；正文已写入不代表 Reviewer 已启动，状态必须由实际执行日志表示。

**保留可选指标并由浏览器回退推导。** 不采用；浏览器没有执行 phase 和失败角色，无法生成与 Host 一致的状态或 tooltip。

**为每种状态新增独立事件。** 不采用；执行日志已经是章节检查点，增加事件不能补充其恢复与失败归属。

## Consequences

S5 重试通过 Host 读取边界兼容 schema v3，并将迁移后的日志写回 v4；不需要因为状态灯改造整体重跑 S5。状态灯不会改变 Writer、Reviewer 或修复的调度和验收行为，只记录既有生命周期并投影给工作台。Host 和客户端测试覆盖状态字段必填、各状态视觉映射、正文等待审核、旧正文或审核结果不覆盖排队以及 Reviewer 失败原因。

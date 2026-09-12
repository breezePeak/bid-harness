# Agent Note: Bid 章节状态指标投影

Status: implemented

## Problem

审核工作台需要把排队、编写、审核、资料缺口、正文问题和完成状态区分为稳定的目录指示器，但 Writer 和 Reviewer 的两个内部状态字段不足以表达这些状态。

## Decision

工作台 schema v4 将 `chapter_indicator` 设为必填。Host 根据执行日志、正文和审核报告生成状态及 tooltip；浏览器只映射该字段，不从 `writing_status` 或 `review_status` 推导状态。`needs_input` 映射为 `needs_attention` 并保留“缺少项目资料，正文无需重写”的 tooltip，正文需要修复使用橙色状态，执行失败使用红色状态；章节概述继续使用文字指标而不是叶节状态点。执行日志的 phase 与失败记录由[章节状态灯生命周期投影](../bug-fix/2026-09-12-bid-s5-chapter-indicator-lifecycle.md)约束。

## Alternatives considered

**保留可选字段和客户端兼容推导。** 不采用；当前没有外部消费者，旧响应无法表示 Host 已知的排队、修复和失败阶段，兼容分支会让目录与权威投影分叉。

**只在客户端从旧字段推导状态。** 不采用；排队状态和更具体的 tooltip 只有 Host 能从执行日志与审核产物可靠判断，重复推导会使目录与权威投影逐渐分叉。

**让目录状态直接阻断审核或导出。** 不采用；指标只表达当前产物状态，审核风险是否阻断阶段仍由既有 S5 验收契约决定。

## Consequences

工作台只接受当前 schema，新增状态必须同时更新控制面 schema、Host 投影和客户端分支；状态 tooltip 属于响应契约，不能由客户端根据不完整的内部字段臆造内容。

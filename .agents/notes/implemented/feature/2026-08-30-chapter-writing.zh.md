# Agent Note: Confirmed-outline chapter writing

Status: implemented

## Problem

已确认的技术标目录需要一个受限的写作阶段，逐个生成全部可写章节，同时不能为每章增加控制面阶段，也不能把全书上下文塞进一次模型请求。

## Decision

`chapter_writing` 从 `outline/confirmed-outline.json` 按父节点和顺序确定工作清单，并对每个 `writable` 章节顺序调用现有 live DSH Agent。任务只携带紧凑项目上下文、当前 Blueprint、关联 Requirement、Scoring、Compliance 和 S3 Evidence。Agent 写入一个 Markdown 正文和一个元数据 sidecar；仅 Executor 写入 `chapters/manifest.json`。

S6 Validator 将 manifest 绑定到 confirmed-outline 哈希，要求每个可写章节恰有一个非空且非链接的正文，检查章节映射、must-answer 元数据以及记录的本地 Evidence chunk 和行范围。重试 S6 时先删除旧 `chapters/` 树。章节级 Web Research 未实现；仅允许用既有本地 `grep` 后 `read` 流程补充当前章节资料缺口。

## Alternatives considered

**一次请求生成整本标书。** 这会累积无关上下文，且无法校验覆盖和单章恢复。

**每章一个控制面 Stage。** 这会把固定业务流程膨胀为随文档大小变化的状态集合。

**新增模型客户端或章节工作流运行时。** 现有 Agent、工具限制、Session 和 Orchestrator 已经拥有所需执行路径。

## Consequences

只有完整 manifest 通过校验后，S6 才进入 `book_review/pending`。元数据作为执行记录，不进入技术标正文；后续审核和 DOCX 阶段可将每个已确认章节映射到唯一 Markdown 文件。顺序执行优先保证工作区写入和失败定位可复现，而非追求吞吐量。

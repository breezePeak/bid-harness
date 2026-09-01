# Agent Note: Bid 目录确认产物

Status: implemented

English | [English](2026-08-30-bid-outline-confirmation.md)

## Problem

S4 产出 Agent 草稿，而后续写作需要保留草稿并验证用户修改后的持久化正式目录。

## Decision

S5 只在 `outline_confirmation/waiting_user` 读取 `outline/outline.json`，由 Host 对运行时校验过的编辑操作进行应用，并写入 `outline/confirmed-outline.json` 与 `outline/confirmation.json`。草稿和正式目录复用同一严格 Schema。确认记录保存确认决定及两份产物的 SHA-256。

Host 控制章节 ID 以及 Requirement、Scoring、Compliance 映射 ID。写入 S5 产物前校验目录树和覆盖率。完成校验器通过工作区安全的普通文件读取重新读取两份 S5 产物、S4 草稿和 S2 分析产物，校验 Schema、目录树、覆盖率、产物集合和两份哈希，随后才授权记录两份 S5 产物的完成事件。无效用户修改返回可展示问题并保持等待编辑；失败的 S5 用户阶段重试后恢复为等待编辑；成功确认使 Projection 推进到 `chapter_writing/pending`。

## Alternatives considered

**只记录布尔确认。** 不采用，因为用户修改无法成为后续阶段的持久化输入。

**覆盖 S4 草稿。** 不采用，因为会丢失 Agent 输出与用户确认版本的区分。

**在浏览器校验目录修改。** 不采用，因为覆盖率和图结构不变量依赖权威分析产物，并且必须可在重载后恢复。

## Consequences

S6 可消费唯一的正式技术标目录，而不会把 S4 草稿作为最终版本。Host 只接受已定义编辑操作，移动后重排同级顺序并重算整棵移动子树的层级。浏览器保留并展示结构化修改问题，并提供基础新增、删除、排序和取消缩进操作。

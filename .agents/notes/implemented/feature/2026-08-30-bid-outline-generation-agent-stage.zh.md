# Agent Note: Bid 通过实时 Agent 生成技术标写作蓝图

Status: implemented

[English](2026-08-30-bid-outline-generation-agent-stage.md) | 中文

## Problem

招标要求、评分项、合规规则和已映射的本地资料本身不能告诉后续章节写作 Agent 应该如何组织可独立编写的技术主题。

## Decision

Bid Host 将 `outline_generation` 注册为下一个自动 Agent 阶段。Agent 读取现有 S2 Artifact 和 S3 evidence map，先写入 `outline/outline.json`，再在同一工具限制内收到强制 Blueprint Quality Review follow-up；复核修正目录后写入内部 `outline/quality-report.json`。它不再搜索资料库、不使用 Web Search，也不写技术正文。

严格 Artifact 使用扁平父子树。每个 Section 具有稳定 id、parent_id、同级 order、level、简洁 purpose、是否写作、映射和写作指引。结构节点必须有子节点；可写节点必须有具体 `must_answer`。Requirement、Scoring 和 Compliance 保持完整引用；S3 material 仍是权威来源，只转化为简短 writing_notes。

Validator 校验树结构、引用存在性和覆盖率、数组内部重复，以及强制 Requirement 和重点 Scoring 是否落到可写节点。可写章节必须是叶子，同级标题不得重复，`must_answer` 不得重复或机械复述标题。质量报告必须覆盖全部当前 Requirement、Scoring 和最终 section ID，且没有未解决问题。成功后通过现有控制面进入 `outline_confirmation/waiting_user`。

## Alternatives considered

**使用嵌套目录文档。** 不采用，因为 parent_id 和同级 order 让后续编辑、遍历和编号不依赖保存的章节号。

**把 S3 material 复制到每个 Section。** 不采用，因为重复的 Evidence 引用会与 evidence map 漂移。

**每个评分项只生成一个标题。** 不采用，因为粗粒度评分项不足以指导章节写作。

## Consequences

S4 在用户确认前增加初稿和强制复核两次 Agent 回合。质量报告是 S4 内部产物，不进入 Stage Artifact 或 S5/S6 输入；S5 继续对用户编辑后的目录使用同一组树结构规则。

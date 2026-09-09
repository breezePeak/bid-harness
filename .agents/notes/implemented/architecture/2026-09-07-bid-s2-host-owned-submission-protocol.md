# Agent Note: S2 由 Host 接管确定性提交协议

Status: implemented

## Problem

S2 Main Agent 直接写四个完整 JSON 时同时承担招标语义判断、正式 ID、文件身份、chunk 归属、行号、文件覆盖和 Schema 组装。后六项都能由 Host 确定，却会因模型抄写错误消耗整文件修复回合；Agent 空闲也不能证明其确实提交了完整结果。

## Decision

`tender_analysis` 继续由同一 live Agent 在当前 Session 和 Workspace 中执行，并保持 tender-only 技术标边界、`grep → read` 检索、评分区域连续读取、最终 Validator 与用户确认。普通工具只开放 `grep` 和 `read`；阶段执行器动态注册 `submit_project_fact`、`submit_requirement`、`submit_scoring_item`、`submit_compliance_item` 和 `finish_tender_analysis`，模型不能调用 `write` 生成正式 Artifact。

Host 按 manifest 顺序把每个 `role=tender && parseStatus=success` 文件映射为 `T1`、`T2` 等执行期引用。提交工具只接受 `file_ref`、chunk index 中的 `chunk_*` ID 和真实 quote；Host 验证文件与 chunk 归属，在排除 HTML comment 元数据但保留字符位置的正文中要求 quote 唯一，并按原始 chunk 中换行符计算一基、闭区间 `line_start` 和 `line_end`。不存在或多次出现的 quote 以参数错误拒绝，跨 chunk 原文保留为多个正式 `TenderSourceRef`。

Requirement、Scoring 和 Compliance 以 `R*`、`S*`、`C*` 运行时引用保存在 Map 中。首次接受时分别锁定三位补零的 `REQ-*`、`SC-*`、`COM-*` 正式 ID；`replace_ref` 只覆盖该记录内容，不改变 ID。Scoring 只把招标评分体系中作为独立评审对象，并具有独立名称及总分、权重或区块边界的评分大项写入正式 Artifact，同时保留大项的完整评分规则；`parent_ref` 仅作为误拆细则的兼容标记，finish 丢弃这些记录。重复提交的评分大项按除来源和 ID 外的完整结构化内容归并，保留首次正式 ID 并合并来源，不能只凭名称合并。

`finish_tender_analysis` 从 staged Map 组装四个现有 Schema：Host 提供 schema version、未知项目单值 `null`、未知数组 `[]`、manifest 中全部成功 tender 的 `analyzed_tender_files`、正式 ID 和 source refs。持久化前复用 Validator 的语料完整性与技术评分分类检查；可修正缺项返回 `completed=false` 与 issues，同一 staged state 继续接受补充或覆盖。首次通过确定性检查的 finish 只返回 `review_required` 和当前 revision，不写正式文件；执行器在原 Agent 初始轮次结束后注入完整 staged snapshot，强制其重新读取每条来源并复核所有记录。复核中每次接受的提交都递增 revision，最终 finish 必须携带当前 `review_revision` 才会原子写入四个路径并立即通过 `validateTenderAnalysis()`。强制复核不消耗缺项续修预算；Agent 只回复文字、重复初次 finish 或提交旧 revision 都不能推进 S2。该边界的缺陷修复与 S3 对称协议见[模型与 Host 复核直连边界](../bug-fix/2026-09-09-bid-model-host-review-boundaries.md)。

用户确认仍只编辑规范化结论并保留 ID、原文、引用和文件覆盖。S3 继续读取相同路径、扁平数组和 Artifact Schema，并独立负责评分细则的响应点拆解。

## Alternatives considered

**继续让模型写完整 JSON，再按 Validator issue 定向修文件。** 不采用；它缩小了修复范围，却仍把稳定 ID、引用行号、文件覆盖与 Schema 组装交给模型。该方案记录于[S2 定向修复决策](../simplification/2026-09-02-bid-s2-targeted-analysis-repair.md)。

**只加强 Prompt。** 不采用；Prompt 不能使文件身份、唯一 quote、chunk 归属或正式 ID 成为确定性结果。

**让 Host 按关键词生成 Requirement、Scoring 或 Compliance。** 不采用；技术与商务边界、原子化、分类、强制性和规范化表达仍需要招标语义判断。

**把评分响应点一并放入 S2。** 不采用；S3 拥有评分响应点的语义拆解和稳定 `RP-*` 身份。

## Consequences

模型不再维护四个 JSON 文件、真实文件 ID、引用路径与行号、正式记录 ID、schema version 或 tender 覆盖，确定性错误在单次工具调用或 Host 组装时被消除。评分项边界仍由模型依据原文层级和语义判断，Host 只删除显式 `parent_ref` 细则并合并结构完全相同的重复大项，不使用名称、分值或样本位置猜测层级。每项提交增加一次工具调用，长招标文件的调用数随语义记录数量增长；换来的结果是局部错误只需覆盖一个 runtime ref，最终 Validator 保持为 Host 与持久化回归的独立防线。

Keyless 源码 Loader 回放由固定模型依次提交 staged 记录、结束初始轮次、在独立复核轮次提交当前 revision，并检查 Host 生成的四个正式 Artifact、稳定 ID、引用行号和最终 Validator 结果。

本记录更新[初始 S2 live-Agent 执行决策](../feature/2026-08-30-bid-tender-analysis-agent-stage.md)和整文件 Repair 的实现机制；引用只证明来源可追溯的语义规则仍由[招标分析引用记录](../bug-fix/2026-09-01-tender-analysis-traceable-source-references.md)约束。

# Agent Note: Bid 模型阶段的 Validator 导向修复

Status: implemented

## Problem

Bid 模型阶段可能在回复中声称工作完成，但正式 Artifact 仍使用过期版本、错误字段名、无效 JSON、遗漏 ID 或不一致引用。Orchestrator 的最终 Validator 会正确拒绝这些产物并锁定通用输入；如果 Executor 不先提供可操作的校验问题，一次可修复的格式偏差会变成用户必须手工重跑的阶段失败。

## Decision

`modelStageRepairAttempts` 为所有模型生成阶段配置每次执行内的修复轮数，默认为 3，允许 1–20。每轮把最新的浏览器安全 `StageValidationIssue` 交给同一 live Agent，等待 idle 后重新检查正式路径；修复只能覆盖当前阶段原文件，不能创建 `final`、`fixed`、`new` 或版本后缀副本。

S2 在 Coverage Audit 后运行完整 `validateTenderAnalysis()`。S3 在 Host 写入当前尝试的 Web 来源账本与快照后运行 `validateEvidenceMapping()`，因此 schema、ID 覆盖、本地引用和外部 URL 绑定都能参与修复；任务和 Repair 明确区分 `requirement_id`、`scoring_id`，并拒绝通用 `id` 字段。S4 在强制 Blueprint Quality Review 后运行 `validateOutlineGeneration()`，同时修复目录与质量报告。

S6 逐章检查正文和严格 Metadata，覆盖 `section_id`、完整 `covered_must_answer`、S3 Evidence 子集和当前章节 Web 来源；通过后才由 Host 生成 Manifest。程序生成的文件接入、书审和 DOCX 导出不接受模型定义的 JSON，因此不进入该修复机制。

Executor 预校验只提供修复反馈。Orchestrator 仍调用正式 Validator 决定阶段是否完成、等待确认或记录 `bid.stage.failed`；修复回复本身不能推进阶段。预算用尽后，失败事件保留最新问题，用户仍可通过 `bid/retryStage` 完整重跑当前自动阶段。

## Alternatives considered

**只加强 Prompt。** 明确字段名能降低出错率，但模型仍可能输出旧版本、截断 JSON 或违反跨文件关系，不能替代确定性检查。

**放宽严格 Schema 或兼容旧字段。** 接受 `id`、旧版本或缺失字段会把歧义数据推进下游，并使后续阶段无法区分 Requirement 与 Scoring 映射。

**只在 Orchestrator 最终校验后修复。** 最终失败已经写入持久状态并停止驱动；把修复放在各 Executor 的提交前阶段，可以保留现有状态机和最终 Validator 的唯一完成权限。

**无上限修复。** 模型、工具、语料或引用缺失时无法保证收敛，无上限循环会持续占用 Session 和模型请求。部署配置提供有界预算，失败状态保留完整重试入口。

## Consequences

可定位的格式、覆盖和引用问题会在同一次阶段执行中自动收敛，所有模型生成阶段共享同一预算和问题格式。每个失败产物最多增加配置数量的模型回合；达到预算仍不合法的 Artifact 不会推进。测试固定 S3 旧 schema、S4 无效复核产物和 S6 错误 Metadata 的修复路径，S2 继续固定多轮修复与详细字段问题。

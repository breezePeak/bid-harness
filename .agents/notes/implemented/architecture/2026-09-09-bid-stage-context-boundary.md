# Agent Note: Bid Main Agent 统一阶段上下文边界

Status: implemented

## Problem

Bid Session 的追加式事件日志同时被用于审计、回放和模型消息投影。正式跨阶段后继续投影旧阶段对话，会让已否决候选、失败修复意见或被正式 Artifact 覆盖的结论成为下一阶段的隐含输入；只在 S2 硬编码评分交接又无法保护 S1→S2、S3→S4 和 S4→S5。

## Decision

`BidOrchestrator` 拥有正式阶段完成与下一阶段执行之间的切换时机。最终 Artifact 校验成功后，Host 先准备一个不改变 Session 的阶段上下文提交；用户确认事件和阶段完成事件写入后立即提交模型可见替换，再由 `driveLoop()` 允许下一阶段执行。自动完成的 S1 使用同一路径。校验或准备失败不提交边界，也不启动下一阶段。

Host 根据 `getBidStagePolicy(nextStage).requiredInputs` 读取权威 Artifact，并为每个文件计算 SHA-256。交接消息只包含来源阶段、目标阶段、相对路径和摘要，不重复 Artifact 内容，也不采用上一阶段的模型总结。Session durable events 保持追加式；surface replacement 只改变 `deriveMessages()` 的当前投影，并记录被替换的事件序号。

S1→S2、S2→S3、S3→S4 和 S4→S5 均使用该边界。同阶段 Validator repair、普通模型失败重试、审核修改、局部重生成及阶段内部子流程不调用边界。S5 最近一次失败任务明确记录 `CONTEXT_WINDOW_EXCEEDED` 时，重试通过同一 surface replacement 原语从当前 Artifact 检查点恢复，移除旧私有任务轮次并以新 Message ID 原样重放模型表层中的用户消息；原始事件继续保留。阶段 Reset 也复用该原语，但从目标阶段开始使其后续上下文失效并显示重置说明。

评分事实与人工选择仍由[评分选择边界](../feature/2026-09-09-bid-scoring-selection-boundary.md)拥有；阶段 Reset 的清理范围和重启语义仍由[重置上下文记录](../bug-fix/2026-09-03-bid-stage-reset-model-context.md)拥有。

## Alternatives considered

**在每个确认 RPC 中分别清理上下文。** 不采用，因为各入口容易出现清理早于最终校验或晚于下一阶段首次模型调用，且新增阶段需要复制时序逻辑。

**只增强下一阶段 Prompt。** 不采用，因为旧对话仍在模型输入中，提示不能消除相互矛盾的语义来源。

**删除 Session 事件或创建新 Main Agent Session。** 不采用，因为前者破坏审计与回放，后者割裂现有 Workspace、UI 和项目恢复关系。

**把完整正式 Artifact 写入交接消息。** 不采用，因为阶段执行已按 Policy 读取文件，重复内容增加 token，并制造文件与消息两份事实表示。

## Consequences

跨阶段模型输入以 Stage Policy 的正式文件为唯一交接清单，旧模型结论仍可审计但不可见。边界准备增加一次对下一阶段全部 required inputs 的读取和 SHA-256 计算；缺失、链接或不可读输入会在阶段完成前阻止推进。S5 上下文超限恢复不调用模型摘要，因而不会把已经超限的历史再次发送给压缩模型；恢复后的私有协议从磁盘读取当前计划、章节检查点和审核产物。Session 与 Artifact Schema 均不改变，普通同阶段重试和现有 fresh-context Subagent 行为保持不变。

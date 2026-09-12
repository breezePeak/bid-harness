# Agent Note: S5 审查风险不阻断与外部资料缺口

Status: implemented

## Problem

Chapter Reviewer 把缺少企业资质、证书、业绩证明或人员证件与正文可修复问题放在同一个 `repair` 结论中。调度器因此反复要求 Writer 改写无法从正文生成的资料，修订轮次还被拼进 Reviewer 子任务名称；章节或整书条件在修订预算耗尽后继续阻止 S5 完成，使已经生成的正文和真实审核风险无法作为完整标书交付。

## Decision

Chapter Reviewer 把问题分为正文可修复问题和外部资料缺口。只有 Writer 能通过修改当前正文解决的问题进入 `blocking_issues` 并产生 `repair`；缺少项目方才能提供的资质、证书、业绩或人员材料时，对应 R 保持 `missing`，并通过 `external_input_gaps` 记录所需材料和原因。单独存在外部资料缺口或任务分配冲突时，报告结论为 `attention`，调度器保存报告但不再调用 Writer。

Reviewer 子任务名称只使用确认目录的真实章节号和固定后缀，例如 `3.1 - 审查`。正文修订轮次、Reviewer 重试次数和内部章节流水号只保留在执行日志字段中，不进入名称。

`repair` 仍使用既有有界预算让原 Writer 定向修订；预算耗尽后保存最近一次合法正文及其 Reviewer 报告。整书验收只能为 document 条件选择 Reviewer 已判定为 `pass` 的章节；`repair` 和 `attention` 是已经结算的章节风险，不再触发 Writer。外部资料缺口、无进展或整书修订轮次耗尽都写入 `chapters/completion-review.json` 并完成 S5。Validator 校验结论身份、完整性及 Host 确定性事实一致性，但不要求 `required` 结论为 met。审核结论不再成为阶段完成或 Word 导出的门禁；Writer、Reviewer、持久化或协议执行失败仍按运行故障处理。

章节报告 schema v7 增加 `external_input_gaps`，并将 verdict 收敛为 `pass | repair | attention`。审核工作台 schema v3 增加 `needs_input`：外部资料缺口显示黄色章节状态灯和“待补项目资料”，其他未通过项继续显示为需关注；问题严重程度使用高、中、低风险，不使用“阻断”作为审核问题等级。

本记录调整[私有语义提交协议](../architecture/2026-09-07-s5-private-submission-protocols.md)、[全局合规审核](2026-09-09-bid-s5-global-compliance-review.md)、[通用任务契约与动态验收](../architecture/2026-09-10-s5-generic-task-contract-acceptance.md)及[正文页数结果校验](2026-09-10-bid-s5-live-chat-page-result-validation.md)中由审核结论门禁阶段完成的部分。上述记录仍分别拥有私有工具隔离、全局约束归属、通用任务契约、实时对话和确定性测量的独立理由，因此保持 active。

## Alternatives considered

**保留 `repair`，在提示词中要求 Writer 不要虚构资料。** 不采用；调度器仍会把同一候选送回 Writer，既浪费修订预算，也不能给客户端稳定区分“正文待修”和“项目资料待补”。

**缺少资质时直接把章节视为 pass。** 不采用；这会隐藏真实投标风险。`attention` 保存未覆盖项和所需资料，同时明确该问题不属于正文改写职责。

**任何 Reviewer 未通过都立即停止 S5。** 不采用；审核是风险发现机制，有限自动修订不能保证消除外部资料缺口或所有内容风险。停止阶段会把已完成正文与风险记录一起卡在不可交付状态。

**取消自动修订，只展示所有问题。** 不采用；明确且局部的正文问题仍适合由原 Writer 在有限轮次内修正。新的边界只排除无法通过正文解决的事项，并在耗尽预算后收敛。

## Consequences

用户可以在 S5 完成后导出带有未解决审核风险的标书，工作台负责明确展示风险等级和待补资料；阶段完成不再等同于所有审核项通过。外部资料缺口的正确分类依赖 Reviewer 语义判断，协议校验只能保证它引用已标为 missing 的 canonical R，不能证明模型没有把正文可修复问题误分类。

无密钥协议与章节执行测试固定 `external_input_gaps` 的引用约束、黄色投影、一次 Writer/Reviewer 执行、真实章节号名称，以及 `repair` 和整书修订预算耗尽后的完成语义。模型可见提示由 headless S5 回放固定；真实模型对资质与正文问题的分类质量仍由真实 API 覆盖观察。

# Agent Note: S4 映射子 Agent 的结构化提交

Status: implemented

## Problem

S4 Child 以普通回复输出 JSON 时，枚举、字段名、Task 身份或文件短引用错误只能在模型回合结束后由 Host 发现。这类参数错误与章节覆盖、资料证明等语义问题共用一次 Host 修复机会，导致本可在当前回合纠正的错误触发第二轮。累计检索错误还会复制到后续 attempt，执行日志无法区分拒绝原因与不阻塞接收的告警。

## Decision

Evidence Mapping Executor 为每个 Mapping Task 预留 Child Session ID，并通过 continuable setup 在该 Child 作用域注册 S4 私有 `submit_evidence_mapping` 工具。动态 JSON Schema 限定当前 task_id、现有及本任务预留 section_id、可见 file_ref、文件角色允许的 usage、完整字段集合和 Final Check 分支摘要；工具随后复用现有文件引用解析、Zod Schema 与领域校验，不建立第二套 Artifact 数据模型。

初始任务使用现有 `outlineEditOperationSchema` 提交分支内增量目录操作，而不返回完整目录子树。Host 在工具执行时拒绝跨分支引用，在语义校验时应用操作、校验目录覆盖并为新增节点分配稳定 ID。合并后的目录候选由 Main Agent 只读复核，Main Agent 只能写质量报告。Final Check 只提交变化章节和 `unchanged_section_ids`，Host 从已接受映射恢复完整结果。

无效参数抛出 ToolArgsError，由模型在当前回合重新调用。一次提交只有在成功的权威 `tools/result` 事件后才生效，成功后结束当前回合并阻止更多工具调用。一次 S4 操作持有提交代次和已接收结果，使同一 Session 冷恢复出的新 Agent Activation 能继续提交；每个 Activation 只持有自己的待提交执行记录和 disposer。未产生成功提交时，Host 记录 `EVIDENCE_MAPPING_SUBAGENT_STRUCTURED_MISSING`。

Host 只为章节覆盖、目录操作、分块归属、网页正文快照、Writing Brief 和 Final Check 汇总等语义问题在同一 Child 增加至多一个修复回合。修复耗尽的初始任务不能降级为空映射；阶段失败并保留已接受任务的私有 checkpoint，重试只调度未完成任务。checkpoint 与执行日志共用串行写入队列，completed 状态只在对应 checkpoint 写入后发布。执行日志 schema v3 的 `issues` 只保存导致当次提交被拒绝的问题，`warnings` 只保存当次新增且不阻塞接收的检索错误；`accepted: true` 要求 `issues` 为空。旧 v2 日志不兼容，重新执行 S4 生成新日志。正式 Evidence Map 保持 v10，S5 的输入路径、解析和章节上下文选择不变。

## Alternatives considered

**把 `reference_bid` usage 自动改成 `adapt`。** 不采用，因为文件角色不能替模型决定材料是复用、改写还是仅作参考，静默转换会隐藏错误选择。

**扩展通用 continuable subagent 的 structured output 协议。** 不采用，因为动态文件短引用和角色权限是 S4 私有规则，当前没有第二个跨轮消费者需要承担通用协议与生命周期扩展。

**语义修复时启动新的 Child。** 不采用，因为新 Session 会丢失首次检索上下文、网页来源证明和已收到的具体校验问题。

**保留普通回复 JSON并强化 Prompt。** 不采用，因为 Prompt 不能在当前模型回合强制枚举、额外字段和文件引用约束，Host 仍需在回合结束后拒绝。

## Consequences

参数错误不产生 Host attempt；语义失败保留一次同会话修复。小型目录操作、逐任务 checkpoint 和 Final Check 差量提交限制模型上下文与重复工作；结构失败不再伪装成完成。S4 增加 Child 作用域工具及私有执行状态，不改变通用 subagent 接口、Evidence Map v10 或 S5。聚焦执行器测试覆盖动态 Schema、分支操作范围、断点续跑、缺失提交、语义修复、告警归属、日志版本和 S4→S5 读取；真实 Agent Loop 与 keyless 快照固定同回合工具纠错及后续语义修复。

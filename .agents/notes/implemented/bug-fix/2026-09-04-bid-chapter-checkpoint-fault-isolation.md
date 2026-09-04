# Agent Note: Bid 章节写作检查点与故障隔离

Status: implemented

## Problem

S5 把 Writer 或 Reviewer 的非正常结束与内容校验失败共用同一修订计数。一次模型流断开会消耗章节唯一的内容修订机会；该章随后失败时，调度器立即取消所有正在运行的无关章节。`retryStage` 再次进入执行器后还会删除整个 `chapters/` 目录，使已经完成并审查的章节全部重写。实际故障的影响因此从一个 Child 的传输连接扩大到整本标书，执行日志也只保留 `stopReason=error`，无法直接区分服务错误类别。

## Decision

Writer 和 Reviewer 的 `stopReason=error` 使用独立运行重试计数，重新建立 one-shot Child 并复用同一语义任务，不增加内容修订序号。进程内 Subagent Driver 从 Child 的持久化 `turn/end` 提取安全的 LLM 失败代码写入 `SubagentResult.diagnostic`，不复制 Provider 消息或载荷。内容 Schema、Host 校验或有效 Reviewer 的修订结论继续使用原有内容修订计数。

Host 以 `chapters/execution-log.json` 维护每章的 pending、running、completed 和 failed 状态。一个章节最终失败只记录该章，不取消无关运行；调度器继续完成所有依赖已满足的章节，依赖失败章节的节点明确标记 failed。已有有效 Reviewer 报告的候选在后续修订遭遇重复运行错误时作为 `needs_attention` 结果提交，保留其具体内容问题，不把传输错误升级为缺失章节。

阶段重试先校验确认目录哈希、关系计划、执行日志顺序与依赖、正文、Metadata、Reviewer 报告、内容哈希、最终 Writer/Reviewer Child 身份和已接受尝试。全部一致的 completed 章节恢复到内存调度状态；failed、running 和 pending 章节重置为 pending 并保留历史尝试。普通重试不删除章节文件，也不重新运行关系规划。检查点不完整时重新规划和执行，但仍不删除现有章节文件；只有用户显式执行阶段重置时才按重置命令清理。

缺少真实数量、人员、设备或记录值时，Writer 只保留正式字段、填写规则和控制要求，不添加示例数据行。Reviewer 不得要求虚构值或示例记录，并把带“示例、待补、XXX、最终填写”等内容的已填行判定为占位，避免两轮审查采用相反标准。

## Alternatives considered

**把运行错误继续计入内容修订。** 该方案实现简单，但连接断开与正文质量没有因果关系，会随机耗尽语义预算。

**任一章节失败后重跑整个 S5。** 全量重跑会丢弃已经审查的稳定成果，增加成本和再次遇到瞬时故障的概率，也使执行日志不能作为断点状态。

**遇到失败后无限重试当前 Child。** 无界重试会隐藏持续性配置或服务故障。独立运行重试仍受 Host 配置的修订次数约束，耗尽后保留可用候选或记录章节失败。

**不校验直接复用磁盘章节。** 目录、计划或 Reviewer 身份变化后直接复用会把旧结果混入新标书。恢复必须由 Host 对全套身份和哈希做确定性校验。

## Consequences

瞬时模型流错误不再消耗内容修订机会，执行日志会保留安全错误类别。单章失败不会取消无关章节，S5 重试只运行未完成章节，已完成正文、Metadata 和 Reviewer 报告保持不变。只有所有可写章节都有 Host 接受的候选与 Reviewer 报告时才生成完整 manifest；没有可用候选的真实失败仍会使阶段失败，但已完成检查点可供下一次重试继续。

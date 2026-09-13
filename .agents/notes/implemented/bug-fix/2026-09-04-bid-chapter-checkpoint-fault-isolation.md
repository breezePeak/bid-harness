# Agent Note: Bid 章节写作检查点与故障隔离

Status: implemented

## Problem

S5 把 Writer 或 Reviewer 的非正常结束与内容校验失败共用同一修订计数。一次模型流断开会消耗章节唯一的内容修订机会；该章随后失败时，调度器立即取消所有正在运行的无关章节。`retryStage` 再次进入执行器后还会删除整个 `chapters/` 目录，使已经完成并审查的章节全部重写。实际故障的影响因此从一个 Child 的传输连接扩大到整本标书，执行日志也只保留 `stopReason=error`，无法直接区分服务错误类别。

## Decision

Writer 和 Reviewer 的 `stopReason=error` 使用独立运行重试计数，Writer 在同一可续写会话重试，无法继续时才重建；Reviewer 重新建立独立 Child，均复用同一语义任务，不增加内容修订序号。进程内 Subagent Driver 从 Child 的持久化 `turn/end` 提取安全的 LLM 失败代码写入 `SubagentResult.diagnostic`，不复制 Provider 消息或载荷。内容 Schema、Host 校验或有效 Reviewer 的修订结论继续使用原有内容修订计数。

Host 以 `chapters/execution-log.json` 维护每章的 pending、running、completed 和 failed 状态。一个章节最终失败只记录该章，不取消无关运行；调度器继续完成所有依赖已满足的章节，依赖失败章节的节点明确标记 failed。已有有效 Reviewer 报告的候选在后续修订遭遇重复运行错误时作为 `needs_attention` 结果提交，保留其具体内容问题，不把传输错误升级为缺失章节。

Run 恢复先校验确认目录哈希、关系计划、执行日志顺序与依赖、正文、Metadata、Reviewer 报告、资料完整性、内容哈希、最终 Writer/Reviewer Child 身份和已接受尝试。正文与 Metadata 合法但 Reviewer 报告缺失或协议过期时保留正文并只重新审核；Host 从正文或身份无法恢复的章节出发，沿合法计划的反向 depends_on 遍历直接与间接下游，这个闭包内的章节才重置为 pending，清空最终 Writer/Reviewer 身份并保留历史 attempts 和文件。失效集合不依赖目录显示顺序，也不沿 related_sections 传播。首个 Writer 启动前写入一致的日志，依赖章节只能接收本轮前置章节的新 handoff；集合之外的合法 completed、repair 与 blocked 均复用。合法 plan 独立复用，不依赖 execution-log 已经创建；非法或目录 Hash 不匹配时重新规划。恢复不删除章节文件；只有用户显式阶段重置才清理。文档级报告按已检查章节 Hash 和证据复用，具体责任见[全局合规审核](2026-09-09-bid-s5-global-compliance-review.md)，提交协议见 [S5 私有提交协议](../architecture/2026-09-07-s5-private-submission-protocols.md)。

Web 候选池与实际证据分别验证。调度前的读取位置预检和每章 W 引用分配均隔离单来源的缺失、正文 Hash 错误与不安全路径，向 Writer 保留已映射要求和明确不可用原因，允许按原规则替代或局部补搜。已发 W 不删除或复用，当前不可用来源不出现在可用表中。实际 `submit_chapter` 仍验证当前账本身份、路径和正文 Hash；不能靠删除非法引用接纳提交。整体账本解析失败、取消与 Host 写盘失败保持失败，不归类为普通坏来源。

最终正文、metadata 和 review 每次异步写入返回后都检查取消。完成日志任务实际取得串行队列时再次检查；随后一次原子 execution-log 替换构成最小完成提交，开始后允许收敛，写入成功才更新共享 completed 和最终 Child 身份。其他日志任务不能提前观察到待提交完成状态。提交前取消保留候选文件但不发布本轮全书 manifest；提交成功后发生的取消不回滚章节，重试以磁盘完成日志恢复。

缺少真实数量、人员、设备或记录值时，Writer 只保留正式字段、填写规则和控制要求，不添加示例数据行。Reviewer 不得要求虚构值或示例记录，并把带“示例、待补、XXX、最终填写”等内容的已填行判定为占位，避免两轮审查采用相反标准。

## Alternatives considered

**把运行错误继续计入内容修订。** 该方案实现简单，但连接断开与正文质量没有因果关系，会随机耗尽语义预算。

**任一章节失败后重跑整个 S5。** 全量重跑会丢弃已经审查的稳定成果，增加成本和再次遇到瞬时故障的概率，也使执行日志不能作为断点状态。

**遇到失败后无限重试当前 Child。** 无界重试会隐藏持续性配置或服务故障。独立运行重试仍受 Host 配置的修订次数约束，耗尽后保留可用候选或记录章节失败。

**不校验直接复用磁盘章节。** 目录、计划或 Reviewer 身份变化后直接复用会把旧结果混入新标书。恢复必须由 Host 对全套身份和哈希做确定性校验。

**为依赖增加版本账本或为章节文件引入通用事务。** 合法 DAG 已能确定重跑影响集合，现有 execution-log 已能作为完成依据；额外格式增加持久化状态与恢复分支，不能替代提交时机的正确实现。

**要求所有候选 Web 来源可读。** 未使用的坏资料与本章完成无因果关系。候选池提示不可用、实际提交严格拒绝，既保留故障隔离，也不放宽证据校验。

## Consequences

瞬时模型流错误不消耗内容修订机会，执行日志保留安全错误类别。单章失败不会取消无关章节；S5 重试运行失效闭包，闭包之外的正文、Metadata、Reviewer 报告及尝试记录保持不变。最小提交开始后的取消可能留下一个已完成章节；全书 manifest 开始写入前再次检查取消。只有所有可写章节都有 Host 接受的候选与 Reviewer 报告时才生成完整 manifest，合法 repair 不阻止完成或导出；没有可用候选的真实失败仍会使阶段失败，但已完成检查点可供下一次重试继续。

# Agent Note: Bid S5 章节与全局合规审核分层

Status: implemented

## Problem

S2 的全局 Compliance 被复制进每章的 canonical Checklist 和 manifest，Reviewer 因本章无法独立证明整书一致性而产生重复误报。章节审核也无法区分正文缺陷与目录职责冲突；签署、盖章和交付格式等执行责任在 S5 尚无执行证据，却可能被正文 Reviewer 当作已满足或遗漏。完成所有章节后没有一次基于整本文档的权威复核，Host 和客户端只能把不同责任范围的问题混入章节状态。

## Decision

S5 将局部 Compliance 和全局 Compliance 分开。局部项继续进入章节 canonical Checklist、章节覆盖报告和 manifest；全局项只作为 Reviewer 的独立核验集合，用于发现当前正文中可直接确认的违反或不适用情形，不计入章节覆盖索引。Reviewer 把目录或章节职责分配错误记录为 `assignment_conflicts`，Host 将 verdict 设为 `blocked`，不触发 Writer 重写；当前正文违反全局约束时仍为可修订的 `repair`。

全部章节提交后，现有 Main Agent 通过独立私有协议对完整章节集合执行一次文档级审核，Host 写入 `chapters/global-compliance-review.json`。每个全局项明确分类为跨章节约束、文档内容要求或交付要求，并归属于 chapter、document 或 delivery；跨章节和文档结论必须引用当前章节原文或已登记材料，交付要求没有真实执行证据时只能为 `pending`。报告记录确认目录 Hash、逐项检查的章节正文 Hash、受影响章节和证据引用，最终 Validator 重新校验这些关系。没有全局项时 Host 直接生成空报告。

恢复时，正文和 metadata 合法但章节报告缺失或协议过期的章节先只重新审核，不重新运行 Writer，也不使强依赖下游失效；Reviewer 明确要求修订时才回到 Writer。文档级报告按每项引用的章节 Hash 和材料证据复用未变化结果，其余项目重新审核。章节 manifest 只保存局部 Compliance，文档级报告作为 S5 第四项必需产物，并与 manifest 一同纳入修订备份和运行时投影。

Host 将章节问题、文档级问题和交付待办投影为三种独立表面。章节问题保留章节红点和现有详情；document 项进入独立文档问题列表；delivery 的 pending 项进入交付待办。文档级和交付项不增加章节问题计数。

这项决定补充 [S5 私有语义提交](../architecture/2026-09-07-s5-private-submission-protocols.md)、[章节写作检查点](2026-09-04-bid-chapter-checkpoint-fault-isolation.md)、[审核结果投影](2026-09-09-bid-s5-review-result-projection.md)和[S5 常驻审核](../feature/2026-09-04-bid-s5-persistent-review-export.md)。

## Alternatives considered

**把所有全局项继续分摊到每章。** 不采用；单章不能证明跨章节一致性，重复检查会产生相互矛盾的结论，并把文档和交付责任错误归给 Writer。

**只在每章 Reviewer 增加全局字段，不做整书审核。** 不采用；章节 Reviewer 可发现当前正文的直接违反，却看不到其他章节形成的完整关系，不能形成一次权威文档结论。

**为文档审核启动新的 Child 或新增调度服务。** 不采用；S5 Main Agent 已拥有完整阶段上下文和私有工具安装机制，复用它即可维持一次审核和确定性 Host 组装。

**全局报告变化时重写全部章节。** 不采用；报告协议或证据变化不等于正文失效。先保留正文并重新审核，只有真实 repair 结论才需要 Writer。

**把交付要求标记为通过或失败。** 不采用；S5 没有签署、盖章或最终交付动作的执行证据，`pending` 保留真实责任边界并让客户端显示可执行待办。

## Consequences

章节 Checklist、manifest 和问题计数只表达章节自身责任；全局文档结论可追溯到当前正文和资料，交付责任不会伪装成正文质量。职责冲突需要上游目录或分工修正，现有阶段仍可完成、查看并导出已审结果。持久化格式新增文档级报告，章节报告与 manifest 版本同步提升；旧章节报告会触发只审核恢复，旧 manifest 和缺失的文档级报告按首次发布前策略拒绝并重建。模型语义判断仍由无密钥回放验证协议接入，不能替代真实模型的质量评估。

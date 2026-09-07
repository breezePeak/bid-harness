# Agent Note: S6 章节写作由 Host 调度独立 Subagent

Status: implemented

## Problem

S6 原有执行器把章节任务逐个注入同一个 Bid Agent，并以整 Agent 的 idle 状态近似每章完成。该做法让规划对话直接生成正文，无法形成独立 Child Session，也无法证明无依赖章节真实并发或强依赖章节按前置结果解锁。主 Agent、章节生成、文件写入和 Web Evidence 观察共享同一生命周期，任何失败都可能把后续章节建立在污染的会话状态上。

## Decision

`chapter_writing` 保持一个控制面 Stage，但内部明确分成两个所有者。主 Agent 只判断带原因的强依赖、弱关联和全局一致性要求；Host 按确认目录组装并持久化完整计划。计划必须恰好覆盖全部 writable section，并通过 Host 的 Hash、引用与无环校验。私有工具及提交协议见 [S5 私有语义提交](../architecture/2026-09-07-s5-private-submission-protocols.md)。

Host 根据有效计划维护 pending、ready、running 和 completed 状态，按确认目录顺序选择 ready section，并以 `chapterWritingMaxConcurrency` 限制同时运行的任务。每个章节通过 `ctx.subagents.start('spawn', request)` 建立无父会话历史的 Writer Child Session；Bid Host 的 session-start 驱动忽略 `origin === 'subagent'` 的会话，防止章节 Child 启动第二套阶段流程。强依赖章节只接收已完成前置章节的有界结构化 handoff 和计划原因。每个候选随后由独立 Reviewer Child 审查；正文语义修复创建新的 one-shot Writer，工具参数错误和 Reviewer 补项在当前 Child 纠正，不把任务交还主 Agent。

`chapter_writing` Stage Policy 声明 `grep`、`read`、`web_search` 和 `web_fetch` 普通能力，私有工具按当前 Agent 单独注册。规划不保留文件工具，Writer 只能使用上述普通能力与结构化提交，Reviewer 不开放工作区或网络工具。Writer 的绝对深度上限为 1；资料 Guard 允许 reference/reference_bid Chunk/index、框架写作输入和已登记 Web Snapshot，拒绝 tender。Host 先持久化通过基础校验的正文及 metadata，再启动 Reviewer。当前 Writer 的成功 fetch 经章节身份隔离并串行写入 Web 账本；已经合法持久化且向 Child 暴露的 Snapshot 可复用，不要求再次 fetch。`chapters/execution-log.json` 记录 Writer、Reviewer、时间、停止原因、校验问题和最终接受者，与计划、报告和 manifest 一起构成章节 Artifact。

## Alternatives considered

**让主 Agent 自行调用 Subagent 工具。** 该方案把依赖图、并发上限、失败处理和 Artifact 提交交给模型决定，无法保证每个 writable section 都有 Child Session，也无法稳定证明并发和清理，因此不采用。

**使用 fork 继承主会话。** fork 会把规划阶段和既有会话历史带入章节上下文，增加无关信息和跨章节污染；spawn 由 Host 显式注入最小上下文，更符合每章独立写作的所有权要求。

**Child 直接写章节文件。** 该方案需要向 Child 暴露 write 权限，并在候选校验前发布部分 Artifact。结构化返回让 Host 成为唯一提交者，失败候选不会生成正式正文。

**Subagent 不可用时顺序回退主 Agent。** 回退会重新引入本次修正的问题，并使 execution log 不能证明正文来源；缺少 spawn Provider 时 S6 明确失败。

## Consequences

S6 增加一个主 Agent 规划回合、每章至少一个 Child Session、两个可追溯 Artifact 和 Host 并发调度状态。部署必须注册支持 `outputSchema`、`toolFilter`、`maxDepth` 与 persona 的 `spawn` Provider。并发提高独立章节吞吐量，但每个运行中的 Child 都占用模型和工具资源，因此 Host 默认限制为 3，配置最大值为 8。

章节正式文件只在候选通过后出现；一个分支修复不会阻塞仍有空闲并发槽的无关 ready 分支。章节级失败隔离、基础设施重试与检查点恢复由[章节写作检查点与故障隔离](2026-09-04-bid-chapter-checkpoint-fault-isolation.md)补充；最终仍缺少可用候选时不生成伪完整 manifest。

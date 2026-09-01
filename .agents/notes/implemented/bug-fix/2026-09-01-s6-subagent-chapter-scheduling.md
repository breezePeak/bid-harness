# Agent Note: S6 章节写作由 Host 调度独立 Subagent

Status: implemented

## Problem

S6 原有执行器把章节任务逐个注入同一个 Bid Agent，并以整 Agent 的 idle 状态近似每章完成。该做法让规划对话直接生成正文，无法形成独立 Child Session，也无法证明无依赖章节真实并发或强依赖章节按前置结果解锁。主 Agent、章节生成、文件写入和 Web Evidence 观察共享同一生命周期，任何失败都可能把后续章节建立在污染的会话状态上。

## Decision

`chapter_writing` 保持一个控制面 Stage，但内部明确分成两个所有者。主 Agent 只生成 `chapters/execution-plan.json`；工具限制和参数 Guard 使它只能读取输入并写该计划。计划必须恰好覆盖全部 writable section，声明带原因的强依赖、可并行的弱关联和全局一致性要求，并通过 Host 的哈希、引用与无环校验。

Host 根据有效计划维护 pending、ready、running 和 completed 状态，按确认目录顺序选择 ready section，并以 `chapterWritingMaxConcurrency` 限制同时运行的任务。每个章节通过 `ctx.subagents.start('spawn', request)` 建立无父会话历史的 Writer Child Session；Bid Host 的 session-start 驱动忽略 `origin === 'subagent'` 的会话，防止继承 Bid preset 的章节 Child 启动第二套八阶段流程。强依赖章节只接收已通过前置章节的有界结构化 handoff 和计划原因。每个候选随后由独立 Reviewer Child 审查；候选或审查修复都创建新的 one-shot Writer Child，不把正文或审查任务交还主 Agent。

`chapter_writing` Stage Policy 声明主 Agent 与 Child 所需的 `grep`、`read`、`write`、`web_search` 和 `web_fetch` 能力合集；Executor 为主 Agent 只保留 `read`、`write`，为 Writer Child 只保留 `grep`、`read`、`web_search`、`web_fetch`，为 Reviewer 移除全部工作区和网络工具。Writer Child 使用结构化输出返回一个章节候选，绝对深度上限为 1；参数 Guard 只允许读取 Chunk 索引和 Chunk Markdown。Host 在内存中校验候选、Reviewer 结论和正文引用后原子写入正文、metadata 和审查报告。并发 Web Tool 结果以 Writer Child Session ID 隔离，同一章节的多次尝试可以复用已验证观察，不同章节不能共享上下文。Host 把每个成功 Search-to-Fetch 的章节 ID、Writer Child Session、调用序号、URL、正文哈希和正文快照追加到 S3 来源账本与快照目录，不覆盖 S3 记录；章节新增外部资料必须匹配该持久记录。`chapters/execution-log.json` 记录 Writer、Reviewer、时间、停止原因、校验问题和最终接受者；该记录与计划、审查报告和 manifest 一起构成 S6 的必需 Artifact。

## Alternatives considered

**让主 Agent 自行调用 Subagent 工具。** 该方案把依赖图、并发上限、失败处理和 Artifact 提交交给模型决定，无法保证每个 writable section 都有 Child Session，也无法稳定证明并发和清理，因此不采用。

**使用 fork 继承主会话。** fork 会把规划阶段和既有会话历史带入章节上下文，增加无关信息和跨章节污染；spawn 由 Host 显式注入最小上下文，更符合每章独立写作的所有权要求。

**Child 直接写章节文件。** 该方案需要向 Child 暴露 write 权限，并在候选校验前发布部分 Artifact。结构化返回让 Host 成为唯一提交者，失败候选不会生成正式正文。

**Subagent 不可用时顺序回退主 Agent。** 回退会重新引入本次修正的问题，并使 execution log 不能证明正文来源；缺少 spawn Provider 时 S6 明确失败。

## Consequences

S6 增加一个主 Agent 规划回合、每章至少一个 Child Session、两个可追溯 Artifact 和 Host 并发调度状态。部署必须注册支持 `outputSchema`、`toolFilter`、`maxDepth` 与 persona 的 `spawn` Provider。并发提高独立章节吞吐量，但每个运行中的 Child 都占用模型和工具资源，因此 Host 默认限制为 3，配置最大值为 8。

章节正式文件只在候选通过后出现；一个分支修复不会阻塞仍有空闲并发槽的无关 ready 分支。任一章节最终失败会取消并等待其他已启动 Child 停稳，且不会生成伪完整 manifest。

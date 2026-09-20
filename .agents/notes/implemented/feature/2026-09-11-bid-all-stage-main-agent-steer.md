# Agent Note: Bid 全阶段 Main Agent 交互

Status: implemented

## Problem

Bid 长阶段曾把 Composer、Stage operation 和 Main Agent 当前轮次当成同一生命周期。S2–S4 运行时拒绝消息，S5 的专用交错只覆盖部分私有协议；直接开放输入又会让用户消息与 finish 工具、Child 完成通知或阶段取消互相抢占。用户无法在 Child、Writer 或 Reviewer 运行时立即询问进度，也无法分别停止一条聊天回复和当前阶段任务。

## Decision

S1–S5 和 `docx_export` 的运行态、全部完成态都允许 `send_message`。公开消息通过现有 `Agent.steer()` 和 inbox 留在 Interaction Session；同项目的其他顶层 Session 也能聊天和读取项目快照。实时聊天不调用 `beginOperation()`、不拥有项目锁，也不改变阶段状态或 Artifact。Interaction Session 与阶段执行的所有权由[独立交互与执行通道](../bug-fix/2026-09-14-bid-interaction-execution-lanes.md)记录。

`main-agent-protocol.ts` 限制 Execution Session 只调用当前阶段的私有工具，并登记当前协议消息供 Run 取消时清理。私有请求产生 `agent/error` 时协议保留原始错误，idle 仅用于没有更具体失败的兜底。S2、S3 与 S5 共用该机制；模块不再监听公开用户消息，也不在一个 Session 中切换公开与私有工具。

运行态公开回合只看到阶段 scoped 工具。`bid_stage_inspect` 从项目文件与 Session Log 生成有界只读快照，不取得 mutation lock：S1 返回导入计数，S2 返回分析产物摘要，S3/S4 返回目录和 Mapping 进度，S5/S6 返回最多一百个章节的写作状态、最近问题及页数估算；S4 working outline 缺失时只用 `initial-confirmed-outline.json` 恢复章节摘要和可写 ID，不伪造 Draft。最近公开事件最多六条且逐条截断。详细任务契约只在显式 `task_contract_context` 请求中返回，正文只按结构化引用读取。

S4 浏览器进度直接投影执行日志的稳定任务顺序、标题、阶段、状态、章节范围、最近 Child 身份和最近错误摘要；checkpoint 的完成事实覆盖日志瞬时状态。页面按运行中、失败、未开始、已完成分组显示任务标题，失败项只显示最近错误摘要，不读取 Child transcript。`pending` 和 `waiting_start` 没有 Mapping Progress，客户端清空旧快照且不轮询，避免把重置后的等待开始显示成同步中。

Child、Writer 和 Reviewer Promise 属于 Execution Session，独立于公开回合。活跃项目的 `subagent-report` 与 `subagent-settled` 通知不进入 Interaction Session，后台任务的结构化结果仍由原调度器消费。普通消息只能由模型根据语义选择 inspect 或既有受控 mutation；发送方式、引用和关键词均不产生业务分支。

聊天停止沿用统一 `Agent.cancel({ kind: 'user' })` 生命周期。`agent/cancel-requested` 在 inbox 变更和 abort 前同步发出，Bid Host 在任一同项目 Interaction Session 请求 Stop 且存在活动 Run 时接管该信号，先撤销提交权限，再关闭调度入口、中止 Run 并等待 Execution Session 及 Child 收敛，最后记录 `user_stop` 挂起。暂停仍由 `bid_pause_stage` 和 `bid_resume_stage` 控制当前 operation 的任务准入，不改变 Run 状态。精确恢复与停止的取舍由[统一 Run 生命周期](../architecture/2026-09-13-bid-workflow-run-lifecycle.md)记录。

## Alternatives considered

**为每个阶段创建新的公开聊天 Agent。** 新聊天 Agent 看不到 Interaction Session 的连续上下文，会复制公开工具授权和聊天持久化；独立 Session 只承载 Host 拥有的内部执行，不接收用户消息。

**收到用户消息时取消并重启阶段。** 普通问答会丢弃在途结果、增加模型调用并错误修改阶段和 Artifact；实时回合只插入 inbox，聊天原生 Stop 才触发统一取消生命周期。

**让公开回合继续看见私有工具。** 私有 finish 可能把用户问答误当协议提交，工具 Schema 也会泄露内部控制面；工具必须在请求组装前真实卸载，而不仅依赖执行期 guard。

**按消息关键词直接暂停、恢复或修改。** 准入层没有足够语境区分解释与操作。模型决定意图，程序只暴露确定性的 inspect、mutation 和精确身份恢复能力。

**为实时聊天建立第二个 operation 或轮询后台进度。** 这会与现有项目锁竞争并把聊天纳入失败恢复；inbox 和 Child 结算事件已经提供可唤醒边界，不需要 busy polling。

## Verification

真实 Agent Loop 回放固定内部工具链未完成，连续三条用户消息先按序进入无私有工具的公开请求，随后同一协议恢复并 finish；模型失败回放固定 `agent/error` 的错误码与消息不会被 idle 兜底覆盖。Host 测试固定 S2、S3 executor Promise 未完成，证明回复发生在阶段完成前、Run 未取消、项目检查点与 Artifact 不变，并验证另一 Session 被拒绝；S4 使用真实 in-process Mapping Child 固定模型请求，Main Agent 回复后 Child 仍存活并继续完成。Host 管理的 Child 报告不会触发 Main Agent 模型请求，Run 挂起仍保持 Composer 可用。真实 S5 Writer Promise 测试证明 Main Agent 回复先于 Writer release，Writer 随后继续通过校验。独立测试验证暂停保持当前 Run 并拦住模拟的后续调度，继续释放原调度门；聊天原生 Stop 只挂起同 Session Run，其他 Session 的取消不能越权。

## Consequences

运行阶段同时存在一个 Stage operation、一个 Execution Session、若干 Child 和任意短暂公开回合。公开聊天与内部执行不共享 Session 日志；Run 的停止与恢复仍由项目 operation 统一拥有。私有协议必须登记自己生成的 continuation，新增私有流程应复用通用协议入口。

公开问答的即时性仍取决于 Agent Loop 到达可安全 claim 的 Step 边界，不能强行中断一个不合作的模型或工具 Promise。暂停只属于当前活跃 operation 的内存调度状态，不改写 Workflow 或建立另一套恢复协议；停止将当前 Run 挂起，业务进度保持不变。

本记录部分替代[等待确认阶段交互](2026-09-03-bid-waiting-user-stage-interaction.md)中“运行态拒绝普通消息”的范围规则，并把[S5 整体写作要求门禁](2026-09-09-bid-s5-writing-requirements-gate.md)与[S5 运行对话和页数校验](../bug-fix/2026-09-10-bid-s5-live-chat-page-result-validation.md)的运行对话机制扩展到全部阶段；三份旧记录的等待态 mutation、计划契约和页数验收理由仍独立有效，因此保留为活跃记录。

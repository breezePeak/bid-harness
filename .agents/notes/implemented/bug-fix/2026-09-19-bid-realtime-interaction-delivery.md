# Agent Note: Bid 全阶段实时聊天的准入、身份与展示交接

Status: implemented

## Problem

Bid Run 已由独立 Interaction Agent 执行，但部分 Host 阶段仍关闭主会话输入框，普通输入在 Agent 忙碌时沿用全局排队策略；客户端又曾把尚未由 Host 受理的 outgoing 行混入 QueueDock，并在引用序列化、图片提交和 `Session.prompt` 之间丢失或重建提交身份。结果是 S1-S6 的聊天准入、投递模式、展示位置和正式消息接管没有形成同一条可验证的生命周期。

## Decision

Bid 主会话在 S1-S6 始终开放普通聊天。空闲状态继续进入主 Agent 队列；运行状态在 steering 可用时立即 steer，不可用时回退队列。Run 的执行位置不参与普通消息的准入和投递决策；`pending`、`waiting_start` 与 `failed` 阶段只向主 Agent 暴露 `bid_stage_inspect`，避免聊天隐式启动、重试或推进阶段。

客户端仅在存在 Bid 主会话投影时安装会话级即时投递策略，并在投影退出或组件卸载时恢复默认策略；普通会话和 Bid 子 Agent 保持全局默认行为。一次普通、引用或图片提交从输入机创建唯一 `clientSubmissionId`，本地 outgoing、业务提交处理器、图片准备、`Session.prompt`、Host 队列和持久化 `user/message` 全程复用该身份。Host 只按精确身份接管对应本地行，不再按文本、图片数量或时间猜测关联。

本地 outgoing 属于 ChatView，在 Host 正式消息出现前显示准备、提交或失败状态；Host `placement: queued` 才属于 QueueDock。该决策延续[运行中聊天的本地交接与 Host 后台阶段交互](2026-09-16-running-chat-local-handoff.md)和[普通队列提交保持独立受理](2026-09-16-independent-queue-submissions.md)的所有权边界，并补全其 Bid 全阶段准入和精确交接规则；[Bid 全阶段 Main Agent steer](../feature/2026-09-11-bid-all-stage-main-agent-steer.md)仍保留 Run 路由与停止语义，[Bid 交互执行通道](2026-09-14-bid-interaction-execution-lanes.md)仍保留 Interaction 与 Execution 的分工。

结构化 Question 与 Approval 注册到 `conversation.composer.interaction` chain，并在普通 InputBar 上方显示；`conversation.composer` 只保留真正替换整个普通输入区的硬接管，SubagentReadOnlyComposer 继续使用该边界。Host-native Bid Question 等待期间普通输入框保持可见和可编辑，但该布局不并发执行 Agent turn，也不改变工具调用内部 Approval 或 `ask_user_question` 的等待语义。

## Boundaries

普通聊天不启动、取消或推进 Bid Run，不进入 Execution Session，也不直接修改项目文件；项目写操作继续通过 Host 工具和 CAS 完成。Question 与 Approval 的 selector 优先级、回答协议和等待语义不变。失败 outgoing 可以留在 ChatView 等待用户确认或丢弃，Host 队列仍是排队事实的唯一来源。

## Alternatives considered

**把全局忙碌提交默认改为 steer。** 否决：会改变普通会话和 Bid 子 Agent 的既有投递语义，且无法表达 Bid 投影的会话级生命周期。

**在通用输入组件中按 Bid 阶段硬编码规则。** 否决：这会把 Bid 业务状态泄漏到通用会话层，并产生第二套阶段准入判断。

**按文本、图片数量或提交时间关联正式消息。** 否决：重复文本、并发图片和重连均会产生歧义，只有端到端身份能确定接管对象。

**继续把本地 outgoing 放入 QueueDock 或维护独立展示数组。** 否决：前者混淆客户端准备状态与 Host 队列事实，后者在切换会话和重挂载时形成第二个所有者。

## Consequences

S1-S6 的主会话输入不再因 Run 状态或结构化 Question/Approval 被隐藏；运行中的 Enter 优先即时 steer，空闲和 steering 不可用时仍遵守 Host 队列。每个 Bid 投影必须成对安装和释放会话级投递策略。正式消息只接管同身份 outgoing，重复内容可并发存在；准备失败的行保留明确错误而不会偷偷回填到已继续编辑的草稿。Subagent 只读 composer 仍硬接管整个普通输入区，不暴露可发送 InputBar。

相关既有 Agent Note 均保留活动状态：它们分别承载后台 Run 生命周期、独立受理、执行通道和停止路由的长期约束，本记录只归属全阶段准入、提交身份和展示交接。

## Verification

- 22 个受影响的 Bid、Session、输入机、服务编排、Question、Approval、Subagent 和装配测试文件：588 passed，0 failed。
- `pnpm run test:gui`：4220 passed，0 failed，1 skipped。
- Approval、Question、Bid 写作问答和目录确认的 4 个 Web 回放文件：11 passed，0 failed。
- Workspace 管理、真实启动和滚动契约的定向 Web 回归：21 passed，8 skipped，0 failed。
- Host 构建与客户端类型检查通过；全部改动 TypeScript/TSX 文件的定向 oxlint 通过。
- `git diff --check`：通过。

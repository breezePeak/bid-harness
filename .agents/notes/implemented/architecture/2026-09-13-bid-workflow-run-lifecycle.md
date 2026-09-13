# Agent Note: Bid Workflow 与 Run 使用统一生命周期

Status: implemented

## Problem

一个扁平阶段状态同时表达业务进度和进程执行，会把停止、Provider 故障、后端重启和业务校验失败压成同一个 failed。阶段级停止工具与重试 RPC 又绕开聊天原生取消，使 UI、Main Agent、Host 和各执行器分别拥有一部分停止与恢复规则；迟到的模型或 Child 结果仍可能在停止后提交正式 Artifact。

## Decision

Bid 控制状态分为持久 Workflow 与一次性 Run。Workflow 只保存业务阶段、确认门和不可恢复失败；Run 保存 UUID、epoch、基线项目 revision、运行状态、停止原因、安全错误摘要及完整 Work Descriptor。`project-state.json` version 3 与 Session 事件使用同一控制模型，扁平 runtime 仅作为浏览器视图。

每个 Long Run 在开始前持久化请求正文及输入摘要，Work Descriptor 用 `kind + workId + requestRef + requestSha256 + inputFingerprint` 绑定其中一种明确工作：完整阶段执行、文件接入、资料重映射、目录重生成、目录确认或独立章节修订。恢复按 `kind` 分派适配器并复用同一 workId 的私有工作树，不能只根据 stage 猜测工作；S4 用稳定 Task ID 和当前版本检查点确认已完成任务，未完成的部分进度另以任务语义范围、确认目录、分析产物、语料身份和 Resume Policy 的局部指纹决定复用。

Host 的 `BidRunCoordinator` 是 Long Run 的唯一授权者。它先将 `bid.run.started` checkpoint 到 `project-state.json`，再暴露强制 `BidRunContext`；`baseProjectRevision` 是创建前 CAS 基线，`controlRevision` 是 running 状态已持久化后的提交版本。Operation signal 只参与创建 `run.signal`，执行器、Main Agent、Child、Worker、Parser 和 Renderer 此后只服从 Run 信号。

`BidCommitScope` 在每次正式写入前取得短租约，退休后拒绝新租约，并让已获租约的最小提交收敛。顶层执行器和内部异步调度登记在 Activity Scope；挂起依次关闭调度、退休 Commit 与 Activity、记录 cancelling、清理 Run 私有 inbox、中止并等待 Main Agent、Child、Activity 和 Commit 全部收敛，最后持久化 suspended。`complete()` 同样负责异步持久化终态，Run completed 与其拥有的 Workflow 完成、待确认或 attention 结果在同一次项目 checkpoint 中提交；成功 start 的 Run 不依赖外围 operation 顺便补写终态。

Long Run 的模型候选只写 `runs/<workId>/work/`，正式产物由 Commit Scope 发布，不备份、临时覆盖或回滚 canonical 文件。Commit Scope 与短 ProjectMutation 共用 PublicationBatch：字节先进入事务目录，写入 manifest 和 commit intent 后再替换目标；项目首次读取前会清理未进入 intent 的批次，并对已有 intent 的批次前滚。因此崩溃后的下一次可读状态只对应完整旧版本或完整新版本。

所有短确定性写入归 ProjectMutation，以项目锁、expected revision、PublicationBatch 和一次 revision bump 共同提交；纯读取口只返回现有文件或派生视图，不初始化、修复或刷新文件。项目 revision 只表示 Run 控制转换或 ProjectMutation，不随同一 Run 的进度 checkpoint 和 steering command 增长。Word 模板、预览与导出属于独立 DOCX Operation；DOCX 和 `lastExport` 在一个 PublicationBatch 中提交。

S5 的运行中计划修改和章节修订先写入 Run command journal，再唤醒内存调度器；命令效果与 applied 状态在同一 PublicationBatch 中提交，Host 重启重载 pending 命令。挂起的主 S5 Run 接受 ProjectMutation 形式的修订意图并保留自身身份；只有不存在挂起主 Run 时，独立章节修订才创建 `chapter_revision` Long Run。恢复旧 Writer 时仍按本次 Resume Policy 安装工具 guard，`webAccess=disabled` 对新旧 Writer 都拒绝 Web 工具。

每个 suspended Run 同时产生以 Run ID 派生的 `bid.run.notice`，Host restart 将孤儿 running Run 转为 suspended 时也生成同类通知。浏览器将这一单事件投影为 model-invisible 的聊天时间线行；用户停止使用中性样式，自动中断显示经统一脱敏的 code、message 和 issues。notice 记录被替代的 generic error turn，使同一次失败只显示一个主要错误节点。

`Agent.cancel()` 在修改 inbox 或传播 abort 前同步发出带类型原因的 `agent/cancel-requested`。Bid Host 仅响应当前项目 operation 所属 Main Agent 的 user cause，因此聊天原生 Stop 同时停止公开回复与当前 Run；其他 Session、普通消息和暂停调度不会触发挂起。独立的 `stop_stage`、`retry_stage`、`bid_stop_stage` 及对应 Remote 不属于公开控制面。

挂起后的 Composer 保持可用。扁平 runtime 忠实投影 suspended Run，不以 Workflow 的 ready gate 改写为 pending；Bid 阶段栏只读取该 Host Projection，Main Agent 的运行状态只产生独立恢复检查提示，不能改变阶段文案、状态点或进度卡。S4 进度在挂起后保留完成数、失败数与失败任务负责的 Section，并停止运行态轮询和动画。Main Agent 先用阶段检查读取有界状态，再根据完整聊天语义决定是否调用 `bid_resume_current_run`；工具必须携带 suspended Run ID 与 expected project revision。Host 持锁重读项目并执行 CAS，身份或 revision 改变就拒绝。Host 启动发现 running 或 cancelling 只写 `host_restart` 挂起，不自动恢复。

恢复是执行器级 reconciliation，不是内存续跑。S1 从请求 Artifact 校验并重读原始上传字节；S2 持久化逐条分析记录与 review phase，中断的 reviewing 回到 `review_required`；S3 复用已完整校验的正式 Artifact；S4 将当前版本检查点中 `completed=true` 的 Task 作为完成状态权威来源，执行日志中的 pending、running 或 failed 不能将其降级，恢复队列只包含真正失败与未开始 Task。首个真正失败 Task 完成当前 Section 子树锁定、资料映射和 Host 校验后解除恢复屏障，其余任务立即恢复配置的并发数；已完成结果只参与目录与 Evidence 重建，不进入调度或模型调用。S5 复用计划、章节日志、正文哈希、Reviewer 身份和 pending command。Resume 工具在项目锁、CAS、Work 与输入身份校验及新 Run durable start 完成后才返回 accepted、runId 和 workKind，长任务随后在后台继续。429、Provider 文本和 retry-after 不由 S4 猜测，统一在 Run 边界暴露为可恢复挂起。

## Alternatives considered

**保留阶段级 Stop 与 Retry API。** 两套入口会继续产生不同的取消顺序、UI 权限和恢复结果，也无法让通用 Agent 生命周期的停止按钮成为唯一用户心智模型。

**停止时直接把 Workflow 标为 failed。** 用户停止和基础设施故障都不改变已确认业务进度；把它们写成业务失败会丢失精确尝试身份并迫使恢复依赖模糊阶段名。

**只依赖 AbortSignal 阻止迟到写入。** 结果可以在 signal 检查之后、原子替换之前变旧；Commit Scope 必须在同一个写入入口取得租约，并在 abort 传播前退休。

**让每个入口自行组合锁、写入和恢复。** 分散组合会重新产生第五种生命周期路径；Host 入口必须先选择 Long Run、ProjectMutation、Pure Read 或 Independent DOCX Operation，公共写入能力由相应所有者提供。

**崩溃后回滚已替换的 canonical 文件。** 回滚本身也可能再次崩溃且需要保存旧字节；持久 commit intent 与幂等前滚只保留一个恢复方向。

**自动恢复所有挂起 Run。** 恢复可能继续消耗模型额度或违背用户明确停止；Main Agent 需要结合用户当前意图作决定，Host 只执行带精确身份的请求。

## Consequences

Workflow 业务进度不会因用户停止、Host 重启或可恢复执行错误回退，UI 也不再把挂起渲染成业务失败。恢复能够按原 Work 复用 S1、S2、S4、S5 的持久工作，并拒绝旧身份、旧 revision、错误输入指纹和取消后的正式提交；代价是每个生产 Executor 都必须接受 `BidRunContext`，异步工作必须登记 Activity，正式写入必须取得 Commit 或 ProjectMutation 权限。

Run 的内存执行栈、Promise、调度门和 wake queue 不会跨 Host 重启恢复；只有请求、工作树、检查点和 command journal 可复用。Parser 即使在 Stop 后短暂完成，也只能留下 Run staging，不能发布正式结果。写作要求 marker 绑定已 flush 的 prompt event；新 Session 无法证明该事件时会重新询问。Provider 是否可重试不在阶段实现里按错误文本猜测，未来若需要自动退避，应由拥有 Provider 协议和预算的统一层提供。

本记录改变了[Workspace 项目状态](2026-09-03-bid-workspace-project.md)的磁盘格式与中断恢复方式，并取代[全阶段 Main Agent 实时交错](../feature/2026-09-11-bid-all-stage-main-agent-steer.md)中的独立阶段停止工具和重试动作；两份记录的 Workspace 所有权、项目锁与实时消息交错决定仍然有效。

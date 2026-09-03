# Agent Note: Bid 项目归 Workspace 所有，Session 只承载聊天

Status: implemented

## Problem

把 Bid 产物与阶段状态归属于 Session 会使同一工作区的新聊天从 S1 开始，且无法读取已有分析、目录和章节。用 fork 保留项目进度又会复制聊天与模型上下文，违背新聊天的含义；仅共享文件而保留 Session 锁还允许两个会话并发改写同一项目。

## Decision

`BidWorkspace` 只接收 Workspace 根目录与配置。`projectDirectory` 默认为 `.bid-harness`，该目录统一拥有 manifest、input、corpus、analysis、outline、chapters、output 及 `project-state.json`，不读取或迁移旧的 Session 独立目录。

`project-state.json` schema version 1 保存 runtime、单调递增 revision 和更新时间，是项目进度的持久化来源。Host 在项目锁内集中进行原子 checkpoint；当前 Session 的 `bid.*` 事件仍记录执行结果并驱动 Projection。`bid.project.resumed` 只携带 runtime 与 revision，不向模型注入消息、摘要、提示词或其他会话的日志。

Workspace 的“+”保留 `sessions.create()`。Bid 在 `agent/session-start` 从 cwd 读取项目：没有状态文件时创建 S1 pending；已有项目只同步当前进度，waiting_user、failed、completed 不重新运行。读取到没有活动操作的 running 时保留原阶段，恢复成 failed 并要求用户重试，避免把部分产物当作完成结果。

Host 独占操作以规范 Workspace 路径为键，同一项目的不同 Session 共用锁。Windows 路径键统一大小写；真实路径归一化防止目录别名绕过锁。操作仍记录执行所用 Session 和 Agent，取消、重置与日志写入遵守各自的所有权；不同 Workspace 保持并行。

S6 复用现有 DOCX primitive，按确认目录及其哈希匹配的完整章节 manifest 导出正文；目录顺序和结构标题由 Host 决定，正文标题降到所属章节之下。导出作为现有 program stage 运行，共用执行前与结束后的项目 checkpoint，不新增 UI 操作或模型回合。

## Alternatives considered

**fork 旧 Session 或复制聊天摘要。** 项目进度不需要旧聊天，复制会污染 fresh Session 的模型上下文，并把项目生命周期再次绑到某次聊天。

**继续用 Session 日志作为项目唯一进度来源。** 新 Session 无法独立恢复项目，还必须发现并读取某个旧 Session；项目状态文件使项目身份只依赖 Workspace。

**只替换目录路径，保留 Session 锁。** 不同 Session 会同时执行 Executor 或覆盖相同 Artifact 和 checkpoint，无法保证项目状态与实际产物一致。

**迁移旧目录或保存 artifactSessionId。** 没有旧项目兼容要求，保留两套位置会增加每个读写入口的分支和所有权歧义。

## Consequences

新聊天保持独立历史，同时能读取同一套已上传资料、待确认结果及章节。项目状态文件不包含 conversation messages、reasoning、tool calls、prompt、summary 或 parentSessionId；恢复事件只初始化当前 Session 的控制面。中断恢复按完整阶段重试，不能从不可恢复的执行现场继续。

本记录部分替代[文件接入](../feature/2026-08-29-bid-file-intake-action.zh.md)与[中断恢复和重置](../bug-fix/2026-09-01-bid-interrupted-stage-recovery.md)中的 Session 存储和锁范围；两者保留上传准入、完整阶段重试与取消静止顺序的独立依据。[阶段交互](../feature/2026-09-03-bid-waiting-user-stage-interaction.md)保留受控编辑、Draft CAS 和正式确认的决定，其操作使用同一项目锁。

验证覆盖 fresh Session 无历史继承、S2/S4 等待确认、S5 章节读取、失败/完成/重置后的跨 Session 恢复、running 中断恢复、同项目互斥和不同项目并行；真实 Loader 回放固定项目恢复事件和共享产物路径。S6 验证真实 DOCX 的正文顺序与标题层级，并拒绝目录哈希或章节集合不匹配的输入。

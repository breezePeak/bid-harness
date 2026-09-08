# Agent Note: 删除 Workspace 级联 Session

Status: implemented

## 问题

删除 Workspace 只移除分组记录时，会留下不再有归属的会话、持久化日志和可能仍被选中的实时 Session。把它们显示在 Ungrouped 下既不能表达用户已确认删除对话的意图，也使重新注册同一目录时保留了不可见的历史数据。

Workspace 仍然不拥有项目目录。注册记录只能证明它管理账本中的应用会话，不能证明它可以删除源码、项目文件或上传文件。

## 决策

`WorkspaceRegistry.delete()` 复制该 Workspace 的 `sessionIds`，逐一停止同 id 的实时 Agent 生命周期，再调用 `SessionPersistence.delete(sessionId)`。持久化协调器等待已有的 retirement drain、拒绝仍存活的 Session、清除其协调状态，并要求后端永久删除物化日志。JSONL 后端只删除其拥有的会话目录；SQLite 后端在事务中删除 `sessions` 行及其级联事件。目录与项目文件不经过此路径。

成功的持久化删除发出 `session/deleted`。会话投影缓存删除对应派生行；Host 流将冷态删除转换为 `host/session-removed`。实时生命周期已经发出同一帧时，流会去重，避免浏览器收到两次移除。客户端的既有幂等移除路径会清空会话存储、当前选择和会话缓存。所有 Session 清理完成后，注册表才删除 Workspace 的账本、归档 id、表行和显示顺序。

`AgentRegistry.dispose()` 仅委托支持该操作的 Agent factory，因此 Workspace 包不依赖具体循环实现；正常的 `AgentLoop` 记录并释放每个活跃 handle。没有可停止的实时 Agent 时，持久化删除仍处理冷态 Session。

当前产品确认文案明确说明会删除该 Workspace 下的全部对话，但不会删除本地项目目录或项目文件。

## Alternatives considered

**保留会话并移至 Ungrouped。** 不予采纳，因为这会留下无主对话，并允许当前窗口继续展示已经确认删除的内容。

**递归删除 Workspace 路径。** 不予采纳，因为注册记录不证明该目录及其文件归 Harness 所有。文件系统删除必须由独立能力、边界和确认流程承担。

**只停止实时 Session。** 不予采纳，因为冷态日志会在重连或重新注册后复活，未满足删除历史的语义。

## Testing

持久化契约测试覆盖 JSONL 与 SQLite 删除一个物化 Session 而保留另一条日志。Workspace 与 API 测试覆盖多个被计入的 Session、实时 Agent 停止、另一 Workspace 不受影响、目录保留和移除帧。无密钥 Web 场景覆盖当前选择清空、刷新后不复活、无 Ungrouped 残留、日志删除及本地文件保留。Windows 上的种子重写以 JSON 转义路径，保证同一场景可读取 JSONL fixture。

## Consequences

删除 Workspace 不再是只影响展示分组的可逆操作：重新注册同一路径会取得新 Workspace id，但不会恢复旧对话或手动顺序。它获得了明确的会话数据清理语义，同时维持注册表不触及用户项目内容的所有权边界。此前的仅删注册语义见[Workspace 注册记录删除](2026-07-27-workspace-registration-deletion.zh.md)。

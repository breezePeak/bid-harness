# Agent Note: S4 Web Research Pool 与 Chunk 证据边界

Status: implemented

## Problem

S4 Mapping Child 直接调用 `web_fetch` 时会在模型上下文中接收整篇网页，并把临时 URL 作为证据提交。并发 Child 直到各自任务结束才发布快照，无法及时复用同一来源；S5 又只能按整篇 Snapshot 授权读取，章节映射与实际引用范围无法精确对应。长网页因此放大上下文、重复抓取和跨章节证据污染风险。

## Decision

S4 Child 只获得 `web_search` 和 `web_fetch`。`web_fetch` 由 Host 路由到 Research Pool，将成功正文转换为 Snapshot，并在返回 Child 前原子发布 Snapshot、Markdown Chunk 索引和 Web ledger。返回值只包含 Source 元数据、标题目录和有界 Chunk preview，不包含整篇正文。规范化 URL 共享 single-flight；最终 URL 与正文 SHA-256 决定 Source 身份，相同正文身份只登记一次；不同 requested URL 在提交临界区再次按 Source 身份检查并只保留一个 ledger Source。

Host 使用 Markdown AST 的顶层完整块生成确定性 Chunk，按标题路径和约 6000 字符软目标分组；正常 Block 保持完整，超长 Block 按换行边界切分，单行再按字符兜底，所有 Chunk 不超过 12000 字符。Chunk 使用 `W:WEB-…:C0001` 稳定引用，并保存正文偏移、行范围和哈希。Child 通过 `list_research_sources`、`list_web_chunks` 导航，只能通过 `read_source` 读取单个 Chunk；只有当前 Child 实际读取的 Chunk 可进入研究依据、章节材料提交和 Final Check 的新保留结论。

Evidence Map schema v11 的 Web 材料保存 `source_id + snapshot_path + chunk_refs`；同一 Source 的不同 Chunk 集合按 `source_id + canonical chunk_refs` 区分。S4 checkpoint schema v11 继续保存任务、结构判断、复核和恢复状态；恢复先验证 Snapshot，再从 Snapshot 确定性重建缺失或非法 Chunk 索引。最终清理按实际 `chunk_refs` 同时裁剪 ledger、Snapshot 和索引。

S5 Writer 只看到当前 Section 映射的 Chunk 与对应行范围，不能 grep 或整篇读取 S4 Snapshot；Reviewer Evidence Pack 只包含候选实际引用的 Chunk。S5 自己的 `web_search`/`web_fetch` 保持不变，本章新抓取来源仍可完整读取，并在持久化时生成同格式索引与 Chunk 引用；S5 additional Web 当前仍按成功 raw fetch 绑定整份 Chunk，精确记录 Writer 实际读取 Chunk 属于后续工作。

## Alternatives considered

**继续向 S4 Child 返回整篇 `web_fetch` 正文，只在提交时增加 Chunk 引用。** 拒绝。模型上下文仍承受整篇正文和重复抓取，且 Host 无法证明提交的 Chunk 是 Child 实际读取的范围。

**只按固定字符切片。** 拒绝。切片会截断列表、表格和代码块，使引用范围难以阅读和复核；Markdown 顶层块提供足够小且确定性的结构边界。

**为共享池新增独立网络 Provider 或缓存服务。** 拒绝。现有 `web_fetch` 已拥有网络与安全边界，Host 包装器、运行内 Map 和原子产物提交足以满足隔离、并发复用与恢复。

## Consequences

S4 的 Web 工具统计名称为 `web_search`、`web_fetch`、`list_research_sources`、`list_web_chunks` 和 `read_source`；Child allow-list 与 Host 注册使用同一组名称。相同 URL 的并发研究只触发一次网络抓取，不同 URL 重定向到同一 Source 时只登记一个 Source；先完成抓取的 Child 可立即让兄弟发现来源。Chunk preview 只用于导航，不能证明正文已读。Evidence Map v10 及缺少 Chunk 索引的运行产物不再作为当前格式接受；有效旧 Snapshot 可在 S4 恢复时重建索引。S5 additional Web 仍由 `web_fetch` 直接提供正文，持久化时暂按该次 fetch 的完整 Chunk 集合绑定，精确推导 Writer 实际使用的 Chunk 尚未实现。

本记录细化[并行资料映射](../feature/2026-08-30-bid-evidence-mapping-agent-stage.md)、[逐叶研究任务](2026-09-11-s4-leaf-mapping-task-scope.md)与[章节写作](../feature/2026-08-30-chapter-writing.md)中的 Web 研究、候选传递和 S5 读取边界；这些记录的任务拓扑、并发、资料角色和章节协议继续有效。

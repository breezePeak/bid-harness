# Agent Note: Bid S4 映射子 Agent 的同会话修复

Status: implemented

## Problem

同一 Mapping Task 的校验失败如果重新启动一次性 Child Session，会丢失已读 Corpus、工具调用和被拒结果，页面出现重复的同名 Child。即使保留 Child，上轮 search 与本轮 fetch 也会因按修复轮次裁剪工具记录而失去关联；按 Agent 对象相等识别结果还会遗漏同 Session 恢复前的调用。最终合并如果仅以 URL 查找所有任务的快照，不同任务抓取同一 URL 的版本也可能串绑。

## Decision

Evidence Mapping Executor 为每个 Mapping Task 建立一个 fresh-context、可继续的 Child，并在同一 Child 的后续轮次投递 Host 的具体校验问题。Child 的最终回复是原始 JSON；Host 在每轮 idle 后从该轮 assistant 消息读取 JSON，并继续执行严格 partial Schema、覆盖、Corpus 和网页证据校验。执行日志的所有 attempts 因而共享同一 `child_session_id`。

Web 来源以当前任务的 Child Session 为范围。Host 在一次阶段执行内按 Session ID 和 callId 累计真实工具返回，每轮与该 Child 的完整持久化事件配对并重新计算快照。Session ID 允许关联恢复前后的 Agent 实例；持久化事件用于证明调用与返回顺序，不能从展示文本伪造缺失的 canonical result。有效来源必须满足 URL 来自 search sources、fetch 成功且正文非空，以及 `search_result_seq < fetch_call_seq < fetch_result_seq`。

Host 在合并章节结论时保留原任务的快照归属。每个 Child 只负责一个可写 Section；目录深化的补充任务替换章节时，其来源也随结论替换。最终 ledger 只写入最终章节实际引用的 sources，并执行文件、路径和哈希校验。相同无效 URL 的重复引用只生成一条 partial 校验问题。

Host 按 manifest 的完整 file_id 和 chunk 身份验证本地证据，并要求当前 Child 有成功 read 正文的日志。模型输出错误与基础设施错误的重试分类见[章节证据新鲜度](../architecture/2026-09-03-bid-section-evidence-freshness.md)。

## Alternatives considered

**每次校验失败都启动新的 one-shot Child。** 不采用，因为重试无法复用已经取得的资料和错误上下文，也直接造成重复任务卡片。

**让模型继续手写完整哈希且不做 Host 还原。** 不采用，因为 `file_id` 是不承载业务语义的内部标识；在唯一前缀条件下由 Host 还原不会放宽对实际 Corpus chunk 的验证。

**扩展 continuable 子 Agent 的跨轮 structured output 协议。** 暂不采用，因为该协议当前明确只服务一次性 run。S4 以 JSON 回复加 Host 严格解析实现同会话修复，不改变通用 subagent 的一次性 structured-output 约定。

**只累计各轮已生成的快照，或共享整个阶段的 Web 记录。** 前者无法关联尚未完成的跨轮 search→fetch；后者无法证明当前任务自己执行了搜索和抓取，因此均不采用。

## Consequences

每个 S4 Mapping Task 在一次阶段执行中只创建一个 Child Session，失败修复保留其上下文，已通过的兄弟任务不重跑。JSON 前后缀或字段错误会被 Host 明确记录并反馈到同一 Child；该路径使用 Host 严格解析作为 Artifact 准入条件。聚焦测试覆盖跨轮 search→fetch、Session 恢复、兄弟任务隔离、同 URL 的原任务绑定和补充映射覆盖；真实 Agent 循环与源码 Loader 回放固定修复对话、工具顺序和最终 Artifact。

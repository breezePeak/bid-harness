# Agent Note: S5 私有语义提交与 Host 确定性组装

Status: implemented

## Problem

关系计划、章节候选和独立审核包含大量 Host 已掌握的身份、索引、顺序和文件字段。让模型复制整份记录会把拼写差异或漏项升级为新 Child 重试；只减少提示词字段又无法在结构化提交结束前发现资料引用错误。并行 Reviewer 还需要独立的记录状态和可信原文，不能用全局当前 Reviewer 或 Writer 摘要代替。

## Decision

S5 分别拥有 planning 草稿、Writer 语义输入与 Reviewer Checklist 协议，保留现有章节调度器。Host 按确认目录预置关系计划，模型只提交特殊关系及真实全局一致性要求。Writer 使用章节内稳定 M/F/W 引用并提交完整正文；身份与 Blueprint 索引由 Host 绑定，资料错误在当前 `submit_chapter` 的工具执行路径中返回。Reviewer 使用当前候选的 R/Q/E 引用分批 upsert，Host 从 canonical 记录生成正式报告。

独立 Reviewer 的 in-process one-shot 在创建事务中等待父 Agent 作用域的 `subagent/child-setup`，让本次执行按真实 parent、Child 和请求标签安装私有能力。工具在首轮模型请求前可用，注册随 Child scope 释放。S5 finish 调用 `concludeTurn()`，只在权威 `tools/result` 成功后确认，嵌套提交同时等待外层结果。普通文本结束但未 finish 时，同一 Child 有界续行；新失败重试可以重建瞬态状态，不增加跨进程半份报告格式。

Evidence Pack 只包含相关 S2 确认事实、当前候选实际使用的本地 chunk 与 Hash 验证后的 Web 原文，以及允许的前置 handoff。来源身份与允许的声明种类由 Host 校验，适用性与语义支持由 Reviewer 判断；旧标书、Web 和 handoff 不能自动证明本项目企业事实。

任一 missing、quality=false、unsupported claim 或额外阻断生成 `repair`。成功 finish 表示报告完整，不表示正文通过。正文在审核前可读，完整候选语义修复按 `modelStageRepairAttempts` 回到同一 Writer，见[可续写 Writer](2026-09-07-s5-continuable-writer.md)；后续仍为 repair 或遭遇持续传输错误时保留合法已审候选和真实报告。独立合法 plan 可以在没有 execution-log 时复用；章节恢复验证真实资料、正文、报告、Hash 和 Child 身份，损坏章节重排，合法 repair 继续复用。

持久化路径、字段和版本保持不变。`review_sha256` 与 `review.candidate_sha256` 都绑定章节正文的 `chapterCandidateSha256()`；短引用只存在于当前执行协议。最终 Validator 与正常提交共用覆盖集合、引句及 verdict 一致性检查，不增加所有章节必须 pass 的阶段完成或导出条件。

## Alternatives considered

**仅精简 Prompt 或 JSON Schema。** 原始 parser、工具权限和提交时机仍会拒绝简化值，或在 Child 结束后才发现错误；语义输入解析和提交前绑定必须一起改变。

**在 start 返回后给 Reviewer 补装工具。** Child 此时已经启动，第一轮请求可能缺少工具。以一个全局当前 Reviewer 关联创建还会串扰并行章节，因此使用创建事务内的明确扩展点。

**逐个 R 强制一次模型往返。** 每批允许多项并分别返回成功与错误，既保留局部纠错，也不人为增加请求轮次。

**审核不通过就禁止持久化或导出。** 这改变已存在的实时可读、有限修复和保留实际问题语义；协议完整性不等于内容通过。

## Consequences

模型负责关系判断、写作和语义审查，Host 负责身份、集合、顺序、文件与最终 Artifact。引用编号在同章修复中稳定，Q 与审核记录随候选重建；批次 upsert 和可替换 summary 不残留已撤销阻断。工具和证据包增加明确的私有协议成本，不能据此推断 Token 节省比例。

[章节调度](../bug-fix/2026-09-01-s6-subagent-chapter-scheduling.md)、[覆盖索引绑定](../bug-fix/2026-09-04-bid-chapter-coverage-host-binding.md)、[检查点与故障隔离](../bug-fix/2026-09-04-bid-chapter-checkpoint-fault-isolation.md)仍分别保留并发所有权、索引与语义分离、故障预算及 fallback 的独立理由；本记录补充它们的私有提交机制，不替代这些决定。

验证由 S5 协议、资料绑定、真实 AgentLoop 并发与取消测试，以及 headless 示例的真实 Loader 无密钥回放固定。回放包含同 Writer 错误引用纠正、Reviewer 漏项 finish 和分批提交；它验证协议接入，不证明真实模型的事实审查质量。

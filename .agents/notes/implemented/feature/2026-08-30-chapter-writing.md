# Agent Note: 已确认目录的章节写作与按需研究

Status: implemented

## Problem

已确认的技术标目录需要逐个生成全部可写章节，同时不能为每章增加控制面阶段，也不能把全书上下文塞进一次模型请求。章节写作还必须消费 S3 已准备的外部 Evidence，并在当前章节资料不足时补充公开技术知识；否则外部资料会在 S3 与正文之间断链，或迫使 S6 依赖未经原文读取的搜索摘要。

## Decision

`chapter_writing` 从 `outline/confirmed-outline.json` 按父节点和顺序确定工作清单。主 Agent 只生成章节关系计划，Host 按强依赖 DAG 和并发上限启动每章独立 Writer Child；每章任务携带紧凑项目上下文、当前 Blueprint、关联 Requirement、Scoring、Compliance，以及按关联映射筛选并去重的 S3 本地 Evidence、外部 Evidence 和缺失主题。Writer 通过结构化输出返回候选，只有 Host 写入章节正文、Metadata sidecar 和 `chapters/manifest.json`。

S6 Stage Policy 允许 `grep`、`read`、`write`、`web_search` 和 `web_fetch`，Executor 按角色收窄为主 Agent 的 `read`、`write`、Writer 的 `grep`、`read`、`web_search`、`web_fetch` 和 Reviewer 的空工具集。Writer 先消费现有资料，再按当前章节需要执行本地补搜；只有仍缺少公开技术知识时才执行 Search-to-Fetch。Executor 在分发前确认 Web 工具已由 Bid Preset 注册，并将本章新增外部来源与 Writer Child Session 事件和进程内规范 Tool 结果关联；搜索必须先返回该 URL，随后成功获取非空原文，Metadata 中的 `retrieved_at` 必须等于 Fetch 结果记录时间。Host 将验证后的来源追加到 S3 来源账本，并持久化实际交给 Writer 的正文快照；搜索摘要、失败读取及其他章节调用不能进入本章新增外部 Evidence。企业案例、资质、人员、产品实有参数、既有能力和内部流程仍只能由本地 Evidence 证明，缺失项保留在 `unresolved_topics`。

Chapter Metadata 与 Manifest 使用 Schema v4，分别保存 `evidence_used`、`additional_materials`、`external_evidence_used`、`additional_external_materials` 和 `unresolved_topics`。前两类区分 S3 已映射与 S6 新发现的本地 Evidence，后两类区分 S3 已映射与 S6 当前章节新发现的外部 Evidence；规范化 URL 不得跨外部数组重复，本地 Chunk 不得跨本地数组重复。

S6 Validator 将 Manifest 绑定到 confirmed-outline 哈希，要求每个可写章节恰有一个非空且非链接的正文和匹配的 Metadata，检查遍历路径、章节映射、must-answer 覆盖、本地 Evidence chunk 与行范围，并要求 `evidence_used` 和 `external_evidence_used` 分别属于当前章节相关的 S3 Requirement、Scoring Mapping 或 research topic。每个 `additional_external_materials` 条目还必须匹配同章 Writer 尝试的持久 Search-to-Fetch 来源和正文哈希。重试 S6 时先删除旧 `chapters/` 树。

## Alternatives considered

**一次请求生成整本标书。** 这会累积无关上下文，且无法校验覆盖、单章来源和单章恢复。

**每章一个控制面 Stage。** 这会把固定业务流程膨胀为随文档大小变化的状态集合。

**在 Chapter Executor 内新增 Web Client。** 这会绕过现有 Web Service、Provider、Tool Registry、权限限制和 Session 日志，形成第二套不可统一审计的研究链路。

**只通过 Prompt 要求先 Search 后 Fetch。** 模型仍可能把摘要或失败读取写入 Metadata；Executor 对当前尝试的规范 Tool 结果和持久事件做确定性关联后才接纳新增外部来源。

## Consequences

S6 只有在完整 Manifest 通过校验后才进入 `book_review/pending`。Metadata 是可追溯执行记录而非技术标正文，后续审核和 DOCX 阶段可以区分四类证据并将每个已确认章节映射到唯一 Markdown 文件。无强依赖章节在 Host 并发上限内并行；强依赖章节只接收已接受前置章节的有界 handoff。

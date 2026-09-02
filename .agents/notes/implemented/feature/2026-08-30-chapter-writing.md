# Agent Note: 已确认目录的章节写作与按需研究

Status: implemented

## Problem

已确认的技术标目录需要逐个生成全部可写章节，同时不能为每章增加控制面阶段，也不能把全书上下文塞进一次模型请求。章节写作还必须区分项目相关资料、旧参考标书和 Web Snapshot 的使用权限，并在当前章节资料不足时补充公开技术知识；否则资料会在 S3 与正文之间断链，或迫使 S6 依赖未经原文读取的搜索摘要。

## Decision

`chapter_writing` 从 `outline/confirmed-outline.json` 按父节点和顺序确定工作清单；人工目录框架在 S5 确认后不再进入正文阶段。主 Agent 只生成章节关系计划，Host 按强依赖 DAG 和并发上限启动每章独立 Writer Child；每章任务携带紧凑项目上下文、当前 Blueprint、关联 Requirement、Scoring、Response Point、Compliance、Research Topic、缺失主题和写作维度，并把 S3 `reference`、`reference_bid` 与 Web Snapshot 分组提供。Writer 通过结构化输出返回候选，只有 Host 写入章节正文、Metadata sidecar 和 `chapters/manifest.json`。

S6 Stage Policy 允许 `grep`、`read`、`write`、`web_search` 和 `web_fetch`，Executor 按角色收窄为主 Agent 的 `read`、`write`、Writer 的 `grep`、`read`、`web_search`、`web_fetch` 和 Reviewer 的空工具集。Writer 可读取 manifest 中成功解析的 `reference` 与 `reference_bid` Chunk 及相邻 Chunk/index，也可读取来源账本登记的 `analysis/web-sources/WEB-*.md`；Read Guard 明确拒绝 tender 和 outline_framework Corpus。普通 `reference` 只支持事实与技术参考，`reference_bid` 允许按 usage 复用或适配，但正文必须清理旧项目事实。

Writer 先消费现有资料，只有仍缺少公开技术知识时才执行 Search-to-Fetch。Executor 在分发前确认 Web 工具已由 Bid Preset 注册，并将本章新增来源与 Writer Child Session 事件和进程内规范 Tool 结果关联；搜索必须先返回该 URL，随后成功获取非空原文。Host 将验证后的来源追加到来源账本，按最终 `source_id` 持久化正文快照，再把候选 URL 绑定为本地 `source_id + snapshot_path`；搜索摘要、失败读取及其他章节调用不能进入本章 Web Evidence。企业案例、资质、人员、产品实有参数、既有能力和内部流程仍只能由本地资料证明，缺失项保留在 `unresolved_topics`。

Chapter Metadata 与 Manifest 使用 Schema v5，只保存 `local_materials_used`、`web_materials_used` 和 `unresolved_topics`。本地条目保留 `source_kind + file_id + chunk + usage`；Web 条目保留已落盘的 `source_id + snapshot_path`。Writer 候选可以临时返回 `additional_web_materials` URL，但该数组不会直接持久化，Host 绑定成功后才合入 `web_materials_used`。

S6 Validator 将 Manifest 绑定到 confirmed-outline 哈希，要求每个可写章节恰有一个非空且非链接的正文和匹配的 Metadata，并检查遍历路径、章节对应、must-answer 覆盖及所有真实资料引用。本地引用必须匹配 manifest 角色与其 Chunk index，Web 引用必须匹配来源账本中的路径和正文哈希；Validator 不要求正文资料等于某个 S3 Mapping 集合，也不重新联网判断内容相关性。重试 S6 时先删除旧 `chapters/` 树。

## Alternatives considered

**一次请求生成整本标书。** 这会累积无关上下文，且无法校验覆盖、单章来源和单章恢复。

**每章一个控制面 Stage。** 这会把固定业务流程膨胀为随文档大小变化的状态集合。

**在 Chapter Executor 内新增 Web Client。** 这会绕过现有 Web Service、Provider、Tool Registry、权限限制和 Session 日志，形成第二套不可统一审计的研究链路。

**只通过 Prompt 要求先 Search 后 Fetch。** 模型仍可能把摘要或失败读取写入 Metadata；Executor 对当前尝试的规范 Tool 结果和持久事件做确定性关联后才接纳新增外部来源。

## Consequences

S6 只有在完整 Manifest 通过校验后才进入 `book_review/pending`。Metadata 是可追溯执行记录而非技术标正文，后续审核和 DOCX 阶段可以区分普通资料、旧标书和 Web Snapshot，并将每个已确认章节映射到唯一 Markdown 文件。无强依赖章节在 Host 并发上限内并行；强依赖章节只接收已接受前置章节的有界 handoff。

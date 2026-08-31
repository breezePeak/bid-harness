# Agent Note: Bid 通过实时 Agent 执行技术资料映射

Status: implemented

[English](2026-08-30-bid-evidence-mapping-agent-stage.md) | 中文

## Problem

招标分析已经识别 Requirement 与评分项，但后续技术标写作需要可用的本地技术资料和明确缺口，不能假定存在名称匹配的文件就可使用。

## Decision

现有 Bid Host 推进路径把 `evidence_mapping` 与招标分析并列注册。Executor 等待实时 Session Agent，清除旧的 evidence map、Web 来源账本和页面快照，把本轮工具限制为 `grep`、`read`、`write`、`web_search` 和 `web_fetch`，并只注入当前 Session 路径和 S3 任务。Agent 读取 manifest 与 S2 Artifact，自行生成搜索词，在 grep 后读取候选分块，并且只能写入 `analysis/evidence-map.json`。

Artifact v3 为每个 S2 Requirement 与 Scoring 项各保存一个 mapping，并增加 Agent 自主生成的 `research_topics`。Topic 可关联零个或多个 Requirement，以及精确的 Scoring ID 与原始 response_point；它保存项目级或跨项研究的 findings、writing_dimensions、材料和缺口，供 S4 设计目录。每项本地资料引用 manifest 文件、索引分块、闭区间行号、摘要及一种写作用途：`reuse` 表示逻辑可高度复用，`adapt` 表示需要结合项目改写，`reference` 表示技术参考，`background` 表示用于理解项目。直接 mapping 可为空，因为研究发现和缺口不一定需要逐项材料。

S3 根据项目、技术要求、评分项、response_points、合规约束和已有资料自主决定是否执行本地检索、`web_search → web_fetch` 或直接记录缺口；本地命中不禁止外部研究，本地未命中也不强制联网。Executor 在派发前确认两个 Web Tool 均已注册，Composition 缺失会明确使阶段失败。Executor 在派发任务前记录 Session Event 序号，并在当前 Agent 的 effect-scoped `tools/result` observer 中捕获本轮规范 Tool Value。它用 Call ID 将 observer 结果与边界后的 `tool/call`、`tool/result` 事件配对，因此其他 Session、以前阶段和失败 attempt 的调用不能进入本轮来源。

Host 只接受搜索成功、目标 URL 出现在结构化 `sources`、随后抓取同一规范化 URL、抓取成功且 HTTP 状态为 2xx、正文与模型可见结果均非空的链路。URL 使用标准 parser，只接受 HTTP(S)，移除 fragment 和默认端口，并保留完整 origin、path 与 query；hostname、路径前缀和字符串包含关系都不构成匹配。每个有效抓取生成一条 `analysis/web-evidence-sources.json` 记录，并把最终 `ToolExecutionResult.content` 中实际交给 Agent 的有界文本原样保存到 `analysis/web-sources/<source_id>.md`。Host 不再次请求 URL；快照 SHA-256 对保存的 UTF-8 文本计算，`source_id` 由 fetch Call ID、最终 URL 与内容哈希派生。

来源账本记录 schema 版本、阶段、search/fetch Call ID、事件顺序、查询、搜索发现 URL、请求 URL、最终 URL、HTTP 状态、有效截断标志、Session Result 时间、内容哈希和快照路径。没有联网时 Host 仍写入 sources 为空的账本，使本地资料与仅 `missing_topics` 的结果保持相同 Artifact 集合。

S3 完成权属于 Validator。它校验 Evidence Map、来源账本、S2 标识完整覆盖、manifest 文件与解析状态、分块归属、本地引用行号，以及快照是否位于 Session Workspace、是否为普通非链接文件并与账本哈希一致。每个 `external_material.url` 必须精确匹配有效来源的请求 URL 或最终 URL；Agent 自报的 `retrieval_method` 与 `retrieved_at` 不构成来源证明。只有全部校验通过，Host 才记录阶段完成并推进到 `outline_generation/pending`。

`external_materials` 使用 title、http(s) URL、publisher、retrieved_at、retrieval_method、usage、summary 与 supports；usage 只允许 `reference` 或 `background`。企业事实、产品能力、人员经验和服务承诺只能由本地资料证明，缺少本地依据时保留 `missing_topics`。网页内容是非可信研究资料，网页中的指令、命令、提示词修改或写文件要求都不能改变 S3 的任务、工具权限或唯一输出路径。

## Alternatives considered

**把 grep 命中直接当作资料。** 不采用，因为必须读取候选分块才能理解上下文并判断写作用途。

**增加第二套检索或模型 Runtime。** 不采用，因为 Session Agent 与文件系统工具已经提供所需的可记录执行路径。

**把搜索摘要直接保存为外部资料。** 不采用，因为 Provider Answer 和 Snippet 未证明 Agent 已读取原始来源，也不能可靠确认来源支持当前技术项。

**根据 Evidence Map 中 Agent 自报的 URL 补抓或补建账本。** 不采用，因为二次请求的内容可能变化或失败，也无法证明与 Agent 当时看到的结果相同。

**把规范 Tool Value 写入 Session Event。** 不采用，因为现有 `tools/result` observer 已在执行期间提供 lossless value，而 durable `tool/result` 保存模型可见内容、Call ID 与时间；来源账本只需要 S3 Host 在当前 attempt 内组合这两类现有事实。

**要求每个 mapping 必须有资料。** 不采用，因为识别缺少的技术内容正是 S3 的必要产出。

**固定来源策略或关键词规则。** 不采用，因为它们会让 Host 替代 Agent 判断研究价值。

## Consequences

S3 在不增加阶段专用浏览器流程、模型客户端或状态机的前提下复用现有 Web Tool。搜索、抓取、超时、取消、网络错误、非 2xx 响应和空正文都不能形成有效来源；结构合法的 mapping 可以用空 `external_materials` 与明确 `missing_topics` 完成。通用 automatic-stage retry 会清除前一次的 evidence map、来源账本和全部快照，随后重新建立本轮边界。

来源闭环证明 URL 来自本轮搜索、页面在本轮成功抓取、Agent 收到了被保存的有界文本且快照未被修改；它不自动证明 summary、supports、publisher 或网页内容在语义上真实。修复前已含 external materials 而没有 Host 账本的开发 Session 不受信任，必须重新运行 S3，不能从 Evidence Map 自动补账。HTTP Fetch Provider 尚不阻止私网、回环、链路本地或 DNS 重绑定目标，部署必须隔离 Harness 可访问的敏感内部网络；SSRF 防护属于独立安全任务。

# Agent Note: Bid 技术资料映射采用主 Agent 规划与并行 Subagent

Status: implemented

## Problem

S3 需要同时理解整个项目、覆盖全部技术 Requirement、Scoring 与 Response Point，并在本地分块和公开技术资料中寻找可用于后续写作的依据。把全局分析、逐项检索和最终汇总都交给同一个 Agent 串行执行，会让上下文持续膨胀，互不依赖的研究任务不能并发，局部失败还会重跑已经完成的工作。

本地证据如果用调用方提交的 chunk 路径字符串作为身份，同一分块会因绝对路径、相对路径或路径分隔符不同而被误判。人工框架如果进入 Evidence，还会迫使 S3 为不提供正文事实的目录标题制造关系。

## Decision

S3 保留现有 `evidence_mapping` 阶段、正式 Artifact 和 Orchestrator 推进方式。主 Agent 只读取 manifest 与 S2 Artifact，完成全局分析，并把工作按业务主题动态拆成内部 Mapping Task；Host 校验每个 Requirement、Scoring 和 Response Point 都至少分配给一个任务，任务之间允许共享研究主题，不按文件角色或固定技术分类拆分。

Host 复用 `@deepseek-ai/dsh-subagent` 的 `spawn` Provider，在可配置并发上限内为每个任务启动 fresh-context Child Session。Child 只获得移除招标来源引用后的当前任务 S2 切片、`reference`/`reference_bid` 定位和全局研究提示，工具限制为 `grep`、`read`、`web_search`、`web_fetch`，深度上限为 1。Child 的 `grep` 与 `read` 只能访问这两种成功入库文件的分块；招标文件与人工框架不能作为 Evidence。Host 校验任务 ID 覆盖、本地引用和该 Child 的 search-to-fetch 结果；失败问题在同一可继续 Child 的后续轮次修复，已接受的兄弟结果保持不变。每次运行都显式 dispose。

Host 汇总所有 Child 的 Web Tool 结果，沿用来源账本与有界快照机制持久化公开资料。只有同一 Child 在本轮先搜索得到 URL、再成功抓取该 URL 的非空正文，才能形成来源记录；Host 不重新请求 URL，而是保存模型实际收到的有界文本并校验正文哈希。局部结果按稳定业务 ID 合并；本地资料按 `source_kind + file_id + chunk id` 去重，公开资料由临时 URL 绑定为 Host 保存的 `source_id + snapshot_path`。Host 只保存最终 Evidence Map 实际引用的 Snapshot，并直接写入正式 `analysis/evidence-map.json`；主 Agent 不接收全部 Child 结论或重写最终 Artifact。该简化由 [S3 Host 确定性合并](../simplification/2026-09-01-s3-host-evidence-canonicalization.md)记录。

本地证据身份由 `source_kind + file_id + chunk id` 决定。模型只提交 `chunk_XXXX`，Validator 根据 `file_id` 对应 manifest 文件的 chunk index 解析规范路径；不存在的 chunk、角色不一致、普通资料使用复用权限、招标文件或人工框架引用都失败。

`evidenceMappingMaxConcurrency` 默认 3，可配置为 1–8。内部计划和执行日志不属于正式阶段 Artifact；重试 S3 会清除旧计划、执行日志、Evidence Map、来源账本和快照。

执行日志按 Mapping Task 持久化 `pending`、`running`、`completed` 和 `failed` 状态。S3 运行期间，`bid/getEvidenceMappingProgress` 只将总数、已完成、映射中、未开始和失败数返回给主 Agent 页面；页面以一秒间隔刷新，不读取计划、日志、文件路径或 Child 结果。

## Alternatives considered

**继续由主 Agent 串行完成全部检索。** 不采用，因为任务天然可独立执行，串行方案不能隔离上下文，也会让局部修复重复消耗已完成工作。

**把任务写成文件并让 Child 自行发现。** 不采用，因为 Subagent 请求已经提供结构化任务、工具过滤、输出 Schema 和生命周期管理，不需要增加一套文件队列协议。

**按文件角色或固定技术分类拆任务。** 不采用，因为拆分应由当前项目的 Requirement、Scoring、Response Point 和研究主题决定，固定分类会遗漏跨领域关系或产生无效任务。

**继续用 chunk 路径字符串识别本地证据。** 不采用，因为路径是表示方式，不是稳定身份；manifest 与 chunk index 已拥有文件和分块的权威关系。

**把人工框架标题建成 Evidence Mapping。** 不采用，因为框架只提供 S4 目录骨架，不提供当前项目事实或正文资料。

**根据模型提交的 URL 事后补抓。** 不采用，因为二次请求可能变化或失败，也不能证明保存内容就是 Child 当时读取的正文。

## Consequences

S3 的阶段和正式输出保持不变，但执行依赖支持 fresh spawn、`outputSchema`、深度限制、工具过滤和 persona 的 Subagent Provider；缺失能力会在任务开始前明确失败。并发 Child 的完成顺序不影响最终合并顺序，单个 Child 的失败只消耗该任务的修复额度。

来源闭环现在覆盖所有 Child Session，证明公开 URL 来自相应 Child 的搜索并在同一运行中成功抓取，且保存内容与模型可见文本一致。它仍不证明网页内容或 Agent 摘要在语义上真实，企业事实仍必须来自本地资料。通用 HTTP Fetch Provider 不阻止私网、回环、链路本地目标或 DNS 重绑定，部署仍需隔离 Harness 可访问的敏感内部网络。

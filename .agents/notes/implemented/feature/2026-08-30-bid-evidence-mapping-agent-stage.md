# Agent Note: Bid 技术资料映射采用 Host 调度与并行 Subagent

Status: implemented

## Problem

S3 需要同时理解整个项目、覆盖全部技术 Requirement、Scoring 与 Response Point，并在本地分块和公开技术资料中寻找可用于后续写作的依据。把全局分析、逐项检索和最终汇总都交给同一个 Agent 串行执行，会让上下文持续膨胀，互不依赖的研究任务不能并发，局部失败还会重跑已经完成的工作。

本地证据如果用调用方提交的 chunk 路径字符串作为身份，同一分块会因绝对路径、相对路径或路径分隔符不同而被误判。人工框架如果进入 Evidence，还会迫使 S3 为不提供正文事实的目录标题制造关系。

## Decision

S4 保留 `evidence_mapping` 阶段、正式 Artifact 和 Orchestrator 推进方式。任务拓扑由 Host 按 `outline/initial-confirmed-outline.json` 的可写叶子确定，一章一个任务；Child 负责资料检索语义，Main Agent 只执行一次证据驱动的目录深化。[章节证据新鲜度](../architecture/2026-09-03-bid-section-evidence-freshness.md)规定任务计划、指纹与最终用户编辑后的补映射。

Host 复用 `@deepseek-ai/dsh-subagent` 的 `spawn` Provider，在可配置并发上限内为每个任务启动 fresh-context Child Session。Child 以 Section Blueprint 和由其引用派生的 Requirement、Scoring、Response Point、Compliance 为首要上下文，只获得 Host 已预检的 `reference`/`reference_bid` 绝对路径，直接返回 `section_mappings` 与目录深化建议。工具限制为 `grep`、`read`、`web_search`、`web_fetch`，深度上限为 1；招标文件与人工框架不能作为 Evidence。模型输出问题在同一可继续 Child 的后续轮次有限修复；基础设施错误立即失败，已接受的兄弟结果保持不变。

Host 汇总所有 Child 的 Web Tool 结果，沿用来源账本与有界快照机制持久化公开资料。只有同一 Child 先搜索得到 URL、再成功抓取该 URL 的非空正文，才能形成来源记录。局部结果按唯一 Section ID 汇总；本地资料按 `source_kind + file_id + chunk id` 去重，公开资料由临时 URL 绑定为 Host 保存的 `source_id + snapshot_path`。首轮 Evidence Map 完成后，Main Agent 基于证据深化一次目录；Host 保留现有 ID，为新节点分配稳定 `SEC-*`，并只对新增或语义变化的可写 Section 运行一批补充 Mapping Task，最终只保存深化目录中的可写 Section。

本地证据身份由 `source_kind + file_id + chunk id` 决定。模型只提交 `chunk_XXXX`，Validator 根据 `file_id` 对应 manifest 文件的 chunk index 解析规范路径；不存在的 chunk、角色不一致、普通资料使用复用权限、招标文件或人工框架引用都失败。

`evidenceMappingMaxConcurrency` 默认 3，可配置为 1–8。内部计划和执行日志不属于正式阶段 Artifact；重试 S4 会清除旧计划、执行日志、Evidence Map、来源账本和快照。

执行日志按 Mapping Task 持久化 `pending`、`running`、`completed` 和 `failed` 状态。S4 运行期间，`bid/getEvidenceMappingProgress` 只将初始与补充任务数、总数、已完成、映射中、未开始和失败数返回给主 Agent 页面；页面以一秒间隔刷新，不读取计划、日志、文件路径或 Child 结果。

## Alternatives considered

**继续由主 Agent 串行完成全部检索。** 不采用，因为任务天然可独立执行，串行方案不能隔离上下文，也会让局部修复重复消耗已完成工作。

**把任务写成文件并让 Child 自行发现。** 不采用，因为 Subagent 请求已经提供结构化任务、工具过滤、输出 Schema 和生命周期管理，不需要增加一套文件队列协议。

**按 Requirement、Scoring、文件角色或固定技术分类拆任务。** 不采用，因为 Section 已汇聚当前项目的写作目标和业务引用；按其他维度拆分会要求 Host 再投影回 Section，并可能遗漏跨领域关系。

**继续用 chunk 路径字符串识别本地证据。** 不采用，因为路径是表示方式，不是稳定身份；manifest 与 chunk index 已拥有文件和分块的权威关系。

**把人工框架正文建成 Evidence Mapping。** 不采用，因为框架不提供当前项目事实；命中正文由 S5 作为独立写作输入读取。

**根据模型提交的 URL 事后补抓。** 不采用，因为二次请求可能变化或失败，也不能证明保存内容就是 Child 当时读取的正文。

## Consequences

S4 执行依赖支持 fresh continuable spawn、深度限制、工具过滤和 persona 的 Subagent Provider；缺失能力会在任务开始前明确失败。并发 Child 的完成顺序不影响最终合并顺序，单个 Child 的模型输出问题只消耗该任务的修复额度，基础设施异常不消耗修复额度。目录深化新增一次 Main Agent 编写和复核，以及至多一批面向变化 Section 的补充研究。

来源闭环现在覆盖所有 Child Session，证明公开 URL 来自相应 Child 的搜索并在同一运行中成功抓取，且保存内容与模型可见文本一致。它仍不证明网页内容或 Agent 摘要在语义上真实，企业事实仍必须来自本地资料。通用 HTTP Fetch Provider 不阻止私网、回环、链路本地目标或 DNS 重绑定，部署仍需隔离 Harness 可访问的敏感内部网络。

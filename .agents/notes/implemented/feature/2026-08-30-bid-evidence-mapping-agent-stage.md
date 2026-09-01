# Agent Note: Bid 技术资料映射采用主 Agent 规划与并行 Subagent

Status: implemented

## Problem

S3 需要同时理解整个项目、覆盖全部技术 Requirement、Scoring 与 Response Point，并在本地分块和公开技术资料中寻找可用于后续写作的依据。把全局分析、逐项检索和最终汇总都交给同一个 Agent 串行执行，会让上下文持续膨胀，互不依赖的研究任务不能并发，局部失败还会重跑已经完成的工作。

原 Validator 还把人工框架标题误当成必须逐项覆盖的业务要求，并把调用方提交的 chunk 路径字符串当成本地证据身份。这会强迫 Agent 为无关标题制造 mapping，也会让同一分块因绝对路径、相对路径或路径分隔符不同而被误判。

## Decision

S3 保留现有 `evidence_mapping` 阶段、正式 Artifact 和 Orchestrator 推进方式。主 Agent 只读取 manifest 与 S2 Artifact，完成全局分析，并把工作按业务主题动态拆成内部 Mapping Task；Host 校验每个 Requirement、Scoring 和 Response Point 都至少分配给一个任务，任务之间允许共享研究主题，不按文件角色或固定技术分类拆分。

Host 复用 `@deepseek-ai/dsh-subagent` 的 `spawn` Provider，在可配置并发上限内为每个任务启动 fresh-context Child Session。Child 只获得当前任务的 S2 切片、资料定位和全局来源策略提示，工具限制为 `grep`、`read`、`web_search`、`web_fetch`，深度上限为 1，并通过 `outputSchema` 返回局部 Evidence Mapping。Host 校验任务 ID 覆盖、本地引用和该 Child 的 search-to-fetch 结果；失败修复使用新的 Child，只重跑失败任务，已接受的兄弟结果保持不变。每次运行都显式 dispose。

Host 汇总所有 Child 的 Web Tool 结果，沿用来源账本与有界快照机制持久化公开资料。局部结果按稳定业务 ID 合并；本地资料按 `file_id + chunk id + 行号范围` 去重，公开资料按规范化 URL 去重，同一人工框架或旧标书标题按 `file_id + source_section_id` 去重并报告冲突。主 Agent 只接收计划、去重后的结构化结论和必要资料概况，负责冲突分析与正式 `analysis/evidence-map.json` 写入。

本地证据身份由 `file_id + chunk id` 决定。Validator 根据 manifest 文件的 chunk index 解析规范路径并在该文件上校验行号，提交值中的绝对路径、相对路径和路径分隔符不参与身份判断；不存在的 chunk id 或属于另一文件的 chunk id 仍然失败。人工框架标题允许 0 或 1 个 mapping，同一 `file_id + source_section_id` 的重复 mapping 失败，不要求所有标题都出现。

`evidenceMappingMaxConcurrency` 默认 3，可配置为 1–8。内部计划和执行日志不属于正式阶段 Artifact；重试 S3 会清除旧计划、执行日志、Evidence Map、来源账本和快照。

## Alternatives considered

**继续由主 Agent 串行完成全部检索。** 不采用，因为任务天然可独立执行，串行方案不能隔离上下文，也会让局部修复重复消耗已完成工作。

**把任务写成文件并让 Child 自行发现。** 不采用，因为 Subagent 请求已经提供结构化任务、工具过滤、输出 Schema 和生命周期管理，不需要增加一套文件队列协议。

**按文件角色或固定技术分类拆任务。** 不采用，因为拆分应由当前项目的 Requirement、Scoring、Response Point 和研究主题决定，固定分类会遗漏跨领域关系或产生无效任务。

**继续用 chunk 路径字符串识别本地证据。** 不采用，因为路径是表示方式，不是稳定身份；manifest 与 chunk index 已拥有文件和分块的权威关系。

**要求人工框架所有标题都建立 mapping。** 不采用，因为框架只是可选择复用的写作结构，无关标题不应进入当前技术标。

## Consequences

S3 的阶段和正式输出保持不变，但执行依赖支持 fresh spawn、`outputSchema`、深度限制、工具过滤和 persona 的 Subagent Provider；缺失能力会在任务开始前明确失败。并发 Child 的完成顺序不影响最终合并顺序，单个 Child 的失败只消耗该任务的修复额度。

来源闭环现在覆盖所有 Child Session，证明公开 URL 来自相应 Child 的搜索并在同一运行中成功抓取，且保存内容与模型可见文本一致。它仍不证明网页内容或 Agent 摘要在语义上真实，企业事实仍必须来自本地资料。

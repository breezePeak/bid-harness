# Agent Note: S3 Host 确定性合并

Status: implemented

## Problem

S3 Evidence Map 要求模型同时完成资料语义判断、文件与分块引用维护、源章节元数据抄写和最终 Artifact 重组。Validator 再把模型提交的路径、行号、标题、层级、顺序和标题路径与 Workspace 中的权威数据逐项比较，确定性差异会触发最多三轮全阶段模型修复。框架和旧标书标题不是必须覆盖的业务主键，却可能因为辅助结构缺少 mapping 阻断阶段。

## Decision

Evidence Map schema v6 的本地资料只保存 `file_id`、精确 `chunk_XXXX`、`usage` 和 `summary`。`file_id` 必须参与身份判断，因为每个文件的分块编号都从 `chunk_0001` 开始；Host 通过该文件自己的 chunk index 解析规范路径、验证归属、角色、解析状态和链接路径安全。Chunk 是 S3 的最小引用单位，Artifact 不保存模型填写的行号。

框架和旧标书 mapping 保存 Host 生成的 `mapping_id`、`file_id + source_section_id`、语义动作、业务关联、写作维度、资料和缺口，不复制源章节的标题、层级、顺序或标题路径。Validator 要求一个源标题最多出现一次，但不要求每个标题都出现。S6 在读取正文前从原始 structure Artifact 或 chunk index 解析章节元数据。

Mapping Child 继续返回其负责的 Requirement、Scoring、Response Point、Research Topic 与特殊资料语义映射。失败的严格 Schema、任务覆盖、本地引用或 Web 来源校验只重跑该 Mapping Task。所有 Child 通过后，Host 按业务 ID、`file_id + chunk id`、规范化 URL 和 `file_id + source_section_id` 去重，生成来源策略与 Mapping ID，直接写入 Evidence Map 并运行最终 Validator。S3 不再调用主 Agent 合并完整 Artifact，也没有全阶段模型 Repair。

Requirement、Scoring 与 Response Point 保持完整业务主键覆盖；空 `materials` 配合真实 `missing_topics` 是合法 Evidence Gap。`research_topics`、Scoring mapping 和 Response Point mapping 仍由模型生成，因为 S4 与 S6 分别消费其研究结论、写作维度和稳定业务关联。Web Search、Fetch、来源账本、快照与哈希验证保持不变。

## Alternatives considered

**只放宽 Validator，保留模型抄写字段。** 不采用，因为无权威性的重复字段仍占用输出 Token，并持续制造两份数据漂移。

**把 chunk id 改成全局唯一。** 不采用，因为 `file_id + chunk id` 已能无歧义解析，修改 S1 分块格式会扩大迁移和测试范围。

**保留一次全阶段模型 Repair。** 不采用，因为最终 Artifact 完全由 Host 从已校验局部结果生成；确定性错误应由程序处理，语义遗漏应重跑所属 Mapping Task。

**删除 Scoring 或 Response Point mapping。** 不采用，因为当前 S4 与 S6 对两类稳定标识都有真实消费者；本次不改变后续写作策略。

## Consequences

S3 的模型输出和最终校验只包含语义关系与不可推导摘要，确定性文件、分块和章节元数据由 Host 负责。旧版 Evidence Map 不兼容 v6，旧 Session 必须重跑 S3。完整 Chunk 会作为 S6 的最小本地正文输入；如需行级引用，应新增 Host 计算机制，而不是恢复模型填写行号。

同一源标题出现不同语义动作时，Host 合并结果以稳定任务顺序保留首个动作，并在内存结果中列出冲突；当前 Artifact 不暴露冲突字段。需要基于冲突执行定向复核时，应扩展任务归属日志，而不是恢复全阶段重写。

# Agent Note: S3 Host 确定性合并

Status: implemented

## Problem

S3 Evidence Map 要求模型同时完成资料语义判断、文件与分块引用维护、源章节元数据抄写和最终 Artifact 重组。Validator 再把模型提交的路径、行号、标题、层级、顺序和标题路径与 Workspace 中的权威数据逐项比较，确定性差异会触发最多三轮全阶段模型修复。框架和旧标书标题不是必须覆盖的业务主键，却可能因为辅助结构缺少 mapping 阻断阶段。

## Decision

Evidence Map schema v7 的本地资料只保存 `source_kind`、`file_id`、精确 `chunk_XXXX`、`usage` 和 `summary`。`file_id` 必须参与身份判断，因为每个文件的分块编号都从 `chunk_0001` 开始；Host 通过该文件自己的 chunk index 解析规范路径、验证归属、角色、解析状态和链接路径安全。Chunk 是 S3 的最小引用单位，Artifact 不保存模型填写的行号。

人工框架不进入 Evidence Map；旧标书与普通资料都以本地资料记录，`source_kind` 决定 usage 权限。普通 `reference` 只能用于技术参考和背景，`reference_bid` 还可复用或适配正文。[文件角色分离的数据流](../architecture/2026-09-02-bid-role-separated-evidence-flow.md)说明 S4 直接消费框架、S6 只消费确认目录和真实资料身份的职责。

Mapping Child 只返回其负责的 Requirement、Scoring、Response Point 和 Research Topic 资料。失败的严格 Schema、任务覆盖、本地引用或 Web 来源校验只修复该 Mapping Task。所有 Child 通过后，Host 按业务 ID、`file_id + chunk id` 和实际 Web Snapshot 去重，绑定 `source_id + snapshot_path`，直接写入 Evidence Map 并运行最终 Validator。S3 不调用主 Agent 合并完整 Artifact，也没有全阶段模型 Repair。

Requirement、Scoring 与 Response Point 保持完整业务主键覆盖；空 `local_materials`、空 `web_materials` 配合真实 `missing_topics` 是合法 Evidence Gap。`research_topics`、Scoring mapping 和 Response Point mapping 仍由模型生成，因为 S4 与 S6 分别消费其研究结论、写作维度和稳定业务关联。Host 只持久化最终 Evidence Map 实际引用的 Web Snapshot，并以来源账本和正文哈希验证。

## Alternatives considered

**只放宽 Validator，保留来源章节和 URL 字段。** 不采用，因为无权威性的重复字段仍占用输出 Token，并持续制造两份数据漂移；框架不属于 Evidence，URL 也不是后续正文。

**把 chunk id 改成全局唯一。** 不采用，因为 `file_id + chunk id` 已能无歧义解析，修改 S1 分块格式会扩大迁移和测试范围。

**保留一次全阶段模型 Repair。** 不采用，因为最终 Artifact 完全由 Host 从已校验局部结果生成；确定性错误应由程序处理，语义遗漏应重跑所属 Mapping Task。

**删除 Scoring 或 Response Point mapping。** 不采用，因为当前 S4 与 S6 对两类稳定标识都有真实消费者；本次不改变后续写作策略。

## Consequences

S3 的模型输出和最终校验只包含语义关系与不可推导摘要，确定性文件、分块和章节元数据由 Host 负责。旧版 Evidence Map 不兼容 v6，旧 Session 必须重跑 S3。完整 Chunk 会作为 S6 的最小本地正文输入；如需行级引用，应新增 Host 计算机制，而不是恢复模型填写行号。

同一业务项被多个任务研究时，Host 以稳定任务顺序合并资料和写作维度；资料按真实本地或 Web 身份去重。需要基于语义冲突执行定向复核时，应扩展任务归属日志，而不是恢复全阶段重写。

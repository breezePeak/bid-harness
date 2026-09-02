# Agent Note: Bid 六阶段角色分离的数据流

Status: implemented

## Problem

原八阶段流程把评分响应点放在 S2、把目录确认和整本审核设为独立阶段，导致 Artifact 所有权与用户工作流错位。资料映射按 Requirement、Scoring 和 Topic 存储，章节写作还要重新拼装为 Section 上下文；正文必须等 Reviewer 通过后才可见，审查问题也会阻断全书完成。

## Decision

固定流程改为六阶段：S1 文件接入、S2 招标分析、S3 目录生成、S4 证据映射、S5 章节写作、S6 DOCX 导出。目录确认分别内置在 S3 初稿和 S4 最终目录；每章 Reviewer 内置在 S5，不再存在 `outline_confirmation` 与 `book_review` 阶段。

S2 只保存 Project、Requirements、完整 Scoring 原文和 Compliance，不包含响应点。S3 由 Agent 按评分语义生成候选响应点，再以独立语义复核检查完整场景；Host 按评分 Artifact 哈希和单调序列分配稳定 `RP-*` ID。Agent 按主框架、补充框架和无关框架适配人工目录，并在 Section 上保存精确标题路径引用；同一响应点可以覆盖多个可写 Section。S3 校验通过后保存 `outline/initial-confirmed-outline.json`，用户可在同阶段编辑、重新生成或确认。

S4 的计划和 Child 输入以可写 Section 为单位，Child 直接返回 Section Evidence 和目录深化建议，不产生 Requirement、Scoring 或 Response Point 中间映射。首轮映射后，Main Agent 基于证据只深化一次目录；Host 保留现有 Section ID，为新增节点分配稳定 `SEC-*`，并只对新增或语义变化的可写 Section 运行一批补充映射。Evidence Map schema v8 以最终 `section_mappings` 为唯一业务索引。每个可写 Section 恰好一条记录，包含本地材料、Web Snapshot、缺口和写作维度。本地资料保存 `source_kind + file_id + chunk`；普通 `reference` 只允许 `reference` 或 `background`，旧标书 `reference_bid` 还允许 `reuse` 与 `adapt`。Mapping Child 可以返回临时 URL，Host 只把当前 search-to-fetch 结果绑定为 `source_id + snapshot_path` 后写入最终 Evidence Map，并以来源账本和正文哈希验证本地 Snapshot。S4 提供最终目录确认。

S5 只认 `confirmed-outline.json` 的章节结构，并按 Section 直接读取 Evidence Map。Host 按 Section 的框架引用解析精确正文分块，把它作为可保留、适配或改写的写作输入注入 Writer，但不把它视为当前项目事实 Evidence。Writer 候选通过确定性检查后立即持久化正文与 Metadata，随后启动独立 Reviewer。Reviewer 要求修复时最多再启动一次 Writer；第二次审查仍有明确问题则保存报告并投影为 `needs_attention`，不阻断后续章节或 S6 导出。

本记录取代各功能记录中的八阶段编号、S2 响应点所有权、独立目录确认阶段、Requirement/Scoring Evidence Map 和独立整本审核阶段；这些记录保留各自仍有效的文件角色、目录编辑、并发调度和来源安全细节。

## Alternatives considered

**保留旧字段并增加新字段。** 不采用，因为当前没有外部消费者，双路由会让每个阶段继续判断旧来源 Mapping 与真实资料引用何者权威，并延长错误格式的生命周期。

**把人工框架正文视为事实 Evidence。** 不采用，因为框架可以提供目录骨架和用户已有写作内容，但不能证明当前项目事实；S5 把精确命中的框架分块作为独立写作输入。

**让旧标书保留独立目录 Mapping。** 不采用，因为旧标书的差异是允许复用与适配正文，而不是拥有目录结构优先级；`source_kind` 与 usage 已完整表达该权限。

**用固定 Requirement 或 Scoring 数量限制章节粒度。** 不采用，因为数量不能判断多个 ID 是否属于同一技术主题；强制 Blueprint Quality Review 负责语义拆分，Host 只保留可确定验证的关系。

**在后续阶段重新抓取 URL。** 不采用，因为网页可能变化或不可用，也不能证明新响应等于 Mapping Child 看到的内容；Host 保存的 Snapshot 是后续唯一正文来源。

## Consequences

只有 tender、没有框架、没有本地资料的 Session 也能生成目录并以缺口记录完成 S4。旧八阶段 Session、含 S2 `response_points` 的 Scoring、Evidence v7 以及整本审核 Artifact 不兼容；受影响项目从 S2 重新生成，不保留兼容解析。

Validator 证明文件角色、分块归属、Workspace 路径、框架标题引用、Section 覆盖、来源账本和 Snapshot 哈希，但不判断 Agent 的资料选择、目录拆分或正文改写质量。S3 语义复核与 Quality Review、S4 单次目录深化和 S5 Reviewer 分别承担对应的模型判断。

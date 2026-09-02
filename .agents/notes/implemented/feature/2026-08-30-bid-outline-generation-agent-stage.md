# Agent Note: Bid 通过实时 Agent 生成技术标写作蓝图

Status: implemented

## Problem

招标要求、评分项、合规规则和已映射资料本身不能告诉后续章节写作 Agent 应该如何组织可独立编写的技术主题。人工框架存在与否还会改变目录起点，但不能改变当前招标要求的优先级。

## Decision

Bid Host 将 `outline_generation` 注册为 S3 自动 Agent 阶段。Agent 先产生候选评分响应点，再以独立语义复核检查完整评分场景；Host 随后分配稳定 `RP-*`。存在成功解析的 `outline_framework` 时，Host 把 manifest 顺序下的标题树注入任务，Agent 明确选择主框架、补充框架和无关框架，并按保留、扩展、调整或排除适配；没有框架时按评分响应点、评分项、Requirements 和 Compliance 自主生成完整目录。

严格 Outline Artifact 使用扁平父子树。每个 Section 具有稳定 id、parent_id、同级 order、level、purpose、是否写作、Requirement/Scoring/Compliance/Response Point 引用、结构来源、精确 `framework_refs` 和写作指引。`origin` 只取 `framework`、`generated` 或 `mixed`；结构节点必须有子节点，可写节点必须是叶子并具有具体 `must_answer`。

同一 Agent 在初稿后执行 Blueprint Quality Review，按评分语义修正过粗或缺失的技术主题，并写入质量报告。Host 只确定性校验树结构、引用存在性与覆盖、数组重复、精确框架标题引用、强制 Requirement 和重点 Scoring 的可写覆盖及质量报告集合；同一 Response Point 可以出现在多个可写 Section，`issues` 可保存非阻断建议。成功后由 S3 等待首次用户确认。

## Alternatives considered

**使用嵌套目录文档。** 不采用，因为 parent_id 和同级 order 让后续编辑、遍历和编号不依赖保存的章节号。

**把 S3 资料复制到每个 Section。** 不采用，因为重复资料引用会与 Evidence Map 漂移；目录只保存业务覆盖和写作指引。

**每个评分项生成一个标题。** 不采用，因为粗粒度评分项可能包含架构、功能、实施、安全和运维等多个独立技术主题。

**用固定 Requirement/Scoring 数量限制可写叶子。** 不采用，因为数量不能表达技术语义；强制 Quality Review 负责拆分判断，Host 保留可确定验证的关系。

## Consequences

S3 在人工确认前执行响应点生成、独立语义复核、目录生成和质量复核。语义质量由 Prompt、复核和场景测试约束；Validator 限于结构、引用、覆盖和报告一致性。人工框架缺失不阻断 S3；命中的框架正文通过 `framework_refs` 进入 S5 写作上下文，但不作为事实 Evidence。

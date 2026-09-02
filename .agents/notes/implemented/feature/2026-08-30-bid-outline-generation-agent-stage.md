# Agent Note: Bid 通过实时 Agent 生成技术标写作蓝图

Status: implemented

## Problem

招标要求、评分项、合规规则和已映射资料本身不能告诉后续章节写作 Agent 应该如何组织可独立编写的技术主题。人工框架存在与否还会改变目录起点，但不能改变当前招标要求的优先级。

## Decision

Bid Host 将 `outline_generation` 注册为自动 Agent 阶段。Host 读取 manifest；存在成功解析的 `outline_framework` 时，把原始结构或从 chunk 标题恢复的层级直接注入任务，Agent 以人工层级、顺序和标题意图为优先骨架，再用 S2 要求、评分响应点和 S3 资料扩充。没有框架时，Agent 以评分响应点和评分项为主要拆分依据自主生成完整目录，再用 Requirements、Compliance 和 S3 主题补充。[文件角色分离的数据流](../architecture/2026-09-02-bid-role-separated-evidence-flow.md)说明框架为何不进入 Evidence Map。

严格 Outline Artifact 使用扁平父子树。每个 Section 具有稳定 id、parent_id、同级 order、level、purpose、是否写作、Requirement/Scoring/Compliance/Response Point 引用、结构来源和写作指引。`origin` 只取 `framework`、`generated` 或 `mixed`，不承载 Evidence ID；结构节点必须有子节点，可写节点必须是叶子并具有具体 `must_answer`。

同一 Agent 在初稿后执行强制 Blueprint Quality Review，按评分语义修正过粗或缺失的技术主题，并写入质量报告。Host 只确定性校验树结构、引用存在性与覆盖、数组重复、Response Point 唯一归属、强制 Requirement 和重点 Scoring 的可写覆盖，以及质量报告集合和空问题列表；不以每章固定 ID 数量或标题关键词代替语义判断。成功后进入 `outline_confirmation/waiting_user`。

## Alternatives considered

**使用嵌套目录文档。** 不采用，因为 parent_id 和同级 order 让后续编辑、遍历和编号不依赖保存的章节号。

**把 S3 资料复制到每个 Section。** 不采用，因为重复资料引用会与 Evidence Map 漂移；目录只保存业务覆盖和写作指引。

**每个评分项生成一个标题。** 不采用，因为粗粒度评分项可能包含架构、功能、实施、安全和运维等多个独立技术主题。

**用固定 Requirement/Scoring 数量限制可写叶子。** 不采用，因为数量不能表达技术语义；强制 Quality Review 负责拆分判断，Host 保留可确定验证的关系。

## Consequences

S4 在人工确认前增加初稿和强制复核两个 Agent 回合。语义质量由 Prompt、质量复核和场景测试约束；Validator 限于结构、引用、覆盖和报告一致性。人工框架缺失不阻断 S4，框架完成目录生成后也不进入 S5/S6。

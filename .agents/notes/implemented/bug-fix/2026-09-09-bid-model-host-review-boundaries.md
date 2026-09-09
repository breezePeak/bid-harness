# Agent Note: Bid 模型与 Host 复核直连边界

Status: implemented

## Problem

S2 的确定性提交协议只能证明引用和结构合法，不能证明模型在发布前重新检查过全部 staged 记录；一次初始抽取中的相邻行串配仍可直接落盘。S3 质量复核让模型写候选 JSON，又把 Host 可确定的版本、检查集合和文件格式交回模型，格式错误会占用目录修复预算并掩盖真实复核结果。

## Decision

S2 首次通过确定性校验的 finish 进入 `review_required`，只返回 staged revision，不持久化。执行器在同一 live Agent 的新轮次中注入完整 staged snapshot 和 tender locators，要求逐条重读来源并检查 Project、Requirement、Scoring、Compliance 的语义、边界和相邻记录串配。复核可继续用 runtime ref 覆盖记录；每次接受提交都递增 revision。只有 `reviewing` 阶段携带当前 `review_revision` 的 finish 才发布，旧 revision、初始轮重复 finish 和普通文字都不能完成。该强制轮次不占用原有缺项续修预算。

S3 Blueprint Quality Review 动态注册 `submit_outline_quality_review`，只接受 `issues=[{code,severity:"advisory",message}]`。参数错误作为工具参数错误留在当前模型轮次修正；未提交时只允许一次受预算约束的继续提交。若复核修改目录，Host 丢弃该次 issues 并要求对新目录重新完整复核。成功后 Host 为当前目录生成 schema version 4、scope、全部 checked IDs 和 reviewed section IDs，再写入正式质量报告；不存在兼容旧格式或候选文件的读取路径。

这项修复补充[S2 Host 提交协议](../architecture/2026-09-07-bid-s2-host-owned-submission-protocol.md)，并替换[S3 响应点续修](2026-09-07-bid-outline-response-point-recovery.md)中模型写质量候选的边界。两份原记录的稳定身份、局部修复和来源规则仍然有效，因此保留并互链。

## Alternatives considered

**按标题、来源或分值在 Host 中检测错配。** 不采用；这些字段没有跨招标文件成立的确定性关系，启发式既会漏掉语义错误，也会误改合法重复项。Host 只维护版本和身份边界，内容正确性由模型复核。

**复用初始 S2 轮次中的 finish 作为语义确认。** 不采用；同一轮次没有独立重读全部 staged 记录的任务，也不能区分抽取完成与复核完成。

**继续让 S3 写候选质量 JSON，再增加格式修复。** 不采用；版本、检查集合和正式格式均由 Host 已知，新增文件与修复路径没有提供额外语义信息。

**为复核启动新的 Agent。** 不采用；同一 live Agent 已持有当前会话和 staged runtime refs，另一个 Agent 会扩大身份、工具授权和交接面。

## Consequences

S2 正常完成固定增加一个模型轮次，复核中任何改动都会使旧 revision 失效；换来的是所有正式 Artifact 都有同一执行期、同一 Agent 对最新完整 staged 内容的明确确认。S3 删除质量候选及其解析修复面，正式报告升级到版本 4 且旧磁盘格式被拒绝。Host 仍不判断标题、来源、分值或行位置之间的语义关系；无密钥回放证明轮次、版本、工具和持久化边界，不替代真实模型质量评估。

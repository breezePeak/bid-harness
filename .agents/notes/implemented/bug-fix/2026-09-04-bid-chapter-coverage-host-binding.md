# Agent Note: Bid 章节覆盖索引由 Host 绑定

Status: implemented

## Problem

S5 Writer 必须把确认目录中的 `must_answer`、评分响应点 ID 和评分响应点文本原样复制到章节 Metadata。正文修订即使解决了 Reviewer 的问题，只要模型把一个句号从中文标点改为英文标点，严格相等校验就会拒绝候选并使整个正文阶段失败。三个字段是确认目录的确定性索引，不是 Writer 产生的新事实；让模型负责复制会把无业务意义的文本差异变成阶段级故障。

## Decision

Host 在章节候选通过结构化 Schema 解析后，从当前确认目录 Section 绑定 `covered_must_answer`、`covered_scoring_response_point_ids` 和 `covered_scoring_response_points`，并以绑定后的值生成正式 Metadata。Writer 返回的同名字段只满足统一输出 Schema，不作为正式索引的来源。

正文覆盖仍由独立 Reviewer 按当前 Section 的必答项、需求、评分响应点和合规项逐项检查。缺项会触发正文修订或形成 `needs_attention`，因此 Host 绑定索引不会把未覆盖正文标记为已通过。该决定补充[章节写作由 Host 调度独立 Subagent](2026-09-01-s6-subagent-chapter-scheduling.md)中的 Host 提交职责，原记录仍保留其并发、隔离和失败处理决策。

## Alternatives considered

**继续依靠提示词要求精确复制。** 修订 Child 已收到完整 Blueprint 和精确值，仍可能产生标点或空白差异；增加强调不能消除这种随机故障。

**对文本做标点和空白归一化后比较。** 归一化规则会逐步扩张，并可能把真正不同的必答项合并。Host 已拥有权威 Section，直接绑定更明确。

**从章节 Metadata 删除覆盖索引。** S6 清单校验和后续审计需要这些稳定索引；删除会降低产物可追溯性。

## Consequences

章节 Metadata 的三个覆盖索引始终与确认目录一致，模型的复制差异不再消耗修订次数或中止正文阶段。Writer 对覆盖范围的自报不再具有准入意义，实际正文是否覆盖仍以独立 Reviewer 的逐项结果为准。相关组件测试固定 Host 绑定行为，并保留 Reviewer 缺项触发修订的覆盖。

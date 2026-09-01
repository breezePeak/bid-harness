# Agent Note: Bid 目录确认的叶子粒度校验

Status: implemented

## Problem

可写章节的 Requirement 和 Scoring 映射数量不属于目录结构或引用覆盖的正确性条件。数量上限会让目录生成和确认拒绝仍能完整表达招标要求的目录。

## Decision

S4 和 S5 都不限制单个可写章节关联的 Requirement 或 Scoring 数量。两阶段继续校验目录树、映射 ID 的存在性和唯一性，以及 Requirement、Scoring 和 Compliance 的完整覆盖。

## Alternatives considered

**保留 S4 的数量上限。** 不采用，因为映射数量不能证明章节是否适合写作，并会拒绝完整有效的目录。

**只在 S5 移除数量上限。** 不采用，因为同一限制仍会使 S4 自动目录生成失败。

## Consequences

目录生成和确认可接受任意数量的有效映射；章节的可写性、目录树和完整覆盖仍由验证器保证。

# Agent Note: 目录复核问题类别由程序填写

Status: implemented

## Problem

S3 与 S4 目录复核要求模型自行命名问题代码并满足大写格式。自由命名没有稳定分类语义，却会因纯格式错误消耗复核次数；它也违背模型不得生成标识符的要求。

## Decision

目录复核模型只返回业务内容。非阻断建议包含 severity 与 message，S4 阻断问题包含已有 section_id 与 reason；两处接收校验均拒绝模型提交 code。程序为建议填写固定类别 `OUTLINE_QUALITY_ADVISORY`，为阻断问题填写 `OUTLINE_STRUCTURE_REVIEW`。这些值是诊断类别，不是每条问题的唯一 ID。

[S3 有界恢复](2026-09-21-s3-bounded-outline-generation-recovery.md)的重试与恢复机制，以及[S4 主题归位](2026-09-11-s4-topic-disposition-outline-lock.md)的局部修复机制继续适用。问题类别归属不增加阶段或新的重试预算。

## Alternatives considered

**继续补充大写格式提示或转换模型代码。** 格式正确仍不能赋予自由命名稳定含义，且仍由模型创造程序字段。

**让模型选择固定代码枚举。** 当前修复只依赖章节定位和业务理由，没有按细分问题类别分派的消费者；程序可依据建议与阻断问题所在字段直接确定类别。

## Consequences

模型承担语义复核，程序承担诊断类别。中文业务说明与既有章节引用完整保留；代码格式不再成为模型的任务。严格输入校验、定向执行器测试和真实 Loader 回放覆盖模型代码拒绝及程序类别写入。

# Agent Note: S2 原文锚点定位协议

Status: implemented

## Problem

S2 允许模型提交语义描述，再由 Host 按字符组重合度选择原文行。模型与程序共同猜测同一个精确位置，导致未命中、并列候选和错误引用都不能由提交参数确定地解释。

## Decision

S2 source 使用 `file_ref`、`chunk` 和 `anchor_text`。模型先完成 Requirement、Scoring 或 Compliance 的语义判断，并从已经读取的指定 chunk 正文逐字复制一段连续原文；Host 验证文件与 chunk 归属，且只以 NFKC 及换行/连续空白归一化做精确唯一匹配。Host 从原始正文回映 quote、`raw_text`、`source_refs`、行号和正式 Artifact。

未命中返回 `TENDER_ANALYSIS_ANCHOR_NOT_FOUND`，多次命中返回 `TENDER_ANALYSIS_ANCHOR_AMBIGUOUS`。两者保留 staged state 和 revision、结束当前内部 Turn，并分别要求重新读取该 chunk 后复制原文或提交更长的锚点。一个 source 只代表一个可唯一定位的锚点；跨行或跨 chunk 内容使用多个 source。模型仍不能提交 quote、`raw_text`、文件 ID、来源引用或行号。

本记录修正 [S2 Host 提交协议](../architecture/2026-09-07-bid-s2-host-owned-submission-protocol.md)中的旧定位机制；文件身份、chunk 归属和正式 Artifact 继续由 Host 持有。

## Alternatives considered

**调整相似度阈值。** 不采用；阈值不能让语义描述成为原文位置，也不能消除多个候选之间的猜测。

**让 Host 选择最相似的一行。** 不采用；选择结果不可由模型提交的实际原文验证，且会把错误引用写入 Artifact。

**让模型填写 quote 和行号。** 不采用；这些字段由 Host 从已验证的正文位置确定，模型填写会重复文件身份与位置职责。

## Consequences

模型需要在提交前读取并复制原文，短而重复的锚点会触发一次 Repair。Host 不再使用语义相似度、bigram、embedding 或候选排序定位 S2 正文。回归测试固定唯一回映、未命中与多命中恢复、加长锚点、NFKC/空白回映、三类语义记录共用协议、模型字段拒绝和既有 finish/review/恢复流程。

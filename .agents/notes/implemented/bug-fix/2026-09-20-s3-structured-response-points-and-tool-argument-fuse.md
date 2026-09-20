# Agent Note: S3 结构化响应点与流式参数熔断

Status: implemented

## Problem

S3 响应点分析让模型读取评分 Artifact、序列化完整 JSON 并调用通用 `write`。模型在流式生成长 tool arguments 时可能反复输出同一空白或闭合片段，tool call 始终无法闭合，Child 则持续运行直到上游断线。

## Decision

S3 Host 读取并解析 `analysis/scoring.json`，把完整评分数据直接注入响应点分析 Child。分析与独立语义复核都使用同一份 `scoringResponsePointCandidateSchema` structured output，并设置空工具 allow-list。Host 校验 `schema_version`、非空 `scoring_id`、正整数 `order`、非空 `text`、评分 ID 归属、每项至少一点与从 1 开始的连续顺序。两轮都通过后，Host 使用 Run Commit Scope 将 Candidate 序列化到当前 Run 的 scratch 路径，再沿用现有逻辑分配稳定 `RP-*` 并生成正式清单。任一轮输出非法时不写新 Candidate，也不覆盖已有合法文件。

Agent Loop 在持久化和组装 `tool-call-delta` 前，按 tool-call id 记录已流入字符数、上一个非空片段与连续相同次数。第 128 个连续相同的非空片段抛出 `MODEL_TOOL_ARGUMENT_DEGENERATED`；未闭合 arguments 累计超过 512 KiB 抛出 `MODEL_TOOL_ARGUMENT_TOO_LARGE`。`block-end`、step 结束或 stream 结束都使状态失效。消费方抛错会触发现有异步迭代器 `return()` 清理，等待提供方停止后以当前 step 和 turn 错误收口。两个错误码不在默认重试集合中。

## Alternatives considered

**继续让模型写 Candidate，只缩短 Prompt。** Prompt 不能确保模型正确闭合长 arguments，也会继续把确定性序列化与文件写入交给模型。

**只给 `write` 工具加长度限制。** 退化发生在 tool call 闭合和工具分派之前，工具执行层无法观测或终止它，且其他工具仍会受影响。

**只设置 stream idle timeout。** 重复片段持续到达时 stream 并不 idle，因此不会触发空闲看门狗。

## Consequences

S3 响应点 Child 不再读取或写入文件，Candidate 的字节表示与发布生命周期由 Host 拥有；两轮 structured output 仍保留既有语义分析和独立复核。极端情况下，合法工具参数若包含 128 个连续完全相同的非空流片段或超过 512 KiB，当前模型请求会明确失败；这个有界取舍防止未闭合调用无期占用 Child 与 Host 等待链。

# Agent Note: 从 pi-ai 错误消息识别响应流截断

Status: implemented

## Problem

模型连接在终止事件之前断开时，pi-ai 只传递错误消息，丢弃原始 `Error` 与 `cause`。`terminated`、`stream ended before message_stop` 和 `stream disconnected before completion: stream closed before response.completed` 都表示响应未完成，却可能被适配器归入 `PI_AI_ERROR`。未知错误不在默认重试集合中，误分类会让可恢复断流直接结束回合。

## Decision

`llm-pi-ai` 根据 pi-ai 唯一保留的消息，将明确的网络错误、`terminated`、`Premature close`、`stream ended before/without`、`stream disconnected before completion` 和 `stream closed before response.completed` 归为 `TRANSPORT`。认证、额度和非法请求的分类优先，未知错误继续保留 `PI_AI_ERROR`，不扩大未知错误的重试范围。

分类器保留 `XXX(pi-ai upstream)`，说明 pi-ai 把原异常转换为 `error.message` 的位置。若上游传递原始 code、cause 或允许捕获原异常，应据此分类；当前适配器无法从已经扁平化的文本恢复丢失细节。pi-ai 的 `onResponse` 在响应体消费前调用，无法观测后续断流，现有选项没有可捕获其 cause 的 fetch/dispatcher 接口。

适配器仅返回稳定错误 code，组合中的 `llm-retry` 负责请求级有限重试；业务任务调度复用该分类，见[S4 瞬时基础设施错误恢复](2026-09-12-s4-transient-infrastructure-retry.md)。包 README 记录错误信息丢失和文字分类限制。

## Alternatives considered

**把 `PI_AI_ERROR` 加入默认可重试集合。** 不采用。未知失败包含非法响应和 SDK 程序异常，不能一律作为暂时网络故障。

**包装一个带 cause 的新 `LlmError`。** 不采用。收到的错误已经是扁平字符串，额外包装不能恢复原异常；与 DeepSeek 适配器收到完整 fetch 异常的情况不同。

**为单一错误消息注入各 Provider 的 SDK 客户端。** 不采用。构造并替换 Provider 客户端绕过适配器职责，现有响应回调也不能捕获流消费期间的失败。

## Consequences

明确的终止前断流携带 `TRANSPORT`，默认策略可有限重试，并在会话日志记录 `llm/retry`。原始错误消息保持不变。分类仍依赖 Provider 措辞，因此测试固定真实错误消息和本地 Responses SSE 失败的接受路径；Loader 应用快照验证失败尝试不发布残缺回复、恢复后的回复及最终回合状态。未知措辞仍可能落入 `PI_AI_ERROR`，结构化上游错误是长期修复方向。

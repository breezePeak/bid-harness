# Agent Note: S4 瞬时基础设施错误自动恢复

Status: implemented

## Problem

S4 Mapping Child 的限流、响应流断开、超时或服务端暂时故障可以恢复，但把这些失败直接提升为整个阶段失败，会让用户重启仍有已完成章节的批次。Provider 错误分类与 Mapping Task 重试必须保持一致，未接受的输出不能当作成功结果。

## Decision

S4 Host 根据 Child 最终 `turn/end` 的结构化 code 分类。`RATE_LIMIT` 使用共享 `subagent` Provider 冷却表等待 30 秒；`TRANSPORT`、`TIMEOUT`、`SERVER` 和 `EMPTY_RESPONSE` 使用从 500 毫秒开始、上限 60 秒的有限退避。Web Provider 的 `Retry-After` 优先于基础退避。模型与 Web 错误共用每个 Mapping Task 默认最多两次的基础设施重试预算，独立于同一 Child 内的语义修复预算。

没有结构化 code 时，限流识别仅接受 HTTP 429、`rpm exhausted`、TPM/RPM 上限或 `rate_limit_error`。`AUTH`、`QUOTA`、`NO_ADAPTER`、`INVALID_REQUEST`、`PI_AI_ERROR`、认证、余额和永久额度错误优先终止；未知程序错误、Guard 和持久化异常不进入任务级瞬时重试；真正的 Guard 执行异常记录 EVIDENCE_MAPPING_GUARD_ERROR，并在恢复入口阻断。响应流措辞的识别属于[模型适配器](2026-07-22-pi-ai-transport-truncation-classification.md)，S4 不根据普通消息猜测网络故障。

自动恢复保留失败 attempt，并在单个 Mapping Task 范围内创建新的 Child；受影响任务保持运行态，已接受的兄弟章节与检查点不重跑。Provider 冷却阻止排队任务立即创建 Child；只有模型限流降低后续映射并发，单次网络故障不改变并发上限。取消结束等待并阻止后续尝试。预算耗尽保留原始错误和诊断；明确的瞬时错误在人工恢复入口仍选择重试，不要求模型修复业务内容。

## Alternatives considered

**让用户手动重启每次失败。** 不采用。暂时网络故障和 429 的恢复属于程序调度；人工入口处理自动预算耗尽或不可恢复故障。

**重启整个 S4 批次。** 不采用。已接受章节和仍可运行的兄弟任务无需丢弃，按任务恢复保留检查点并减少重复调用。

**重试所有异常或无限等待。** 不采用。认证、永久额度、非法输入和程序异常不会因重复调用得到修复；有限预算使阶段能够结算为明确失败，并保留原始原因。

## Consequences

程序重建受影响 Child，不接受失败回合中的不完整模型输出。适配器请求级重试与任务级恢复有各自预算，任务预算限制在请求重试耗尽后还可启动多少个 Child。定向测试覆盖瞬时错误后成功、持续错误预算耗尽、已完成兄弟保留、等待中取消，以及永久基础设施错误不得伪装成完成。

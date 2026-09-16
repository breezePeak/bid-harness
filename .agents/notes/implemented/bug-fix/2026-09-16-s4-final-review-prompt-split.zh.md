# Final Review 超长提示拆分

## 状态

已实现。

## 问题

S4 的多 Section Final Review 提示超过预算时，执行器会抛出专用拆分异常。该异常经过 Mapping Subagent 的通用错误处理后被包装成基础设施错误，导致当前 Review Shard 直接失败，无法进入拆分流程。

## 决策

在记录失败日志后保留 `FinalReviewTaskTooLargeError`，由 Final Review 调度器识别任务并按 Section 拆分；其他异常继续沿用现有基础设施错误处理。

## 结果

超预算的 Review Shard 会被替换为较小的任务，失败日志不会保留已被拆分的原任务。

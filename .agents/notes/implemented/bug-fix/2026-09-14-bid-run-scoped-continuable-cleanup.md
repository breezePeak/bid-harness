# Agent Note: Bid 运行仅回收本次 continuable 子代理

Status: implemented

## Problem

Bid 阶段运行失败后需要终止其创建的 continuable 子代理，但主会话仍须能够从项目检查点恢复。

## Decision

`BidHostRuntime` 在每次项目操作中记录直属于该主会话的 Subagent，并在 `BidRunCoordinator` 收敛时仅调用 `drainContinuableChildren` 回收这些已登记的 continuable 子代理。操作结束即解除记录监听。主会话不再调用 `drainContinuableDescendants`，因此恢复运行可以创建新的 Subagent。

## Alternatives considered

**继续关闭主会话的全部后代。** `drainContinuableDescendants` 的关闭状态会持续到主会话销毁，与可在原会话恢复项目检查点的行为冲突。

**不执行子代理清理。** 这会让失败运行的工作继续写入或占用资源，破坏运行收敛。

## Consequences

失败运行仍等待已登记子代理退出，恢复运行使用新的子代理身份。回归测试固定为：阶段失败不调用祖先级清理，而只回收本次运行的登记集合。

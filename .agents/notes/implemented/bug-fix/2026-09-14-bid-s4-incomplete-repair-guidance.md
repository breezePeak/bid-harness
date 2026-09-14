# Agent Note: S4 未完成任务的恢复指引

Status: implemented

## Problem

S4 Child 在尚未锁定目录子树或尚未提交全部章节映射时提前调用完成工具，只收到并列的校验错误。修复轮次需要从长任务提示中重新推导研究、Blueprint、结构判断、锁定和映射的先后关系，容易再次结束并耗尽预算。挂起 Run 的恢复能力仅存在于 Main Agent 工具，阶段栏没有清晰的继续入口。

## Decision

S4 修复轮次根据当前 Host 状态生成有序清单：未完成研究、缺失 Blueprint、旧结构判断、未锁定目录、缺失章节 Mapping、Final Check 总述和待审项依次列出，最后才允许调用完成工具。清单保留既有 Child 状态和工具权限，不替模型编造研究、结构或材料结论。

阶段栏在 Run 挂起时提供“继续未完成任务”。该按钮仅发送明确的继续消息，保持 [Bid Workflow 与 Run 使用统一生命周期](../architecture/2026-09-13-bid-workflow-run-lifecycle.md) 所有权：Main Agent 读取挂起 Run 身份和项目 revision 后调用既有恢复工具，Host 仍执行 CAS 与 checkpoint reconciliation。

## Alternatives considered

**增加独立重试 Remote。** 不采用；它会绕开 Main Agent 的意图判断，并与既有 Run 生命周期形成第二个恢复入口。

**只增加修复次数。** 不采用；缺少下一步状态时，额外轮次只会重复同一未完成调用。

**Host 自动完成锁定或 Mapping。** 不采用；研究结论、目录粒度和资料用途属于模型提交的语义结果，Host 只校验和持久化。

## Consequences

S4 Repair 的模型可见内容包含当前状态派生的工具顺序，提前完成能够在同一 Child 中回到锁定和提交路径。用户可从阶段栏表达继续意图，但恢复仍复用同一安全边界和已完成任务 checkpoint。回归测试固定未锁定、缺少 Mapping 时的修复清单和阶段栏继续消息。

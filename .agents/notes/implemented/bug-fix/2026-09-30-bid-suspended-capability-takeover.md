# Agent Note: 挂起能力任务由新的用户目标接管

Status: implemented

## Problem

旧 `capability_task` 因内部故障挂起后，新的用户目录修改目标不能创建独立 Work。`bid_run_task` 被当前 `suspended` 状态拒绝，恢复入口却只会续行旧目标。`bid_project_inspect` 的模型参数和 Host 严格解析不一致，接纳回执还容易被误读成执行完成。

## Decision

同一目标的修复沿用[能力任务重规划](2026-09-29-bid-capability-replanning.md)的检查点、计划补丁和恢复入口。新用户目标由 `bid_run_task.supersede` 指明旧 Run ID 与权威项目 revision；Host 在项目锁内核对当前挂起 Work、真实新用户消息、阶段和原因，读取旧请求的稳定 `return_state`，再保存新请求并启动不带 `resumeOf` 的 Run。接管只在新 Run 的控制状态落盘后留下旧 Run 的停止通知；旧请求、步骤凭据、检查点和候选均保留。`awaiting_input` 继续等待原生问题，其他 Work 的挂起状态不开放此入口。

模型工具参数从与执行入口共用的 Zod 输入 Schema 生成，严格联合类型保留各对象的必填字段、默认参数和禁止字段。Host 的接纳、排队和启动回执明确返回 `completed=false`；能力任务只有 Run 完成且正式发布凭据存在才报告 `completed=true`。目录层级与评分点绑定由 `outline.update` 和现有校验器处理，标题是否适合作为方案章节仍由模型按用户目标判断。

## Alternatives considered

**先恢复旧 Work 再开始新目标。** 恢复保留旧目标、根范围和授权，无法把新消息变成新的不可变请求，还可能重复旧失败。

**放宽所有挂起状态或新增替代状态。** 其他 Work 与等待输入各有原生续行规则；精确 Run、revision 和新用户消息足以限定接管，无须扩展全局状态机。

**让模型可见 Schema 保持平铺并在 Host 删除多余字段。** 模型仍会收到错误调用契约，工具层也无法拒绝非法组合；输入 Schema 必须由运行时定义投影。

## Consequences

旧 Work 可供故障分析但不再占用当前控制状态。过期 Run、过期 revision、旧消息和等待输入均不能接管。源码 Loader 回放证明新用户消息通过模型工具创建新 Work，`outline.update` 修改正式目录并保留评分响应点；原目标重规划回放及运行中队列测试继续覆盖各自路径。

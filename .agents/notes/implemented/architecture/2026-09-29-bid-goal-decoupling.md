# Agent Note: Bid 主流程与显式 Goal 独立

Status: implemented

## Problem

把 S2～S5 绑定到隐藏 Goal，使正常执行、失败分析和重启续行依赖另一套生命周期。用户暂停或清除目标会影响 Bid 任务，恢复工具还把主 Agent 限制为专用修复指令通道。子代理报错需要主 Agent 理解原因并选择解决办法，而非由 Host 或自动目标代替它作决定。

## Decision

默认 Bid 流程不创建 Goal。后台 Run 在局部修复耗尽后保存失败和检查点，再将失败通知交给当前主 Agent；通过 steer 在空闲时启动回合、运行中进入安全 step。主 Agent 使用阶段诊断和 bid_recover_task 的 instruction 处理问题；已回答的 S5 Writing Plan 失败复用保存的回答。Host 继续校验原 Run、project revision、输入身份和正式提交，用户停止与待确认问题保留原入口。

显式 `/goal` 使用原生 Driver 和当前阶段公共工具，模型不能 create_goal。Bid 只注册项目占用 Busy Gate；等待不消耗轮次，项目释放后重新请求同项目的 Driver。Bid 停止、重置和完成不更新 Goal；Goal 更新也不操作 Bid。Host 重启只按 Bid 持久状态恢复，不从历史绑定恢复 Goal activation。

工具授权从当前未结束回合取得。直接用户消息或原生 Driver 接纳的当前 Goal 轮次可以授权；Goal 还须匹配 live Main Agent、当前 initiator、身份、revision 和 round。Work、队列和计划补丁仍保存 session_id 与 message_id；历史消息可验证既有请求，不能授权新调用。已入队请求保留原授权，不要求执行时用户回合仍开放。

恢复工具只接受当前 live Bid Main Agent，按当前 Run、Work、revision、输入和失败指纹校验。bid.recovery.requested 保存模型方案与目标，重复失败再次通知主 Agent，同一指纹下已接纳的相同方案被拒绝；Host 不生成替代方案。

本决策替代[自动 Goal 接管](../feature/2026-09-23-bid-s2-s5-goal-recovery.md)的运行时绑定，以及[持续恢复](../bug-fix/2026-09-28-bid-host-recovery-continuation.md)的 Goal 重激活及恢复授权。两份记录保留旧持久事件含义、错误分类、局部修复与提交边界。`bid.goal.bound` 和 `bid.goal.recovery.requested` 只供旧 Session 解码，不生产或消费新的运行时记录。

## Alternatives considered

**保留自动 Goal，仅放宽恢复工具。** 默认阶段仍会与 Goal 的停止、预算和完成状态相互影响，无法给用户独立的显式目标。

**失败只交给 Host 或等待用户再次发消息。** Host 不能分析语义并选择修复方案，等待用户也无法完成原已授权任务；失败需要主动送到主 Agent。

**让主 Agent 直接覆盖正式文件。** 会丢失原 Work 的检查点和输入校验；复用公开计划与续行工具可保留已有成果和提交约束。

## Consequences

主 Agent 通过现有恢复工具指导原执行器，不需要 Goal 绑定；模型的错误决策仍受 Host 的输入、范围和正式确认约束。恢复指纹历史归 Bid 自己的审计事件所有，不受 Goal 总轮数限制，也不增加 Host 自动重试循环；失败通知要求具体改进，是否继续由主 Agent 判断。只有出现独立、可说明的用户目标需求时才使用原生 Goal。

定向测试覆盖无 Goal 默认执行、停止与完成的生命周期隔离、Busy Gate、真实 Goal 能力执行和计划补丁、当前回合授权、伪造插件消息及原 Run 重启。真实 S4 集成场景在无 Goal 时唤醒主 Agent 并保留七个完成检查点；Loader 无密钥回放覆盖失败通知、当前阶段工具和显式 Goal 提前完成。

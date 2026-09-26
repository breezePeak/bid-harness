# Agent Note: Bid 意外挂起任务由聊天继续

Status: implemented

## Problem

执行器错误、重试耗尽或宿主重启会使 Bid Run 挂起，但原生恢复问题要求用户在继续、重跑和停止之间再次选择。用户已经可以在聊天中明确表达继续意图；额外问题阻断了这一请求，且普通询问仍需与执行授权区分。

## Decision

`executor_error`、`retry_exhausted` 和 `host_restart` 挂起时不创建 `bid.run.decision.required`，Main Agent 在该状态下获得 `bid_resume_current_run`。用户明确要求继续后，模型传入当前 Run ID 和项目 revision；Host 要求调用来自该用户回合，并由 `resumeCurrentRun` 在项目操作内核对 Run、revision 与原 Work 输入身份。工具在新 Run 持久接纳后返回，后续执行由后台操作结算。普通问答不调用恢复工具，失败的身份校验不启动执行。

`awaiting_input` 沿用能力任务的原生输入问题；`user_stop` 保留[原生恢复问题](2026-09-15-bid-native-recovery-questions.md)中的继续、当前阶段重跑和停止选项。聊天续行不隐式重跑或停止阶段。

## Alternatives considered

**所有挂起原因都自动继续。** 宿主重启或重试耗尽后立即执行会消耗模型额度，也无法区分用户追问与执行授权。

**所有挂起原因继续弹出原生选择题。** 意外中断后的用户“继续”仍需再答一次，且无法在同一请求中先保存新的执行策略。

**按“继续”关键词直接恢复。** 关键词无法判别“现在能继续吗”等普通询问；模型按完整用户语义选择工具，Host 仍校验真实用户回合与项目身份。

## Consequences

意外挂起后用户可直接说“继续”，也可先说明需要更改的执行策略；Run 恢复仍受原有持久检查点和项目版本保护。用户主动停止仍由显式原生问题决定，避免把随后的普通消息误解为撤销停止。源码 Loader 回放覆盖意外挂起、无原生问题、策略写入后使用最新 revision、模型调用恢复工具与新 Run 接纳；包测试覆盖只读问答、CAS 拒绝和主动停止问题。

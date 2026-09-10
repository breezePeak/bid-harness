# Agent Note: S5 整体写作要求门禁

Status: implemented

## Problem

S4 最终目录确认后曾立即启动章节关系规划和 Writer，用户没有机会在既有 S5 中说明整书目标、重点章节、风格、表格或旧标复用方式；S5 重置后的显式开始也直接执行。聊天中的临时要求既不能稳定恢复，也无法为章节任务提供经过范围判断的执行计划。

## Decision

`chapter_writing` 使用 `before_execution` 用户门禁。S4 确认和 S5 重置启动只进入 `waiting_user`，Host 按 `outline/confirmed-outline.json` 哈希保存 `chapters/writing-request.json` 并唤醒 Main Agent 发出一次自然语言询问。项目恢复读取该标记，因而刷新或切换 Session 不会重复询问；未获得确认时不存在章节执行事件。

Main Agent 通过 `bid_stage_inspect` 读取确认目录、招标要求与资料映射，负责解释要求、识别关键歧义与冲突并生成全书及逐节任务契约。只有用户确认安排或明确授权直接开始后，Main Agent 才调用 `bid_confirm_writing_plan`。Host 向该工具提供最近 200 条人类用户消息的稳定 Session、Message 和 Seq 引用；Main Agent 选择形成契约的引用，Host 从 Session Log 回查原文并写入 `chapters/writing-plan.json`。计划与确认目录哈希绑定，版本由 Host 单调递增。

程序只允许计划覆盖确认目录中的可写叶节，每个叶节恰好出现一次。模型提交用户要求、全书指令、章节任务、写作指令以及带优先级和 evaluator 的验收条件；Host 绑定文档或章节 scope，分配稳定 `AC-*`、计划版本和目录 Hash。只有模型显式选择受支持 metric 的条件进入确定性测量，条件描述和用户原话不触发程序分支。完整机制由[通用任务契约与动态验收](../architecture/2026-09-10-s5-generic-task-contract-acceptance.md)规定。

章节关系规划接收完整确认计划并把关系 Artifact 绑定计划版本。Writer 接收全书指令和当前章节任务契约；Chapter Reviewer 保留既有审核并作为当前章节动态条件的唯一权威。最终 Main Agent 只判断整书 semantic 条件并消费章节审核事实。

运行中或已完成的 S5 接受普通消息，由 Main Agent 区分问答与新任务。问答不改变阶段或 Subagent；新任务只提交基于当前版本的真实 patch，Host 保留未修改章节并把新计划送入同一调度器。未开始章节自然采用新计划，已完成或运行中的受影响章节定向失效，其他 Writer 与 Reviewer 继续执行。计划版本、section epoch 和强依赖正文及 handoff 身份共同阻止旧结果提交，`chapters/applied-writing-plan.json` 记录执行日志采用的版本。

## Alternatives considered

**新增独立写作规划阶段。** 这会扩展控制面阶段、重做 S4—S5 交接并形成第二套写作链路；门禁属于 S5 的执行前输入，不需要新的阶段身份。

**把用户原话直接广播给全部章节。** 这会把整书要求、局部任务和目录变更责任错误复制给每章，也无法表达冲突处理；语义计划先确定作用范围，再由 Host 装配章节上下文。

**由程序关键词匹配用户要求并生成计划。** 要求含义、优先级、作用范围和资料可行性需要语义判断，固定规则会产生虚假硬指标；程序仅校验结构、身份、版本及模型显式选择的确定性 metric。

**只依赖聊天记录恢复要求。** 新 Session 不复制旧聊天，而且聊天压缩或上下文替换不能成为项目状态权威；项目 Artifact 保存询问身份、原话、确认和计划。

## Consequences

用户在 S4 确认或 S5 重置后必须完成一次写作要求交互，才会进入原有关系规划、依赖调度、Writer 和 Reviewer 链路。“没有特殊要求，直接开始”仍会形成默认计划，但不增加第二次确认。

写作计划 schema v3 和确认目录哈希成为 S5 执行输入；缺失、损坏、目录不匹配、章节集合不完整、条件身份或 scope 非法都会阻止启动。S5 明确重置会删除 `chapters`，因此也删除询问标记和计划并重新询问；执行失败后的普通重试复用同一确认计划。

等待门禁及 S5 运行期间客户端开放普通消息；完成后的无引用消息由 Main Agent 判断为问答或整体计划调整，有章节引用的消息仍沿原 Writer 修订。运行中计划更新不取消整个 S5，但受影响的运行结果可能因 epoch 失效而丢弃并由原 Writer 接收新任务。

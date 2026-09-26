# Agent Note: Bid 自动确认模式

Status: implemented

`waiting_start` 与 `start_stage` 状态分支已由[单一任务状态机](../architecture/2026-09-22-bid-single-task-state.md)替代；手动或自动确认模式及 Writing Plan 规则保持有效。

## Problem

Bid 流程的 S2、S3、S4 都停在确认门禁，S5 还依赖 Main Agent 询问写作要求和用户明确授权。仅由客户端自动点击已有按钮会在 S5 已经发出询问后才发生，而且现有写作计划工具要求真实用户消息引用，无法实现不询问、不伪造用户要求的连续自动执行。

## Decision

默认启动规则由[S4 确认后直接写作](2026-09-26-s5-start-after-outline-confirmation.md)取代：S4 确认后直接执行 S5，浏览器两种确认模式都不自动询问意见。下述问答与恢复约束仅适用于显式创建或已保存的写作请求。

Bid 输入工具栏通过 `conversation.input.left` 提供会话级“手动确认 / 自动确认”选择，默认手动。偏好和已尝试的自动提交身份由浏览器 Session store 持有，不进入 Bid 项目 Artifact 或 Session Event；工具栏与阶段面板共享同一个 store handle。

全自动模式在 `tender_analysis/waiting_user` 复用 `TenderAnalysisReview` 当前 `buildOperations(value, draft)` 结果调用既有确认，保留用户切换模式前的编辑。`outline_generation/waiting_user` 与 `evidence_mapping/waiting_user` 只在 Draft 保存状态为 `saved` 后确认；一次尝试由 `sessionId + stage + revision + draft SHA-256` 标识，提交前即记录，失败不会因重渲染循环重试。S2 和 S5 同样在当前等待身份内只尝试一次。

S5 不读取客户端确认模式。S4 确认后由 Host 直接构造或复用 Writing Plan 并执行；重置后的空入口在两种模式下都调用 `auto_start_chapter_writing`。默认计划以可写叶节的 `purpose` 为任务，保持用户引用、用户要求和动态验收条件为空。显式写作请求仍使用独立的保存与恢复协议。

客户端不自动恢复 suspended Run，也不自动调用 `start_stage`。挂起与 `waiting_start` 保持人工决策；自动确认或自动启动失败后，用户可检查错误、切回手动模式或刷新会话，但当前挂载周期不自动恢复。

## Alternatives considered

**只在客户端自动发送“直接开始”。** 不采用；这会伪造用户话语，让模型参与本可确定的默认计划，还会使 S5 是否启动取决于提示理解和会话时序。

**复用手动写作计划工具并传空消息引用。** 不采用；手动输入协议要求真实消息引用，用例和信任边界不同。放宽模型工具输入会让 Main Agent 能提交无法追溯的“用户要求”。

**把确认模式保存为 Bid 项目状态。** 不采用；模式是当前浏览器会话的交互偏好，不改变项目 Artifact、跨 Session 权威状态或恢复协议。Host 只暴露当前状态允许的两种动作。

**由 Host 在进入 S5 时自行判断模式。** 不采用；Host 不拥有浏览器偏好，提前询问会破坏自动模式，提前启动又会破坏默认手动语义。先发布同一等待状态，再由共享客户端 store 选择正式 Action，保留单一阶段机。

## Consequences

选择全自动后，S2、S3、S4 和 S5 可以连续推进，而所有业务状态变化仍经过已有确认 Action、Validator、项目锁和 Orchestrator。自动 Writing Plan 不声称用户提出过要求；[通用任务契约](../architecture/2026-09-10-s5-generic-task-contract-acceptance.md)因此允许持久化计划中的用户引用和要求为空，但 Main Agent 使用的 initial/patch 输入仍要求真实用户消息。

模式不持久化，刷新或换 Session 后恢复默认手动；这避免把设备偏好误当项目协作状态，也意味着需要用户在新挂载会话中重新选择全自动。尝试身份只保证单个浏览器挂载周期内不重复，Host 的项目锁、状态准入和 CAS 继续处理跨窗口并发。

写作要求记录仍拥有显式请求的真实引用和恢复语义，通用任务契约拥有计划版本、作用域和动态验收；S5 默认启动由直接写作记录拥有。

# Agent Note: S5 运行对话与正文页数结果校验

Status: implemented

## Problem

S5 的消息准入曾在读取用户语义前取消写作并重开要求确认，因此进度询问和正文解释也会停止 Writer。写作计划只校验叶节预算之和，全部章节和模型审核完成后仍可能以明显低于用户目标的实际正文结束。

## Decision

[`chapter_writing` 的首次整体要求门禁](../feature/2026-09-09-bid-s5-writing-requirements-gate.md)保持不变。`session/prompt-admission` 只校验 Bid 会话、项目占用和客户端可接收状态。S5 运行中与完成后的普通消息进入原主 Agent，不取消写作、不创建询问标记，也不改变计划版本或完成状态；另一会话不能借消息取消当前项目所有者。主 Agent 在用户消息前接收可回放的 S5 交互规则，并通过运行态 `bid_stage_inspect` 读取有界的章节编号、真实 ID、执行状态、Writer/Reviewer 尝试、最近问题和正文篇幅快照。只有模型判断用户明确改变整体要求并调用 `bid_confirm_writing_plan` 时，Host 才进入既有版本化恢复路径。

正文工作台、运行态 inspect 和显式 `estimated_pages` 条件共用 `estimateChapterWritingPages()`。该入口按正式导出顺序统计确认目录标题、父节点概述和已有叶节正文，并读取当前 `word-export/config.json` 的生效值；缺失正文保持为空，审核记录和聊天内容不参与计数。条件比较使用未取整值且不增加业务容差；测算异常产生 unavailable 结果，不能当作零页或达标。是否建立该条件及其优先级由 Main Agent 判断，Host 不从条件描述或用户原话推断。

S5 完成校验重新读取 `chapters/writing-plan.json` 并核对确认目录 Hash。Chapter Reviewer 的章节 semantic 结论和 Host deterministic 结果是 section acceptance 权威输入；Main Agent 的整书验收只提交 document semantic 结论并服从 document deterministic 结果。任一 required 条件未满足时不能发布完成状态，preferred 条件只保留结果。[按需导出](../feature/2026-09-04-bid-s5-persistent-review-export.md)仍可生成文件，但 S6 不把 DOCX 结构可读取解释成动态条件达标。工作台把确定性测量、格式版本和动态条件结果与现有整数页数分开投影，通用协议见[任务契约与动态验收](../architecture/2026-09-10-s5-generic-task-contract-acceptance.md)。

## Alternatives considered

**在消息准入中用关键词识别计划变更。** 普通问答和修改要求的区别依赖上下文、引用和语义；准入层缺少这些判断依据，也会让 queue 与 steer 获得不同业务含义。

**用章节计划值汇总代表正文达标。** 计划表达写作意图，不读取正文、父节点概述或 Word 格式；即使计划值自洽，也不能证明生成结果满足条件。

**按固定字数除以常量估算页数。** 这会复制现有估算系统并忽略纸张、页边距、字体、行距、标题、表格和图片；统一入口直接复用正式导出内容和实际格式。

**把整书确定性条件自动复制成每章条件。** 用户未必逐章承诺同一指标；Main Agent 分别建立 document 或 section scope，Host 不扩写条件。

## Consequences

写作期间的普通对话不改变 S5 生命周期，完成态问答也不影响导出。显式变更由 Main Agent 提交当前计划的 patch 和影响范围；Host 在当前调度器中使目标章节及其强依赖下游失效，其他章节继续执行，迟到旧结果按计划版本、section epoch 和依赖身份拒绝提交。

显式确定性条件成为正文结果约束而非计划说明。required 条件不通过时，Main Agent 在同一运行实例内选择最小修订范围并进入有界补写；预算耗尽仍保留正文、测量和验收记录。定向测试覆盖未取整边界、普通消息不取消运行、完成态问答不重开门禁、required/preferred 分流、运行中计划失效，以及 DOCX 结构校验与动态验收的独立结果。

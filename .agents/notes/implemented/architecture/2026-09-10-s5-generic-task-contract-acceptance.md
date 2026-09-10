# Agent Note: S5 通用任务契约与动态验收

Status: implemented

## Problem

写作计划把篇幅目标、章节预算、重点和风格固化为不同字段，新增一种自然语言要求需要扩展 Schema、提示、调度和结果校验。程序按少数已知要求决定影响范围会取代 Main Agent 的语义判断；运行中替换计划若取消整个阶段，还会停止无关章节并允许旧输入与新任务争用落盘。

## Decision

S5 Main Agent 根据用户消息、S2 Requirement/Scoring/Compliance、确认目录、S4 Blueprint/Evidence 和章节运行状态生成统一任务契约。`chapters/writing-plan.json` schema v3 保存用户原话、全书指令、整书验收条件，以及每个可写叶节的任务、用户要求、写作指令和验收条件。首次计划是完整输入；已有计划只接受绑定当前 `base_plan_version` 的 patch，分别表达全书指令替换、document acceptance 增删改和 section task、消息引用、写作指令、acceptance 增删改。未提交的章节保持原值，Host 把实际 section patch 并入影响范围。

Main Agent 从 Host 提供的最近 200 条人类用户消息中选择稳定的 `session_id`、`message_id` 和 `seq` 引用。Host 从 Session Log 回查准确原文并持久化引用与文本；普通对话未被引用时不进入任务契约。模型不提交条件 ID、scope、计划版本或执行状态；Host 按条件所属数组绑定 document/section scope，单调分配全局唯一的 `AC-*`，并为未修改条件保留 ID。动态条件数组允许为空，固定 Reviewer 不依赖占位条件运行。

每个条件声明 `required` 或 `preferred`，以及 `semantic` 或 `deterministic` evaluator。Semantic 内容由 Reviewer 或最终 Main Agent 判断。Deterministic 内容只允许模型显式选择 Host 已公布的 metric 和上下界；当前 metric 为 `estimated_pages` 与 `character_count`。Host 测量正文与排版事实并返回 met、unmet 或 unavailable，不读取条件描述和用户原话来选择 evaluator。模型负责决定是否建立条件、优先级、作用范围和修订方向。

Writer 接收完整章节任务契约及既有 Blueprint、Requirement、Scoring、Compliance 和 Evidence。独立 Reviewer 的 must-answer、Requirement、Scoring Response Point 和 Compliance 继续使用 `covered/missing` 覆盖协议；动态 acceptance 使用独立的 `criterion_id`、`met/unmet`、正文 quote 引用和 reason 协议。Semantic 条件允许在 unmet 时引用违规正文，也允许对整章性质不给出单句 quote。Host deterministic 结果合入正式报告且 Reviewer 不能覆盖。Chapter Reviewer 是 section acceptance 的唯一权威；required 未满足进入 blocking issues 并回到同一 continuable Writer，preferred 未满足保留结果但不自动改变 pass。

全部章节和文档级合规审核完成后，Main Agent 通过私有完成工具判断 document semantic acceptance，消费各 Chapter Reviewer 的 section 权威结果，并选择最小充分章节给出修订指令。该工具不接受 section criterion 结论，不能覆盖 Chapter Reviewer。Main Agent 默认读取章节摘要、正文身份和审核结果；证据不足时可按 Section 读取当前已完成章节的有界只读片段并取得 quote 引用。Host 复用原 Writer，重新执行受影响章节审核、文档级合规审核和最终验收，并把每轮计划版本、Word 格式版本、正文 Hash、document 条件结论和修改前后章节 Hash 写入 `chapters/completion-review.json`。整书修订使用独立的 `chapterWritingCompletionRepairRounds` 上限。

`execution-plan.json` schema v3 绑定确认目录 Hash 和 Writing Plan 版本。Writing Plan 更新后，Main Agent 重新判断受影响范围的 `depends_on`、`related_sections`、`planning_notes` 和 `global_consistency_notes`，Host 只负责校验 DAG 和执行。Host 在一个运行中的 S5 调度器内接收版本化计划命令；已完成或正在运行的受影响章节递增 section epoch 并重新排队，未受影响任务继续运行。

每次 Writer 和 Reviewer 尝试绑定当前计划版本、section epoch，以及全部强依赖章节的候选正文 Hash 与 handoff Hash。正文处理、Reviewer 返回、候选文件写入和完成日志提交都重新核对该身份。计划、章节或上游 handoff 变化后，迟到结果统一记录为 `stale-input`、`accepted=false`，不能覆盖正文、成为最终 Reviewer 或归类为基础设施失败。Host 沿实际强依赖关系传播失效。

最终 Validator 独立校验 execution plan/log 与当前 Writing Plan 的绑定、每个 required section criterion 的最新 Chapter Reviewer 结果、required document criterion 的最终整书结果、deterministic 结果与 Host 当前事实，以及最终 Writer/Reviewer 尝试的全部输入身份。Final Main Agent 不承担章节结果的二次确认。

本记录更新[整体写作要求门禁](../feature/2026-09-09-bid-s5-writing-requirements-gate.md)的计划结构和运行中应用方式，并补充[运行对话与正文结果校验](../bug-fix/2026-09-10-bid-s5-live-chat-page-result-validation.md)的通用 evaluator 与整书修订循环。两份记录仍分别拥有首次询问、会话恢复、普通消息准入和排版测量的独立理由，因此保持 active。

## Alternatives considered

**继续增加篇幅、表格、重点和安全等专用字段。** 不采用；这些是用户要求的实例，不是稳定的调度抽象。每个实例增加字段和分支会让新要求依赖代码发布，并把语义作用范围错误交给程序。

**由 Host 从用户文字识别条件与影响范围。** 不采用；优先级、章节归属、是否可测和修订范围依赖完整招标与写作上下文。Host 只验证模型显式提交的结构、身份、版本和 metric。

**让 Main Agent 自报页数、字数和章节状态。** 不采用；这些事实可由程序重现，自报值会与磁盘内容和 Word 格式漂移。模型消费 Host 测量结果，不复制确定性状态。

**计划更新时取消并重启整个 S5。** 不采用；全局取消会停止无关 Subagent、丢失可复用进度并扩大写入竞态。命令队列和 section epoch 在同一调度器内限定失效范围。

**动态条件失败时创建新 Writer。** 不采用；原 Writer 已持有本章研究、短引用和修复历史。定向修复续用相同身份，Reviewer 仍保持独立。

## Consequences

旧 writing-plan 磁盘格式被拒绝，首次发布前不提供兼容转换。条件 ID 与计划版本由 Host 稳定生成，但语义条件质量、优先级和影响范围仍取决于 Main Agent；无密钥回放只能证明协议、隔离、版本和持久化，不能证明任意自然语言要求的判断正确。

章节报告 schema v5、完成账本 schema v2、执行计划和执行日志 schema v3 记录动态验收与输入身份。确定性能力只有显式注册的 metric；新增 metric 需要定义可重现输入、不可用语义和边界测试，但不需要增加需求关键词分支。

测试使用篇幅、章节详略、表格偏好、证据约束和风险重点等不同文本通过同一写作计划 Schema，固定条件描述不会选择 deterministic 路径。协议测试固定 negative semantic、required/preferred 分流和 section 权威边界；章节执行测试固定 patch 影响范围、计划版本失效、上游 handoff 变化、动态失败回到原 Writer、无关章节继续和修订后整书复核；项目会话测试通过真实 Main Agent 工具循环固定多轮消息引用、运行中普通问答不停止写作，并覆盖完成态任务上下文读取。

# `@deepseek-ai/dsh-bid`

[English](README.md) | 中文

投标写作 profile 的工作区本地入库能力与共享控制面类型。一个 Workspace 对应一个 Bid 项目；`new BidWorkspace(workspaceRoot, config)` 将项目文件保存到 `projectDirectory`，默认是 `.bid-harness/`，同一工作区的所有 Session 共用。该目录包含 `project-state.json`、`manifest.json`、`input/`、`corpus/`、`analysis/`、`outline/`、`chapters/` 和 `output/`。不读取或迁移旧的 Session 独立目录。

支持导入 PDF、DOCX、DOC、XLSX、XLS、TXT 和 Markdown。每个入库文件都会获得 `corpus/<stored-name>/document.md`；PDF、DOCX 和 DOC 还会从 `extractDocument()` 获得 `structure.json` 与 `metadata.json`。Manifest 版本 4 记录文件角色、语料和产物路径。调用方将 `messageInventory()` 与用户请求一起持久化，因此 Agent 只会看到工作区相对的原文件、正文、分块与结构路径，并可使用常规 `grep` 和 `read` 工具。

PDF、DOCX 和 DOC 共享一个 parser 入口：

```ts
import { extractDocument } from '@deepseek-ai/dsh-bid'

await extractDocument({
  sourcePath: './workspace/input/招标文件.pdf',
  outputDir: './workspace/corpus/招标文件.pdf',
})
```

PDF 提取使用文本位置保留物理行，并输出 `<!-- page: N -->` 注释。无文字 PDF 会写出带 `needs_ocr` 状态的语料；本包不执行 OCR。DOCX 提取会保留 Word 标题、列表、表格和正文中的比较符号（如 `<`、`>`），不伪造页码，也不会把比较符号误判为 HTML 标签。DOC 提取使用纯 JavaScript 的 `word-extractor`，因此 Windows、macOS 和 Linux 都不需要 Word、LibreOffice、`antiword` 或其他系统可执行文件。DOC 文本会保留自然段和制表符分隔的表格单元格，但二进制格式无法通过该 parser 提供可靠的 Markdown 标题层级或页码。

入库会拒绝空文件、不安全文件、不支持格式、超大文件和超数量批次。解析失败会保留原文件，并在 `manifest.json` 中记录稳定的提取错误。复用提取输出目录时，系统通过 `dsh-atomic-write` 原子替换三个完整语料文件。`exportDocx()` 只接受项目目录内 Markdown，并写入项目输出目录。

## 控制面类型

本包导出固定的 `BidStage` 与 `StageRunStatus` 值，以及 `BidRuntimeState`、`BidStagePolicy`、`BidStageTask`、`StageArtifact` 和 `StageValidationResult`。browser-safe 子路径 `@deepseek-ai/dsh-bid/control-plane` 还会导出 `BidClientProjection`、`BidUploadFile` 请求、`BidFileIntakeResult` 响应、Host 允许的 action 列表和 composer capability，而不会加载文档解析器或 Node 模块。`BID_STAGES` 与 `STAGE_RUN_STATUSES` 是供 validator 和 client 使用的运行时枚举；从它们派生的联合类型阻止出现第二套阶段或状态名称。

七类 `bid.*` 记录通过声明合并接入现有 `@deepseek-ai/dsh-session` `SessionEventMap`。`bid.project.resumed` 只把项目 runtime 和 revision 写入当前 Session，用于初始化或同步 `bid.runtime` Projection；其他事件记录阶段转换、工作区产物引用、失败摘要、浏览器安全的校验问题和用户确认，不保存文档、Artifact 原文、绝对路径或调用栈。`StageValidationIssue` 使用稳定 `code`、项目相对 `artifact`、Schema `path` 和安全 `message`；`failureIssues` 通过事件、Reducer 和 Projection 保留这些字段。

## 控制面 Runtime

`project-state.json` 是项目进度的持久化来源，schema version 1 保存 runtime、单调递增 revision 和 `updated_at`，不保存聊天消息、工具调用、提示词或摘要。Bid Session 启动时从 `session.header.cwd` 定位项目；缺少状态文件时初始化 `file_intake/pending`，否则通过 `bid.project.resumed` 恢复当前 Session 的 Projection。Workspace 的“+”继续调用 `sessions.create()`：新 Session 不读取其他 Session 的聊天或模型上下文，也不建立父会话关系。

`BidOrchestrator` 绑定执行操作所用的 DSH Session，并通过 `reduceBidRuntimeState()` 归约当前 Session 已同步的状态。`drive()` 只推进已有 Executor 支持的 pending 阶段；`waiting_user`、`failed` 和 `completed` 保持原阶段。Host 在项目锁内重新读取项目状态，并在上传、自动执行、重试、重置、确认、重新生成和导出结束后集中执行原子 checkpoint。读取到没有活动操作的 `running` 时，保持阶段并转为 `failed`，提示“阶段执行因后端停止而中断，请重试当前阶段。”；S1 恢复上传，其他阶段允许重试。

全新项目的文件接入必须等待专用上传操作，因为其 Executor 需要已准入的文件批次。S2 的 Stage Policy 声明 `requiresUserConfirmationAfterValidation`；初次校验通过后记录 `bid.user_confirmation.required`，不记录完成事件。`confirmValidatedStage()` 在正式 Artifact 再次通过 Validator 后才记录用户确认和阶段完成。

`registerBidRuntimeProjection()` 把同一状态归约函数注册为 DSH Session Projection `bid.runtime`。Projection 返回 `BidClientProjection`，其中 `allowedActions`、composer 能力以及 `allowedExtensions`、`maxFiles`、`maxFileBytes`、`maxTotalBytes` 限制均由 Host 生成；Client 不归约 Bid Event，也不根据 Stage 推导业务权限。`@deepseek-ai/dsh-bid/control-plane` 是不依赖 Node 文档处理库的 browser-safe 数据契约出口。

Host 插件注册该 Projection，并全局拒绝已解析 Preset 为 `bid` 的 Session 进入通用 Prompt 路径。`evidenceMappingMaxConcurrency` 和 `chapterWritingMaxConcurrency` 分别限制 S4 Mapping Subagent 与 S5 Chapter Subagent 的同时运行数量，均默认为 3，可配置为 1–8。

`bid` Agent Preset 只为 Bid Session 注册 `/bid-reset-s2` 至 `/bid-reset-s5` 四个无参数命令。每个命令可以重置当前阶段或回退到更早阶段；自动阶段正在运行时，Host 原子占用项目，取消执行操作的主 Agent、Subagent 和并发 Worker，等待全部工作静止，再删除所选阶段及其后续阶段拥有的 Artifact、追加 `bid.stage.reset` 并从阶段入口完整重跑。短暂文件事务先自然结算；未来阶段、第二个并发重置和带参数命令会被拒绝。用户发起的取消不会记录 `bid.stage.failed`，命令结果也不进入模型历史。

浏览器将一次 S1 所选原文件按顺序组成同源二进制请求，并只在小型请求头中声明名称、角色、类型和大小。Host 由该请求解析实时 Session，以工作区的规范绝对路径作为项目锁键，准入完整批次，通过 `BidWorkspace` 入库并校验生成的 `manifest.json`、原文件、语料、分块索引和分块文件，随后调用 `drive()`。同一 Workspace 的不同 Session 不能并发修改项目；不同 Workspace 可以并行。请求体不能还原全部已声明文件时，S1 会记录失败且不能推进。`modelStageRepairAttempts` 配置 S2–S5 的 Validator 导向修复轮数；最终仍未通过时，Orchestrator 记录当前阶段失败，用户可通过 `bid/retryStage` 重试。S5 从严格校验的章节检查点继续，其他阶段按各自执行器规则重跑。

S1 资料上传、S2 招标分析、S3 初步目录生成、S4 目录生成/资料映射和 S5 正文编写组成线性流程；S6 是 S5 完成后在审核工作台内随时可用的按需导出动作。S2 只提取 Project、Requirements、Scoring 和 Compliance；评分原文在 S2 保持完整。S3 独立复核按语义拆解的评分响应点，由 Host 分配稳定 `RP-*` ID，再适配可选人工框架、保存精确框架标题引用并生成初始目录；同一响应点可覆盖多个可写 Section。S4 按 Section 规划和研究，直接形成 `section_mappings`，完成一次基于证据的目录深化，并只对新增或语义变化的可写 Section 补充映射。S5 在章节正文生成后立即持久化并启动独立 Reviewer；明确问题最多自动修复一次，最终仍有问题时保留 `needs_attention`，不阻断 Word 导出。

S5 将 `execution-log.json` 作为章节级检查点。模型流断开或结果通道错误使用独立运行重试预算，不占内容修订次数；单章最终失败不会取消无关章节。阶段重试会严格校验原计划、日志、正文、metadata、Reviewer 报告、内容哈希和 Child 身份，保留有效的 completed 章节，只重新排队 failed、running 和 pending 章节。重试不会删除章节文件；显式阶段重置才执行清理。

Writer 在缺少真实项目数量、人员、设备或记录值时只保留正式字段和填写规则，不生成示例数据行。Reviewer 不得要求虚构或示例值，并把已填的“示例、待补、XXX、最终填写”等内容视为占位。

S2 的 `project.json` 记录项目背景、建设目标、实施约束和项目技术重点；`scoring.json` 只保存评分原文、分值与简单规范化字段，不含评分响应点。纯商务、资格和报价评分不得进入 `scoring.json`。Validator 检查覆盖、严格 schema、来源文件、分块和引用行后，S2 停在 `tender_analysis/waiting_user`。

`bid/getTenderAnalysisForConfirmation` 返回 S2 的四个 Artifact；`bid/confirmTenderAnalysis` 只允许编辑规范化项目、要求、评分与合规字段。原文、分值、ID、`source_refs` 与招标文件覆盖集合不在操作协议中。Host 原子替换四个原路径文件并再次执行完整 S2 Validator；无效输入返回问题并保持 `waiting_user`，通过后才完成 S2 并启动 S3。

## Model Experience
## S2–S5 质量控制

S2 首次提取后立即执行 Validator；通过时进入 `tender_analysis/waiting_user`。技术评分提取先以 grep 定位评分区域，再从 `chunks/index.json` 的相邻关系读取连续小窗口，并只用一次轻量 grep 寻找远距离的额外评分区域。Requirement、Scoring item 和 Compliance item 的 `raw_text` 可以在引用原文含义内提取、压缩、去冗余和原子化，但不得改变关键数字、单位、强制语义或新增要求。`must_answer` 是 boolean，表示该评分项是否必须在技术标响应；评分响应点仍由 S3 拆解。Validator 分别返回 Artifact 缺失、JSON 语法和严格 Schema 问题，并严格校验每个 `source_refs` 的文件身份、解析状态、chunk 归属、行号范围和 Workspace 路径安全；Validator 不要求 `raw_text` 逐字存在于引用范围，且仅在 Requirements 或 Scoring 为空时读取完整招标语料执行异常空结果检查。Executor 用最新 Issues 执行可配置的多轮 Repair，只允许 `grep`、`read` 和 `write`；每轮只允许修改 Issues 指向的 Artifact 和字段。重置任一阶段会取消待处理输入，并从模型可见上下文移除该阶段及后续阶段的消息；原始会话日志仍用于审计和回放。Orchestrator 的最终 Validator 通过后才进入 `tender_analysis/waiting_user`。

S3 先按评分语义产生候选响应点，再由独立语义复核回看评分场景是否完整；Host 用评分 Artifact 哈希和单调序列建立稳定目录。Agent 随后以 Response Point、Requirements、Compliance 和可选人工框架生成初始目录，按主框架、补充框架和无关框架明确适配，并在 Section 上保存精确 `framework_refs`。目录质量复核负责语义粒度；Host 只校验确定性的 Schema、树、ID、覆盖和框架引用，不要求响应点全局唯一归属。用户确认结果保存为 `outline/initial-confirmed-outline.json`。

S4 按目录业务分支分批映射，Evidence 以 Section ID 保存；目录深化与用户编辑只对齐 Evidence，空材料由 S5 按缺口继续研究。详见 [S4–S5 资料映射规则](README.md#s2s5-quality-control)。

S5 只把 `outline/confirmed-outline.json` 作为章节结构来源。主 Agent 只写章节关系计划；Host 按强依赖 DAG 调度 Writer，并按每个 Section 的 `framework_refs` 注入精确框架正文分块。框架正文是可保留、适配或改写的写作输入，不是当前项目事实 Evidence。每份有效候选正文和 Metadata 在 Reviewer 启动前即可读取；Reviewer 没有工作区或网络工具。企业事实缺少本地依据时保留 `unresolved_topics`，不得由框架或 Web 资料替代。

S5 完成后项目保持 `chapter_writing/completed`，审核项标签和逐章状态常驻。审核工作台中的“导出 Word”调用 Host `exportDocx`，程序核对章节 manifest 的确认目录哈希、完整章节集合及正文路径，再按确认目录顺序保留结构标题并组合正文；每次在 `outputDirectory` 写入一对带时间标识的 Markdown 和 DOCX 文件。导出成功或失败都不改变 S5 状态，可重复执行。已经保存为 `docx_export/completed` 的旧项目同样保留审核工作台和导出动作。


### Inventory 文本

#### What the model sees

调用方把 `messageInventory()` 持久化为用户消息，其中包含每个文件的名称、工作区相对的原文件路径、解析正文路径、结构路径和解析状态。文档字节与主机绝对路径不会进入该文本。这些路径使模型可以使用现有 `grep` 和 `read` 工具。

#### Token effect

有界 inventory 会为每个入库文件增加一组固定行。只有模型读取解析正文时，正文文本才会进入上下文。

#### KV Cache effect

持久化 inventory 属于追加式会话内容。后续用户消息导入文件不会改变更早的请求前缀。

## Known Limitations and Deferred Work

- PDF 提取不执行 OCR 或完整表格重建；无法安全恢复列时，带位置信息的行仍保持分行。
- DOC 提取保留文本、自然段、列表标记和制表符分隔的表格单元格，但不能保留全部二进制 Word 样式。
- DOCX 与 DOC 页码字段保持 `null`，因为其源结构不提供可靠分页。
- DOCX 导出支持标题、自然段、列表和表格，但不会套用公司 Word 模板。

文件接入按文件返回结果：名称、格式、大小、base64 编码或解析失败会附带文件名、角色、稳定错误码和错误消息，不阻断同批次的其他有效文件；至少一个成功解析的招标文件才能推进阶段。

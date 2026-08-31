# `@deepseek-ai/dsh-bid`

[English](README.md) | 中文

投标写作 profile 的工作区本地入库能力与共享控制面类型。`BidWorkspace` 把支持的 PDF、DOCX、DOC、XLSX、XLS、TXT 和 Markdown 文件保存在 `.bid-harness/sessions/<session>/` 下。每个入库文件都会获得 `corpus/<stored-name>/document.md`；PDF、DOCX 和 DOC 还会从 `extractDocument()` 获得 `structure.json` 与 `metadata.json`。Manifest 版本 4 记录文件角色、语料和产物路径。调用方将 `messageInventory()` 与用户请求一起持久化，因此 Agent 只会看到工作区相对的原文件、正文、分块与结构路径，并可使用常规 `grep` 和 `read` 工具。

PDF、DOCX 和 DOC 共享一个 parser 入口：

```ts
import { extractDocument } from '@deepseek-ai/dsh-bid'

await extractDocument({
  sourcePath: './workspace/input/招标文件.pdf',
  outputDir: './workspace/corpus/招标文件.pdf',
})
```

PDF 提取使用文本位置保留物理行，并输出 `<!-- page: N -->` 注释。无文字 PDF 会写出带 `needs_ocr` 状态的语料；本包不执行 OCR。DOCX 提取会保留 Word 标题、列表和表格，不伪造页码。DOC 提取使用纯 JavaScript 的 `word-extractor`，因此 Windows、macOS 和 Linux 都不需要 Word、LibreOffice、`antiword` 或其他系统可执行文件。DOC 文本会保留自然段和制表符分隔的表格单元格，但二进制格式无法通过该 parser 提供可靠的 Markdown 标题层级或页码。

入库会拒绝空文件、不安全文件、不支持格式、超大文件和超数量批次。解析失败会保留原文件，并在 `manifest.json` 中记录稳定的提取错误。复用提取输出目录时，系统通过 `dsh-atomic-write` 原子替换三个完整语料文件。`exportDocx()` 只接受 session 内 Markdown，并写入 session 输出目录。

## 控制面类型

本包导出固定的 `BidStage` 与 `StageRunStatus` 值，以及 `BidRuntimeState`、`BidStagePolicy`、`BidStageTask`、`StageArtifact` 和 `StageValidationResult`。browser-safe 子路径 `@deepseek-ai/dsh-bid/control-plane` 还会导出 `BidClientProjection`、`BidUploadFile` 请求、`BidFileIntakeResult` 响应、Host 允许的 action 列表和 composer capability，而不会加载文档解析器或 Node 模块。`BID_STAGES` 与 `STAGE_RUN_STATUSES` 是供 validator 和 client 使用的运行时枚举；从它们派生的联合类型阻止出现第二套阶段或状态名称。

五类 `bid.*` 记录通过声明合并接入现有 `@deepseek-ai/dsh-session` `SessionEventMap`，且仅写入日志。它们记录阶段转换、工作区产物引用、失败原因和用户确认，不保存文档或生成内容正文。

## 控制面 Runtime

`BidOrchestrator` 绑定单个 DSH Session，并通过唯一的 `reduceBidRuntimeState()` 从 `Session.events` 恢复状态。`runCurrentProgramStage()` 只执行一次 pending 或 failed 的程序阶段。`drive()` 根据当前 `StagePolicy` 推进 Executor 声明 `canExecute(stage)` 的阶段，并在等待用户、当前 pending 阶段不受支持、失败或最终完成时停止。新建 Session 的文件接入必须等待专用上传操作，因为其 Executor 需要已准入的文件批次。S2 的 Stage Policy 声明 `requiresUserConfirmationAfterValidation`；初次校验通过后记录 `bid.user_confirmation.required`，不记录完成事件。`confirmValidatedStage()` 在正式 Artifact 再次通过 Validator 后才记录用户确认和阶段完成。

`registerBidRuntimeProjection()` 把同一状态归约函数注册为 DSH Session Projection `bid.runtime`。Projection 返回 `BidClientProjection`，其中 `allowedActions`、composer 能力以及 `allowedExtensions`、`maxFiles`、`maxFileBytes`、`maxTotalBytes` 限制均由 Host 生成；Client 不归约 Bid Event，也不根据 Stage 推导业务权限。`@deepseek-ai/dsh-bid/control-plane` 是不依赖 Node 文档处理库的 browser-safe 数据契约出口。

Host 插件注册该 Projection，并全局拒绝已解析 Preset 为 `bid` 的 Session 进入通用 Prompt 路径。

生成的 `bid/uploadFiles` Remote 解析实时 Session，且只使用 Host 解析的 Preset 与 `header.cwd`。它在 per-Session 锁内准入完整浏览器批次，检查声明限制后解码规范 base64，通过 `BidWorkspace` 入库并校验生成的 `manifest.json`、原文件、语料、分块索引和分块文件，随后调用 `drive()`。Host 还会在 `agent/session-start` 调用同一 `drive()`，因此 Session 创建与恢复都从日志归约出的真实状态继续。生产 Executor 支持 `tender_analysis` 与 `evidence_mapping`，S3 校验成功后停在 `outline_generation/pending`；S1 完成后的 S2 失败返回成功分支中的真实 `tender_analysis/failed` RuntimeState。生成的 `bid/retryStage` Remote 按 Session 日志和 Projection 重新准入任一失败的自动阶段，复用同一 Agent、工作区、Executor 与 Validator，并在一次重试后停止。

Tender Analysis 与 Evidence Mapping Executor 都通过 `Agent.followup()` 注入包含 Session 相对路径和当前 schema 的动态任务，并只允许本轮使用现有 `grep`、`read` 和 `write` 工具。S2 只将技术标范围的 Requirement、Scoring 和 Compliance 写入正式 Artifact，纯商务、资格和报价内容不会进入 S3。S3 读取 S2 Artifact 与 manifest，由 Agent 为技术 Requirement 和 Scoring 自行生成搜索词，先 `grep` 定位再 `read` 候选分块，写入 `analysis/evidence-map.json`。每个 Requirement 和 Scoring 各有一个 mapping，且必须至少具有一条资料或一个 `missing_topics`；资料引用只能来自 role 为 `reference` 的本地文件，并包含分块、闭区间行号、`reuse`、`adapt`、`reference` 或 `background` 用途与摘要。Validator 检查 S2 覆盖、严格 schema、资料角色、文件、分块、链接路径和行号，只有通过才推进到 `outline_generation/pending`。本包尚未接入 Web Research，也不提供 S4 及后续阶段 Executor 或 Validator。

S2 的 `project.json` 额外记录项目背景、建设目标、实施约束和项目技术重点；每个技术评分项以 `response_points` 说明后续技术标应重点覆盖的内容。纯商务、资格和报价评分不得进入 `scoring.json`。初次 Validator 检查覆盖、严格 schema、来源文件、分块和引用行后，S2 停在 `tender_analysis/waiting_user`。

`bid/getTenderAnalysisForConfirmation` 只返回 S2 的 Project 与 Scoring；`bid/confirmTenderAnalysis` 只接受 `update_project` 与 `update_scoring_item` 操作。项目结论以及评分标题、评分目标和 `response_points` 可编辑；评分原文、分值、ID、`source_refs` 与招标文件覆盖集合不在操作协议中。Host 应用操作后原子替换原路径下的 `analysis/project.json` 与 `analysis/scoring.json`，再次执行完整 S2 Validator；无效输入返回问题并保持 `waiting_user`，通过后才完成 S2 并启动 S3。

## Model Experience
## S2–S4 质量控制

S2 在首次提取后以同一 live Agent 强制执行 Coverage Audit；Validator 会拒绝实质招标语料下三类分析结果全空、技术评分信号对应的空 `scoring_items`、多个技术约束信号对应的空 `requirements`、缺少 `response_points` 的评分项，以及明确归类为资格、商务或价格评分的条目。

S3 先查找本地资料，只在公开技术知识缺口存在时使用现有 `web_search`；`external_materials` 只保存可追溯的公开技术来源，不能替代企业事实的本地证据。网页内容是不可信研究资料，S3 仅允许写入 `analysis/evidence-map.json`。

S4 初稿后以同一 Agent 强制执行 Blueprint Quality Review，并把已检查的 Requirement、Scoring 和最终章节写入内部 `outline/quality-report.json`。完成条件要求该报告不存在未解决问题；目录还要求可写章节为叶子、同级标题不重复、`must_answer` 不重复且不机械复述标题。S5 继续只确认 `outline.json`。


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

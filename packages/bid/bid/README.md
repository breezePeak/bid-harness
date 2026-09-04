# `@deepseek-ai/dsh-bid`

English | [中文](README.zh.md)

Workspace-local intake and shared bid control-plane types for the bid-writing profile. `BidWorkspace` saves supported PDF, DOCX, DOC, XLSX, XLS, TXT, and Markdown files below `.bid-harness/`. Every imported file receives `corpus/<stored-name>/document.md`; PDF, DOCX, and DOC additionally receive `structure.json` and `metadata.json` from `extractDocument()`. Manifest version 3 records the corpus and artifact paths. The caller persists `messageInventory()` with the user's request, so the agent sees workspace-relative source, document, chunk, and structure paths and can use its normal `grep` and `read` tools.

PDF, DOCX, and DOC share one parser entry:

```ts
import { extractDocument } from '@deepseek-ai/dsh-bid'

await extractDocument({
  sourcePath: './workspace/input/招标文件.pdf',
  outputDir: './workspace/corpus/招标文件.pdf',
})
```

PDF extraction uses text positions to retain physical lines and emits `<!-- page: N -->` comments. Text-free PDFs write their corpus with `needs_ocr`; this package does not run OCR. DOCX extraction retains Word headings, lists, and tables without inventing page numbers. DOC extraction uses the pure-JavaScript `word-extractor` parser, so Windows, macOS, and Linux require no Word, LibreOffice, `antiword`, or other system executable. DOC text retains paragraphs and tab-separated table cells, but the binary format does not expose dependable Markdown heading levels or page numbers through this parser.

Import rejects empty, unsafe, unsupported, oversized, and over-count uploads. A parse failure retains the original file and records the stable extraction error in `manifest.json`. Reusing an extraction output directory atomically replaces the three complete corpus files through `dsh-atomic-write`. `exportDocx()` accepts only project-local Markdown and writes under the project output directory.

## Control plane types

The package exports the fixed `BidStage` and `StageRunStatus` values plus `BidRuntimeState`, `BidStagePolicy`, `BidStageTask`, `StageArtifact`, and `StageValidationResult`. The browser-safe `@deepseek-ai/dsh-bid/control-plane` subpath additionally exports `BidClientProjection`, the `BidUploadFile` request and `BidFileIntakeResult` response, its Host-admitted action list, and composer capability without loading document parsers or Node modules. `BID_STAGES` and `STAGE_RUN_STATUSES` are the runtime enumerations for validators and clients; their derived union types prevent a second stage or status vocabulary.

The seven `bid.*` records declaration-merge into the existing `@deepseek-ai/dsh-session` `SessionEventMap` and remain log-only. They record stage transitions, workspace artifact references, failure reasons, and user confirmations without storing document or generated-content bodies.

## Control plane runtime

`project-state.json` 保存 Workspace 级项目进度；新 Session 通过 `bid.project.resumed` 初始化当前控制面，不复制旧聊天。`BidOrchestrator` 在执行所用 Session 中通过 `reduceBidRuntimeState()` 归约已同步的状态。详见[项目生命周期](README.zh.md#控制面-runtime)。 `runCurrentProgramStage()` executes the pending or failed program-owned stage once. `drive()` follows each current `StagePolicy` while the Executor reports `canExecute(stage)`, and stops at user input, an unsupported pending stage, failure, or final completion. Fresh project intake waits for the dedicated upload action because its executor requires the admitted file batch. `retry()`, `confirm()`, `admitAction()`, and `admitPrompt()` enforce state and permissions on the Host.

`registerBidRuntimeProjection()` registers the same reducer as the `bid.runtime` DSH Session Projection. Its `BidClientProjection` exposes only Host-admitted actions, composer capability, and Host-configured file limits. S1 through S5 form the linear writing workflow. S6 is an on-demand export action available beside the completed S5 review workbench.

The browser sends one ordered, same-origin binary S1 request whose body contains the original selected file streams and whose small headers carry their names, roles, types, and sizes. The Host resolves the live Session from that request, admits the complete batch under a project lock, imports through `BidWorkspace`, validates the resulting `manifest.json`, input, corpus, chunk index, and chunks, then calls `drive()`. A body that cannot reconstruct every declared file records S1 as failed and cannot advance it. Host 在 `agent/session-start` 先读取项目状态；waiting_user、failed 和 completed 保持原状态，只由现有驱动器执行 pending 阶段。

S2 writes only Project, Requirements, Scoring, and Compliance; scoring text stays whole and contains no response-point field. S3 independently reviews semantically derived response points, lets the Host assign stable `RP-*` identities, adapts optional framework trees, stores exact framework heading references, generates an initial outline, and owns its first user confirmation. One response point may belong to multiple writable Sections. S4 按业务分支并行研究章节任务与资料，在一次目录深化后完成轻量 Final Check，向 S5 交付可直接写作的 Blueprint。

In S5, the Host schedules independent Writers from the confirmed outline and makes each valid body available before its Reviewer starts. The Host binds the durable must-answer and scoring coverage indexes from that confirmed outline; the Reviewer separately verifies that the body actually covers them. A review repair receives at most one new Writer attempt. If the second review still reports problems, the durable review remains `needs_attention` and does not block on-demand export.

After S5 completes, `exportDocx` validates the confirmed outline and complete chapter set, combines the bodies in outline order, and writes a fresh timestamped Markdown and DOCX pair under `outputDirectory`. Repeated exports do not change the completed S5 runtime or hide its review state. Existing projects already checkpointed at `docx_export/completed` retain the same review and export actions.

## Model Experience

### 等待确认时的阶段交互

S2、S3、S4 的 `waiting_user` 开放普通消息，`running` 禁止发送。Main Agent 通过 `bid_stage_inspect` 读取最新阶段资料；S3/S4 另提供 `bid_outline_apply_operations`、`bid_outline_regenerate_scope`，S4 提供 `bid_evidence_remap`。编号和标题由模型根据 inspect 的当前目录树解析为实际 Section ID，不要求用户填写内部 ID。检查结果、交互提示和工具结果都进入会话日志；动态工具集合改变后续请求的工具前缀，已记录的历史消息不改写。

所有修改使用 Host 的项目锁、Draft revision/hash CAS 和目录 Validator。局部重生成使用无文件工具的独立 Child 返回编辑操作，经 `mutateOutlineDraft` 保存 Draft；范围外节点及选中根位置不得改变。目录编辑不启动资料复核，也不覆盖最近完成研究的目录。Main Agent 没有裸写、shell 或任意其他工具权限，不能绕过领域动作修改正式产物。

S4 交互重映射与初始研究共用执行器、Corpus Guard、Child 调度、有限修复及 Web Snapshot。指定可写叶子只运行该叶子，指定结构节点展开其可写后代，不运行无关章节，也不再次深化整本目录。`replace` 替换目标 Evidence；`supplement` 去重合并材料和写作维度，以本轮研究结论更新真实缺口。重映射产生的 Writing Brief 保存到 Draft，最近完成整体验证的目录基线保留；最终确认按引用清理快照。

修改成功更新 Draft revision，发布 `running → waiting_user`，客户端刷新并提示“已更新，请重新确认”。最终确认比较 Draft 与研究目录，只复核写作目标、必答问题、业务关联、写作要求或祖先语义变化影响的叶子；单纯排序不触发模型。复核同步 Writing Brief、父节点摘要与 Evidence，完整校验后发布确认产物；失败恢复正式产物并保留 Draft。聊天文字不代表确认，只有正式确认动作可以推进阶段。决定依据见[章节研究记录](../../../.agents/notes/implemented/feature/2026-09-03-bid-section-research-blueprint.md)。

## S2–S5 quality control

After initial extraction, S2 requires the same live Agent to perform a Coverage Audit. The Validator separately reports missing Artifacts, JSON syntax failures, and strict Schema failures, retaining exact field paths for Schema issues. The Executor uses the latest Issues for a configurable number of Repair rounds, allows only `grep`, `read`, and `write`, and permits overwriting only the four formal S2 Artifacts. The Orchestrator advances to `tender_analysis/waiting_user` only after the final Validator passes.

S3 performs independent semantic response-point review and outline quality review. Validators check strict files, stable catalog ownership, tree structure, known IDs, coverage, and exact framework references; they do not replace semantic review with string splitting, title heuristics, or global response-point uniqueness.

S4 与 S5 共用 `buildWritableSectionWorklist`。初始研究按顶层业务分支分组；唯一根目录下的结构分支各成一批，直属可写叶子合为一批，保持 Host 并发上限。Child 同时提交 Evidence、writing_dimensions、完整 writing_brief 和基于现有 `outlineEditOperationSchema` 的分支内增量目录操作；Host 校验操作范围、合并分支、分配稳定 Section ID 并将 brief 写入 Outline。正式 Evidence Map schema v10 保持不变。

S4 启动 Child 前复检成功解析的 reference/reference_bid Corpus；损坏文件以 `EVIDENCE_MAPPING_CORPUS_INVALID` 报告文件身份与原因。Prompt 使用 `F1` 等运行内短引用和绝对 Corpus 路径，Host 按定位表精确回填正式 file_id/source_kind。grep 可访问分块目录或登记分块，read 可访问索引或登记分块；Final Check 还可读取已登记 Web 正文。tender、outline_framework、完整 document.md 与项目外路径不被授权。本地 Evidence 验证文件角色、分块归属和路径安全，不要求 Child read 日志证明。

每个 S4 Child 使用仅在当前 Child 生效的 `submit_evidence_mapping` 工具提交结论。Host 按 Task 生成严格参数 Schema，限定当前 task_id、现有及本任务预留 section_id、可见 file_ref、材料角色允许的 usage、分支目录操作和 Final Check 分支摘要，并拒绝额外字段。参数错误以 ToolArgsError 返回模型，在当前回合内重新提交；只有成功写入权威工具结果的参数进入 Host 校验，普通文字回复不作为结果。正式 `analysis/evidence-map.json` 仍使用 schema v10，S5 不读取 S4 私有执行状态。

成功的结构化提交继续接受章节覆盖、目录操作范围、分块归属、Web 正文快照、Writing Brief 和 Final Check 汇总等语义校验；只有这些问题或未调用提交工具才最多在同一 Child 修复一次，并保留已检索上下文。执行日志 schema v3 以 `issues` 记录本次拒绝原因，以 `warnings` 记录不阻塞接收的本次检索错误；接受的 attempt 不得保留 issues，错误也不复制到后续 attempt。单条无效材料不丢弃同章有效材料，missing_topics 只表示检索并语义判断后仍存在的真实缺口。分支修复耗尽时阶段失败，已接受分支及其目录操作写入 `analysis/evidence-mapping-checkpoint.json`；重试只调度未完成任务。Host 以同一串行写入队列先保存 Web 快照和 checkpoint，再发布 completed 日志状态。用户取消、Host 持久化或权限机制故障仍可中止阶段。

目录深化与各分支资料研究在同一 Child 内完成；`outline_operations` 只传输新增、拆分、合并、移动或字段调整，无需复制完整子树。Host 合并并校验各分支结果后，启动一个无工具、不可继续派生的全新目录复核 Child；该 Child 只接收合并后的目录候选并以结构化结果返回质量报告，不继承主 Session 历史，也不读取 Evidence、Web 正文或 S2 Artifact。后续 Final Check 以 `section_mappings` 提交变化章节，以 `unchanged_section_ids` 声明复用章节，两者必须无重复地覆盖最终可写章节；Host 恢复完整结果后仍写出 evidence-map v10。

S4、S5 的 Agent 按 web_search → web_fetch → 阅读正文研究新的公开资料；已登记候选正文可复用。共用 `buildWebEvidenceSnapshots` 只根据真实成功 fetch 的 HTTP(S) URL、HTTP 2xx 和非空正文生成本地 Snapshot 与正文 SHA-256。Web ledger schema v2 不保存工具调用关联；URL 与正文哈希确定 source ID，同 URL 不同正文分别保存。最终确认按引用裁剪 ledger 和无用快照。

S5 读取 `analysis/evidence-map.json`、`analysis/web-evidence-sources.json` 和 `outline/confirmed-outline.json`，按既定 Blueprint 组织正文，不重新规划章节目标或拆章。Writer 优先使用 S4 Evidence，遇到具体资料缺口时可在全部成功解析的 reference/reference_bid/outline_framework 及登记 Web Snapshot 中有限 grep/read；相邻分块按索引读取，tender 始终禁止。补搜实际使用的资料写入当前 Chapter Metadata，不回写已确认 S4 Evidence Map；framework 保持草稿身份，不作事实 Evidence。

S5 执行计划使用当前 `CHAPTER_EXECUTION_SCHEMA_VERSION`；强依赖包含章节 ID 与原因，每章包含 `planning_notes`。计划与 Writer 候选的严格校验失败会保留字段路径和要求供模型修复。Writer 和 Reviewer 都是 Main Agent 的一层子代理，绝对深度上限为 1；Reviewer 不开放资料检索或委派工具。

Reviewer 接收当前项目事实与章节相关输入；引文提交为当前候选的原文选项编号，Host 回填完整原文并保留 Markdown 标记，模型无需逐字重抄。编号和原文对照随 Reviewer 输入记录，正式报告仅保存原文。报告字段或引用无效时，Host 在同一正文上按 `modelStageRepairAttempts` 重试 Reviewer；只有有效报告中的内容问题才交给 Writer。修复预算用尽也不保存无效报告或将章节标记为完成。

Reviewer 宣称 `pass` 但同时记录未覆盖项、阻塞问题、旧项目污染或占位内容时，Host 将结论收紧为 `repair` 并保留具体缺口，交给 Writer 修订；第二轮仍有内容缺口时按 `needs_attention` 保存，其他章节继续执行。

Writer 的结构化提交限定当前已解析资料的完整 ID、对应类型和允许用法。截断 ID、框架冒充参考资料以及普通资料的复用用法会在提交工具内被拒绝，模型可在当前写作会话中修正；Host 仍校验实际资料与分块。

Writer 或 Reviewer 异常结束时，执行日志和阶段失败消息保留 Provider 提供的安全诊断，便于区分模型服务故障与产物校验问题。

S5 将 `execution-log.json` 作为章节级检查点。模型流断开或结果通道错误会使用独立运行重试预算，不占内容修订次数；单章最终失败不会取消无关章节。阶段重试会严格校验原计划、日志、正文、metadata、Reviewer 报告、内容哈希和 Child 身份，保留有效的 completed 章节，只重新排队 failed、running 和 pending 章节。重试不会删除章节文件；显式阶段重置才执行清理。

Writer 在缺少真实项目数量、人员、设备或记录值时只保留正式字段和填写规则，不生成示例数据行。Reviewer 不得要求虚构或示例值，并把已填的“示例、待补、XXX、最终填写”等内容视为占位。

S5 uses `outline/confirmed-outline.json` as its only structure source. Each Writer receives its Section, related S2 records, stable response points, Section evidence, exact framework draft chunks referenced by that Section, and bounded dependency handoffs. Framework bodies are writing input for preservation, adaptation, or rewriting, never factual Evidence. The Reviewer receives only Host-injected data and structured output. Missing enterprise facts remain unresolved and cannot be replaced by Web sources.

阶段重置不会自动开始执行。Host 会先取消并等待当前 Agent 树静止，清理目标阶段及其后续 Artifact，再将 S2–S5 置为 `waiting_start`；用户通过 UI 的“开始本阶段”或 `/bid-start` 明确确认后，才进入该阶段的正常执行路径。重启后内存执行记录缺失也不会跳过 Agent drain。

### Inventory text

#### What the model sees

The caller persists `messageInventory()` as a user message containing each file's name, workspace-relative source, parsed-document and structure paths, and parse status. Document bytes and absolute host paths never enter this text. The paths let the model use the existing `grep` and `read` tools.

#### Token effect

The bounded inventory adds one fixed set of lines per imported file. Extracted document text enters context only when the model reads it.

#### KV Cache effect

The persisted inventory is append-only conversation content. Importing files in a later user message does not change the earlier request prefix.

## Known Limitations and Deferred Work

- PDF extraction does not perform OCR or full table reconstruction; positioned rows remain separate when columns cannot be recovered safely.
- DOC extraction preserves text, paragraph breaks, list markers, and tab-separated table cells but not all binary Word styling.
- DOCX and DOC page fields remain `null` because their source structures do not provide dependable pagination.
- DOCX export supports headings, paragraphs, lists, and tables; it does not apply a company Word template.
- S5 receives cancellation only from its owned execution failure path; wiring parent-session stop signals into the chapter controller remains pending.

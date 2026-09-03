# `@deepseek-ai/dsh-bid`

English | [中文](README.zh.md)

Workspace-local intake and shared bid control-plane types for the bid-writing profile. `BidWorkspace` saves supported PDF, DOCX, DOC, XLSX, XLS, TXT, and Markdown files below `.bid-harness/sessions/<session>/`. Every imported file receives `corpus/<stored-name>/document.md`; PDF, DOCX, and DOC additionally receive `structure.json` and `metadata.json` from `extractDocument()`. Manifest version 3 records the corpus and artifact paths. The caller persists `messageInventory()` with the user's request, so the agent sees workspace-relative source, document, chunk, and structure paths and can use its normal `grep` and `read` tools.

PDF, DOCX, and DOC share one parser entry:

```ts
import { extractDocument } from '@deepseek-ai/dsh-bid'

await extractDocument({
  sourcePath: './workspace/input/招标文件.pdf',
  outputDir: './workspace/corpus/招标文件.pdf',
})
```

PDF extraction uses text positions to retain physical lines and emits `<!-- page: N -->` comments. Text-free PDFs write their corpus with `needs_ocr`; this package does not run OCR. DOCX extraction retains Word headings, lists, and tables without inventing page numbers. DOC extraction uses the pure-JavaScript `word-extractor` parser, so Windows, macOS, and Linux require no Word, LibreOffice, `antiword`, or other system executable. DOC text retains paragraphs and tab-separated table cells, but the binary format does not expose dependable Markdown heading levels or page numbers through this parser.

Import rejects empty, unsafe, unsupported, oversized, and over-count uploads. A parse failure retains the original file and records the stable extraction error in `manifest.json`. Reusing an extraction output directory atomically replaces the three complete corpus files through `dsh-atomic-write`. `exportDocx()` accepts only session-local Markdown and writes under the session output directory.

## Control plane types

The package exports the fixed `BidStage` and `StageRunStatus` values plus `BidRuntimeState`, `BidStagePolicy`, `BidStageTask`, `StageArtifact`, and `StageValidationResult`. The browser-safe `@deepseek-ai/dsh-bid/control-plane` subpath additionally exports `BidClientProjection`, the `BidUploadFile` request and `BidFileIntakeResult` response, its Host-admitted action list, and composer capability without loading document parsers or Node modules. `BID_STAGES` and `STAGE_RUN_STATUSES` are the runtime enumerations for validators and clients; their derived union types prevent a second stage or status vocabulary.

The five `bid.*` records declaration-merge into the existing `@deepseek-ai/dsh-session` `SessionEventMap` and remain log-only. They record stage transitions, workspace artifact references, failure reasons, and user confirmations without storing document or generated-content bodies.

## Control plane runtime

`BidOrchestrator` binds one DSH Session and restores state from `Session.events` through the sole `reduceBidRuntimeState()` reducer. `runCurrentProgramStage()` executes the pending or failed program-owned stage once. `drive()` follows each current `StagePolicy` while the Executor reports `canExecute(stage)`, and stops at user input, an unsupported pending stage, failure, or final completion. Fresh file intake waits for the dedicated upload action because its executor requires the admitted file batch. `retry()`, `confirm()`, `admitAction()`, and `admitPrompt()` enforce state and permissions on the Host.

`registerBidRuntimeProjection()` registers the same reducer as the `bid.runtime` DSH Session Projection. Its `BidClientProjection` exposes only Host-admitted actions, composer capability, and Host-configured file limits. The fixed stages are S1 material upload, S2 tender analysis, S3 initial outline generation, S4 outline generation / material mapping, S5 body writing, and S6 bid document export.

The browser sends one ordered, same-origin binary S1 request whose body contains the original selected file streams and whose small headers carry their names, roles, types, and sizes. The Host resolves the live Session from that request, admits the complete batch under a per-Session lock, imports through `BidWorkspace`, validates the resulting `manifest.json`, input, corpus, chunk index, and chunks, then calls `drive()`. A body that cannot reconstruct every declared file records S1 as failed and cannot advance it. The Host also calls `drive()` on `agent/session-start`, so creation and resume use the same log-derived continuation.

S2 writes only Project, Requirements, Scoring, and Compliance; scoring text stays whole and contains no response-point field. S3 independently reviews semantically derived response points, lets the Host assign stable `RP-*` identities, adapts optional framework trees, stores exact framework heading references, generates an initial outline, and owns its first user confirmation. One response point may belong to multiple writable Sections. S4 按目录业务分支分批研究资料，一个 Task 可包含多个 Section。一轮映射后深化一次目录，Host 按 Section ID 对齐 Evidence，再交用户确认。

In S5, the Host schedules independent Writers from the confirmed outline and makes each valid body available before its Reviewer starts. A review repair receives at most one new Writer attempt. If the second review still reports problems, the durable review remains `needs_attention` and does not block the book or S6 export.

## Model Experience

## S2–S5 quality control

After initial extraction, S2 requires the same live Agent to perform a Coverage Audit. The Validator separately reports missing Artifacts, JSON syntax failures, and strict Schema failures, retaining exact field paths for Schema issues. The Executor uses the latest Issues for a configurable number of Repair rounds, allows only `grep`, `read`, and `write`, and permits overwriting only the four formal S2 Artifacts. The Orchestrator advances to `tender_analysis/waiting_user` only after the final Validator passes.

S3 performs independent semantic response-point review and outline quality review. Validators check strict files, stable catalog ownership, tree structure, known IDs, coverage, and exact framework references; they do not replace semantic review with string splitting, title heuristics, or global response-point uniqueness.

S4 与 S5 共用 `buildWritableSectionWorklist` 的目录遍历。Host 私有 plan schema v5 按顶层业务分支分组；唯一根目录下的结构分支各成一批，直属可写叶子合为一批。每个 Task 的 `section_ids` 包含本批章节，每个可写 Section 恰好属于一个 Task。Evidence Map schema v10 以 `section_id` 为身份；最终只检查可写章节覆盖、未知 ID 和重复 ID，不检查标题、父级或写作提示的指纹。

S4 启动 Child 前复检成功解析的 reference/reference_bid Corpus；损坏文件以 `EVIDENCE_MAPPING_CORPUS_INVALID` 报告 file_id、文件名与原因。Prompt 与 Guard 共用绝对路径。grep 可访问分块目录或登记分块，read 可访问索引或登记分块；tender、outline_framework、完整 document.md 与 Session 外路径不被授权。本地 Evidence 验证文件身份、角色、分块存在和文件归属、路径安全，不要求 Child read 日志证明。

普通 Mapping 最多在同一 Child 修复一次。无资料、无搜索结果、fetch 失败、无效材料和 Child 异常均以章节 `missing_topics` 降级；有效的同批章节和其他 Task 继续执行。不可解析的章节保留空材料。用户取消、Host 持久化或权限机制故障仍可中止阶段。执行日志记录每次结果和诊断，进度中的 supplemental 数量固定为 0。

Outline Refinement 在一轮映射后执行一次目录深化与复核，模型产物问题共用 `maxRepairAttempts`。Host 对深化目录执行 deterministic reconcile：保留同 ID Evidence，新增章节建立空材料与缺口，删除章节移除对应 Evidence；可写章节拆为子章节时，子章节继承最近祖先的原资料，并在 `missing_topics` 提示 S5 重新筛选和补充。最终用户编辑执行同一 reconcile，不创建 Mapping Child。确认文件在目录和 Evidence 集合校验后发布。

S4、S5 的 Agent 仍按 web_search → web_fetch → 阅读正文研究公开资料。共用 `buildWebEvidenceSnapshots` 只根据真实成功 fetch 的 HTTP(S) URL、HTTP 2xx 和非空正文生成本地 Snapshot 与正文 SHA-256。Web ledger schema v2 不保存 search/fetch call ID、事件序号或搜索结果关联；URL 与正文哈希确定 source ID。来源只绑定当前 Child 实际抓取的正文，同 URL 不同正文分别保存。最终 reconcile 按引用裁剪 ledger 和无用快照。规则取舍见[资料映射减法记录](../../../.agents/notes/implemented/simplification/2026-09-03-bid-evidence-mapping-reduction.md)。

S5 继续读取 `analysis/evidence-map.json`、`analysis/web-evidence-sources.json` 和 `outline/confirmed-outline.json`。空 Evidence 合法，Writer 可按缺口自主补搜并抓取正文；已有材料按当前章节重新筛选。Writer、Reviewer、DAG 与 Workbench 的职责保持不变。

S5 uses `outline/confirmed-outline.json` as its only structure source. Each Writer receives its Section, related S2 records, stable response points, Section evidence, exact framework draft chunks referenced by that Section, and bounded dependency handoffs. Framework bodies are writing input for preservation, adaptation, or rewriting, never factual Evidence. The Reviewer receives only Host-injected data and structured output. Missing enterprise facts remain unresolved and cannot be replaced by Web sources.

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

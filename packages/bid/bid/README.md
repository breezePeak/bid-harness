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

`registerBidRuntimeProjection()` registers the same reducer as the `bid.runtime` DSH Session Projection. Its `BidClientProjection` exposes only Host-admitted actions, composer capability, and Host-configured file limits. The fixed stages are S1 file intake, S2 tender analysis, S3 outline generation, S4 evidence mapping, S5 chapter writing, and S6 DOCX export.

The browser sends one ordered, same-origin binary S1 request whose body contains the original selected file streams and whose small headers carry their names, roles, types, and sizes. The Host resolves the live Session from that request, admits the complete batch under a per-Session lock, imports through `BidWorkspace`, validates the resulting `manifest.json`, input, corpus, chunk index, and chunks, then calls `drive()`. A body that cannot reconstruct every declared file records S1 as failed and cannot advance it. The Host also calls `drive()` on `agent/session-start`, so creation and resume use the same log-derived continuation.

S2 writes only Project, Requirements, Scoring, and Compliance; scoring text stays whole and contains no response-point field. S3 independently reviews semantically derived response points, lets the Host assign stable `RP-*` identities, adapts optional framework trees, stores exact framework heading references, generates an initial outline, and owns its first user confirmation. One response point may belong to multiple writable Sections. S4 由 Host 按可写叶子生成一章一个任务，Child 负责资料判断，Main Agent 基于证据深化一次目录。Evidence Map schema v9 的每条 `section_mappings` 保存 Host 生成的 `section_fingerprint`；目录深化与最终用户编辑都只补映射新增或指纹变化的章节。

In S5, the Host schedules independent Writers from the confirmed outline and makes each valid body available before its Reviewer starts. A review repair receives at most one new Writer attempt. If the second review still reports problems, the durable review remains `needs_attention` and does not block the book or S6 export.

## Model Experience

## S2–S5 quality control

After initial extraction, S2 requires the same live Agent to perform a Coverage Audit. The Validator separately reports missing Artifacts, JSON syntax failures, and strict Schema failures, retaining exact field paths for Schema issues. The Executor uses the latest Issues for a configurable number of Repair rounds, allows only `grep`, `read`, and `write`, and permits overwriting only the four formal S2 Artifacts. The Orchestrator advances to `tender_analysis/waiting_user` only after the final Validator passes.

S3 performs independent semantic response-point review and outline quality review. Validators check strict files, stable catalog ownership, tree structure, known IDs, coverage, and exact framework references; they do not replace semantic review with string splitting, title heuristics, or global response-point uniqueness.

S4 与 S5 共用 `buildWritableSectionWorklist` 的目录遍历。Host 私有 plan schema v4 保存确定性的任务 ID、initial/supplemental 阶段、唯一 Section ID、真实标题路径、Section 指纹与目录摘要。主 Agent 不生成任务计划。最终确认要求可写 Section 集合与 Evidence Mapping 集合完全相等且指纹一致；祖先标题变化使后代证据过期，兄弟排序变化可以复用证据。补映射与 Validator 完成后才发布 `confirmed-outline.json` 和 S5 所需的 `confirmation.json`。

S4 启动 Child 前复检成功解析的 reference/reference_bid Corpus；损坏文件以 `EVIDENCE_MAPPING_CORPUS_INVALID` 报告 file_id、文件名与原因。Prompt 与 Guard 共用预检后的绝对路径，支持工作目录与 Session 目录不同的 Windows/POSIX Host。grep 可访问分块目录或登记的分块文件，read 仅可访问索引或登记的分块文件；tender、outline_framework、完整 document.md 与 Session 外路径不被授权。本地证据还必须有当前 Child 成功 read 正文的日志。

没有可靠资料是正常结果，以空材料和 `missing_topics` 表达。JSON、Schema、章节归属和材料引用问题可以在同一 Child 有限修复；Corpus、工具、Provider、文件系统与结果关联异常立即失败，不发送模型 repair。执行日志保存失败分类及 initial/supplemental；页面分别显示两类任务数量。

S4 的每个 Mapping Task 在同一 Child Session 内修复，Web 来源校验读取该 Child 各轮次的真实工具结果。搜索结果必须包含抓取 URL，且搜索返回早于抓取调用、抓取调用早于成功返回；修复可以复用前一轮搜索，但不能借用其他任务的搜索或抓取。Host 按 Session ID 关联恢复前后的 Agent，最终章节中的 Web material 始终绑定产生该 material 的任务自己的 Snapshot；补充映射替换章节时也同步替换来源。重复的无效 URL 按规范化结果只报告一次，最终仍验证 ledger、Snapshot 文件及正文哈希。

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

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

`registerBidRuntimeProjection()` registers the same reducer as the `bid.runtime` DSH Session Projection. Its `BidClientProjection` exposes only Host-admitted actions, composer capability, and the Host-configured `allowedExtensions`, `maxFiles`, `maxFileBytes`, and `maxTotalBytes` limits. The Host plugin registers this projection and globally rejects generic prompt admission for sessions whose resolved preset is `bid`.

The generated `bid/uploadFiles` Remote resolves the live Session and uses only its Host-resolved preset and `header.cwd`. It admits the complete browser batch under a per-Session lock, decodes canonical base64 after checking declared limits, imports through `BidWorkspace`, validates the resulting `manifest.json`, input, corpus, chunk index, and chunks, then calls `drive()`. The Host also calls `drive()` on `agent/session-start`, so creation and resume use the same log-derived continuation. The production Executor supports Tender Analysis, Evidence Mapping, and Outline Generation. S4 reads S2 Artifacts and the evidence map through the live Agent, then writes `outline/outline.json`: a strict flat `parent_id`/`order` tree of structural and independently writable sections. Writable sections have focused `must_answer` guidance and Requirement, Scoring, and Compliance references; evidence remains in S3 and only informs short writing notes. The Validator rejects invalid trees, unknown or omitted identifiers, empty structural nodes, and mandatory or priority items that do not reach a writable section. S5 reads that draft only while `outline_confirmation/waiting_user`, applies browser edit operations without accepting browser-controlled mapping IDs, validates tree and coverage rules, then atomically writes `outline/confirmed-outline.json` and `outline/confirmation.json`. The confirmation record stores only the decision and SHA-256 values for the draft and confirmed artifacts. Successful confirmation advances to `chapter_writing/pending`; S4 does not perform a new evidence search or web research.

The package provides the file-intake program Executor and Validator plus Tender Analysis and Evidence Mapping execution and validation. S2 writes only technical-bid Requirements, Scoring, and Compliance items; commercial, qualification, and price-only material never reaches S3. S3 reads those Artifacts and the manifest, then independently decides whether local chunks, Web research, or an unresolved topic best supports the current project. Evidence Map schema v3 keeps complete Requirement and Scoring mappings plus Agent-authored `research_topics` for project-level and cross-item findings that can affect S4 structure. Each local material identifies an indexed `reference`-role chunk, inclusive lines, a `reuse`, `adapt`, `reference`, or `background` use, and a summary. Every external material must still originate from S3's current `web_search` to successful `web_fetch` sequence, Host ledger, snapshot, and SHA-256 record. The Validator verifies S2 coverage, research-topic links, local material integrity, and each external source before the Host advances the stage. S4 receives findings and writing dimensions as structural inputs without gaining Web access.

S6 从已确认目录生成有序工作清单，并为每个可写章节顺序调用一次 live DSH Agent。每章只接收当前 Blueprint、相关 S2 记录、S3 本地与外部 Evidence、缺失主题及紧凑项目上下文；已有资料不足时先执行当前章节本地检索，仅对仍缺少的公开技术知识执行 `web_search` 后 `web_fetch`。Agent 只写当前 Markdown 正文与 Metadata sidecar，Executor 校验本章新增外部来源均来自本次已记录的 Search-to-Fetch 链，再统一重建 Schema v2 `chapters/manifest.json`。Metadata 和 Manifest 分别保存 S3 本地 Evidence、S6 新增本地 Evidence、S3 外部 Evidence、S6 新增外部 Evidence 及未解决主题。Validator 要求完整覆盖可写章节、正文和 Metadata 路径与遍历顺序一致、正文非空且非链接、confirmed-outline 哈希与章节映射一致、本地 Evidence 指向已索引行范围，并要求章节使用的 S3 Evidence 属于当前 Requirement 或 Scoring Mapping。重试 S6 时先删除旧 `chapters/` 树。

## Model Experience

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

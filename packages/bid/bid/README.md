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

The browser sends one ordered, same-origin binary S1 request whose body contains the original selected file streams and whose small headers carry their names, roles, types, and sizes. The Host resolves the live Session from that request, admits the complete batch under a per-Session lock, imports through `BidWorkspace`, validates the resulting `manifest.json`, input, corpus, chunk index, and chunks, then calls `drive()`. A body that cannot reconstruct every declared file records S1 as failed and cannot advance it. The Host also calls `drive()` on `agent/session-start`, so creation and resume use the same log-derived continuation. S4 reads S2 Artifacts and the evidence map through the live Agent, writes `outline/outline.json`, and applies shared tree and coverage rules plus generation-only Blueprint quality rules. S5 initializes `outline/draft.json` from that successful S4 result and treats its revision, source hash, draft hash, and Outline as the durable source of truth. Browser mutations use revision-and-hash CAS, Host-assigned `SEC-*` ids, and shared rules without rerunning S4 quality thresholds. Feedback regeneration reads the current draft, validates an Agent candidate with S4 quality and a deterministic change set, and replaces the draft only after every check succeeds. Confirmation persists and rereads the versioned confirmed Outline and confirmation record before recording the user decision.

S2 writes only Project, Requirements, Scoring, and Compliance; scoring text stays whole and contains no response-point field. S3 semantically derives response points, lets the Host assign stable `RP-*` identities, generates an initial outline, and owns its first user confirmation. S4 maps every writable initial-outline Section to local and Web evidence, then owns the final outline confirmation. Evidence Map schema v8 stores only `section_mappings`.

In S5, the Host schedules independent Writers from the confirmed outline and makes each valid body available before its Reviewer starts. A review repair receives at most one new Writer attempt. If the second review still reports problems, the durable review remains `needs_attention` and does not block the book or S6 export.

## Model Experience

## S2–S5 quality control

After initial extraction, S2 requires the same live Agent to perform a Coverage Audit. The Validator separately reports missing Artifacts, JSON syntax failures, and strict Schema failures, retaining exact field paths for Schema issues. The Executor uses the latest Issues for a configurable number of Repair rounds, allows only `grep`, `read`, and `write`, and permits overwriting only the four formal S2 Artifacts. The Orchestrator advances to `tender_analysis/waiting_user` only after the final Validator passes.

S3 performs semantic response-point analysis and outline quality review. Validators check strict files, stable catalog ownership, tree structure, known IDs, coverage, and unique response-point placement; they do not replace semantic review with string splitting or title heuristics.

S4 stores local evidence by exact `source_kind + file_id + chunk_XXXX` and Web evidence by a Host-owned Snapshot identity and hash. Every final writable Section occurs exactly once. Missing material is explicit in `missing_topics` and does not remove the Section.

S5 uses `outline/confirmed-outline.json` as its only structure source. Each Writer receives its Section, related S2 records, stable response points, Section evidence, and bounded dependency handoffs. The Reviewer receives only Host-injected data and structured output. Missing enterprise facts remain unresolved and cannot be replaced by Web sources.

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

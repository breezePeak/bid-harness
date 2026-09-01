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

`registerBidRuntimeProjection()` registers the same reducer as the `bid.runtime` DSH Session Projection. Its `BidClientProjection` exposes only Host-admitted actions, composer capability, and the Host-configured `allowedExtensions`, `maxFiles`, `maxFileBytes`, and `maxTotalBytes` limits. The Host plugin registers this projection and globally rejects generic prompt admission for sessions whose resolved preset is `bid`. `chapterWritingMaxConcurrency` limits simultaneous S6 Chapter Subagents to 3 by default and accepts values from 1 through 8.

The generated `bid/uploadFiles` Remote resolves the live Session and uses only its Host-resolved preset and `header.cwd`. It admits the complete browser batch under a per-Session lock, decodes canonical base64 after checking declared limits, imports through `BidWorkspace`, validates the resulting `manifest.json`, input, corpus, chunk index, and chunks, then calls `drive()`. The Host also calls `drive()` on `agent/session-start`, so creation and resume use the same log-derived continuation. S4 reads S2 Artifacts and the evidence map through the live Agent, writes `outline/outline.json`, and applies shared tree and coverage rules plus generation-only Blueprint quality rules. S5 initializes `outline/draft.json` from that successful S4 result and treats its revision, source hash, draft hash, and Outline as the durable source of truth. Browser mutations use revision-and-hash CAS, Host-assigned `SEC-*` ids, and shared rules without rerunning S4 quality thresholds. Feedback regeneration reads the current draft, validates an Agent candidate with S4 quality and a deterministic change set, and replaces the draft only after every check succeeds. Confirmation persists and rereads the versioned confirmed Outline and confirmation record before recording the user decision.

S2 writes only technical-bid Requirements, Scoring, Compliance, and the Host-owned stable response-point Catalog; commercial, qualification, and price-only material never reaches S3. The Catalog binds ordered `RP-*` identities to the canonical scoring hash while the existing scoring text arrays remain available to S6. S3 Evidence Map schema v5 maps every response-point ID and binds framework and reference-bid mappings to real extracted headings. Requirement, Scoring, response-point, research-topic, framework-content, and reference-bid-content materials all pass the same role, indexed Chunk, line-range, workspace-path, and linked-path validation. S4 and S5 carry both stable IDs and their scoring/text snapshots, and S7 resolves existing S6 text declarations back to those IDs for deterministic coverage reporting only.

In S6, the Main Agent analyzes only strong dependencies, weak relations, and global consistency requirements across all writable sections, and may write only `chapters/execution-plan.json`. After validating complete coverage, legal references, and an acyclic plan, the Host maintains a ready queue in stable confirmed-outline order and starts independent Child Sessions through `ctx.subagents.start('spawn', …)` up to the concurrency limit. A strongly dependent section starts only after its prerequisite candidate passes and receives only the prerequisite body, metadata, and dependency reason declared by the plan. Each Chapter Subagent receives only the current Blueprint, related S2/S3 records, missing topics, and consistency requirements. Its tools are restricted to `grep`, `read`, `web_search`, and `web_fetch`, its depth limit is 1, and it cannot write the workspace or create descendant Agents. The Child returns a Markdown and Metadata candidate through `outputSchema`; the Host validates Evidence, Search-to-Fetch records, and section mappings in memory before atomically writing the body and sidecar. A failed candidate is repaired in a new spawn Child, with no Main-Agent fallback. The Host writes `chapters/execution-log.json` with every Child Session, stop reason, and final accepted run before generating `chapters/manifest.json`. Retrying S6 removes the old `chapters/` tree and replans from scratch.

## Model Experience

## S2–S6 quality control

After initial extraction, S2 requires the same live Agent to perform a Coverage Audit. The Validator separately reports missing Artifacts, JSON syntax failures, and strict Schema failures, retaining exact field paths for Schema issues. The Executor uses the latest Issues for a configurable number of Repair rounds, allows only `grep`, `read`, and `write`, and permits overwriting only the four formal S2 Artifacts. The Orchestrator advances to `tender_analysis/waiting_user` only after the final Validator passes.

S3 searches local material first and runs `web_search → web_fetch` only for missing public technical knowledge. `external_materials` retains only public technical sources that appeared in the current attempt's search results, subsequently returned a non-empty 2xx body, and match the Host source ledger; they cannot replace local evidence for enterprise facts. Web content is untrusted research material. The Agent may write only `analysis/evidence-map.json`, while the Host writes the source ledger and snapshots. The Host prevalidates schema, ID coverage, local references, and external URL bindings, and repair tasks name the required `requirement_id` and `scoring_id`. Without network access, an empty Host ledger still permits local material or `missing_topics`. Missing tools or providers fail the stage explicitly; search failure, fetch failure, timeout, cancellation, non-2xx responses, and empty bodies produce no source. A general retry clears the old evidence map, ledger, and snapshots. Development Sessions containing external materials without a Host ledger must rerun S3. Validation does not prove summary derivation or source truth, and HTTP Fetch SSRF and private-network restrictions remain unresolved.

After the S4 draft, the same Agent must perform a Blueprint Quality Review and write the checked Requirements, Scoring items, and final sections to the internal `outline/quality-report.json`. The Host prevalidates both strict Artifacts and returns tree, reference-coverage, and quality-report issues to the same Agent for repair. Completion requires no unresolved report issues. Writable sections must also be leaves, sibling titles must be unique, and `must_answer` entries must neither repeat nor mechanically restate the title. A technical response index, deviation table, or compliance list cannot carry all body coverage centrally. S5 may confirm the current outline or submit non-empty revision comments. Revision comments are logged in the Session, become required input to the next S4 generation, and return the workflow to S5. Direct browser edits still undergo tree and reference-coverage validation.

In S6, the Main Agent writes only the relation plan. The Host validates it, schedules fresh-context spawn Children according to its strong-dependency DAG, and records every actual Child in the execution log. Each Child receives one section's inputs plus only accepted declared prerequisites, cannot write files, and returns a structured candidate for Host validation and atomic persistence. New spawn Children handle repairs; the Main Agent never writes fallback chapter content. Missing enterprise cases, qualifications, personnel, actual product parameters, or existing capabilities must remain in `unresolved_topics` and cannot be replaced with Web sources.

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
- S6 continues to use scoring response-point text pairs; stable response-point IDs are not part of the S6 Metadata format in this release.
- S7 verifies structured response-point declarations but does not perform detailed chapter-body semantic review.

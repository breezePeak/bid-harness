# Agent Note: Bid corpus document intake

Status: implemented

English | [中文](2026-08-28-bid-corpus-document-intake.zh.md)

## Problem

The bid workspace and the standalone document extractor parsed PDF and DOCX through separate implementations. Workspace imports wrote one Markdown file under `parsed/`, while the extractor wrote the `document.md`, `structure.json`, and `metadata.json` corpus expected by later filesystem search. DOC was accepted only by the standalone path and depended on an optional executable that was absent from ordinary Windows deployments.

## Decision

`BidWorkspace.import()` stores original bytes first, then sends PDF, DOCX, and DOC to `extractDocument()`. Each document owns `corpus/<stored-name>/`; manifest version 3 records its corpus, document, structure, metadata, and chunk paths. TXT, Markdown, XLS, and XLSX retain their deterministic conversion but publish `document.md` under the same corpus layout. `messageInventory()` projects workspace-relative document and structure paths, so the existing `grep` and `read` tools operate on the stored corpus.

PDF extraction groups text items by baseline and horizontal position before writing physical-page markers. Section page ranges advance with every page marker while a section remains open. DOCX conversion retains Mammoth's heading, list, and table HTML before normalization. DOC conversion uses the pure-JavaScript `word-extractor` parser and requires no system executable; its paragraph and tab-separated cell text is normalized without invented heading levels or pages. All three corpus files publish through `dsh-atomic-write`, including replacement of an existing output.

## Verification

Package fixtures include a two-page Chinese text PDF, a text-free PDF, a generated Chinese Word 97-2003 DOC with lists and table cells, and generated DOCX content with three heading levels, ordered and unordered lists, and a table. Tests cover corrupt inputs, repeated output publication, workspace DOC/DOCX intake, manifest paths, relative inventory text, and a real tool-registry round trip through the packaged `grep` binary and filesystem `read` tool.

## Alternatives considered

**Keep the workspace parsers and delegate only new callers to `extractDocument()`.** Rejected because fixes to layout recovery, OCR classification, or DOCX structure could diverge between ingestion and direct extraction.

**Keep `antiword` as the DOC parser.** Rejected because a required system executable makes the default Windows intake path unavailable and adds process, PATH, and encoding failure modes. The JavaScript parser trades detailed binary Word styling for portable text extraction.

**Create a document-specific search or chunk index.** Rejected because the corpus is ordinary UTF-8 text and the Harness filesystem tools already provide the required discovery and line-window reading behavior.

## Consequences

Every supported bid import has one corpus document path, and the three office-document formats share one production parser. DOC works on supported Node platforms without installation steps. Binary Word styling and complex PDF tables remain lossy, scanned PDFs require a later OCR stage, and DOC/DOCX pagination remains unknown. Earlier manifest versions are rejected instead of being interpreted through the current field set.

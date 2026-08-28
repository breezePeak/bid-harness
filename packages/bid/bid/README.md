# `@deepseek-ai/dsh-bid`

Workspace-local intake for the bid-writing profile. `BidWorkspace` saves supported PDF, DOCX, XLSX, XLS, TXT, and Markdown files below `.bid-harness/sessions/<session>/`, records a manifest, and writes deterministic Markdown extraction beside the original bytes. The caller persists `messageInventory()` with the user's request, so the agent sees only relative paths and reads content through its normal workspace tools.

Import rejects empty, unsafe, unsupported, oversized, and over-count uploads. Parsing one file failing retains its original file and records the error in `manifest.json`; scanned PDFs report that OCR is unsupported. `exportDocx()` accepts only session-local Markdown and writes atomically under the session output directory.

`extractDocument({ sourcePath, outputDir })` is the lower-level corpus converter for an existing local PDF, DOCX, or DOC. It writes `document.md`, `structure.json`, and `metadata.json` to the supplied output directory. PDF Markdown carries physical-page comments; DOCX and DOC page fields remain `null` because their source formats do not provide dependable pagination. DOC uses the optional `antiword` executable and reports `DOC_CONVERTER_NOT_AVAILABLE` when it is absent.

## Known Limitations and Deferred Work

- PDF extraction does not perform OCR.
- DOC extraction requires `antiword` to be installed and available on `PATH`.
- DOCX export supports headings, paragraphs, lists, and tables; it does not apply a company Word template.

# `@deepseek-ai/dsh-bid`

[English](README.md) | 中文

投标写作 profile 的工作区本地入库能力与共享控制面类型。`BidWorkspace` 把支持的 PDF、DOCX、DOC、XLSX、XLS、TXT 和 Markdown 文件保存在 `.bid-harness/sessions/<session>/` 下。每个入库文件都会获得 `corpus/<stored-name>/document.md`；PDF、DOCX 和 DOC 还会从 `extractDocument()` 获得 `structure.json` 与 `metadata.json`。Manifest 版本 3 记录语料和产物路径。调用方将 `messageInventory()` 与用户请求一起持久化，因此 agent 只会看到工作区相对的原文件、正文、分块与结构路径，并可使用常规 `grep` 和 `read` 工具。

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

本包导出固定的 `BidStage` 与 `StageRunStatus` 值，以及 `BidRuntimeState`、`BidStagePolicy`、`BidStageTask`、`StageArtifact` 和 `StageValidationResult`。browser-safe 子路径 `@deepseek-ai/dsh-bid/control-plane` 还会导出 `BidClientProjection`、Host 允许的 action 列表和 composer capability，而不会加载文档解析器或 Node 模块。`BID_STAGES` 与 `STAGE_RUN_STATUSES` 是供 validator 和 client 使用的运行时枚举；从它们派生的联合类型阻止出现第二套阶段或状态名称。

五类 `bid.*` 记录通过声明合并接入现有 `@deepseek-ai/dsh-session` `SessionEventMap`，且仅写入日志。它们记录阶段转换、工作区产物引用、失败原因和用户确认，不保存文档或生成内容正文。

## 控制面 Runtime

`BidOrchestrator` 绑定单个 DSH Session，并通过唯一的 `reduceBidRuntimeState()` 从 `Session.events` 恢复状态。`drive()` 按八个固定 `BidStagePolicy` 构建 `BidStageTask`，调用注入的 Executor Port 与 Validator Port，并自动执行到等待用户、失败或最终完成。`retry()`、`confirm()`、`admitAction()` 与 `admitPrompt()` 在后端执行状态和权限校验；用户拒绝目录不会推进阶段，用户接受目录也必须在 confirmation Artifact 通过 Validator 后才能继续。

`registerBidRuntimeProjection()` 把同一状态归约函数注册为 DSH Session Projection `bid.runtime`。Projection 返回 `BidClientProjection`，其中 `allowedActions` 与 composer 能力由 Host 生成；Client 不归约 Bid Event，也不根据 Stage 推导业务权限。`@deepseek-ai/dsh-bid/control-plane` 是不依赖 Node 文档处理库的 browser-safe 数据契约出口。

本包只定义控制面 Runtime 及其执行、校验 Port，不提供真实业务 Agent Executor、Tender Analysis Prompt 或具体 Stage Validator。

## Model Experience

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

# Agent Note: 投标语料文档入库

Status: implemented

[English](2026-08-28-bid-corpus-document-intake.md) | 中文

## Problem

投标工作区与独立文档提取器分别维护 PDF 和 DOCX 解析实现。工作区入库只在 `parsed/` 下写一个 Markdown 文件，而提取器会写出后续文件搜索所需的 `document.md`、`structure.json` 和 `metadata.json` 语料。DOC 只被独立路径接纳，并依赖普通 Windows 部署中通常不存在的可选可执行文件。

## Decision

`BidWorkspace.import()` 先保存原始字节，再把 PDF、DOCX 和 DOC 交给 `extractDocument()`。每份文档拥有 `corpus/<stored-name>/`；manifest 版本 3 记录语料目录、正文、结构、元数据和分块路径。TXT、Markdown、XLS 和 XLSX 保留确定性转换，但也在相同语料布局下发布 `document.md`。`messageInventory()` 投影工作区相对的正文和结构路径，使现有 `grep` 与 `read` 工具直接处理已存储语料。

PDF 提取在写入物理页标记前，按基线和水平位置组合文本项。章节处于打开状态时，每个页标记都会推进其页码范围。DOCX 转换在规范化前保留 Mammoth 生成的标题、列表和表格 HTML。DOC 转换使用纯 JavaScript 的 `word-extractor`，不需要系统可执行文件；它会规范化自然段和制表符分隔的单元格文本，不伪造标题层级或页码。三个语料文件都通过 `dsh-atomic-write` 发布，包括替换已有输出。

## Verification

包内 fixture 包括两页中文文字 PDF、无文字 PDF、包含列表和表格单元格的生成式中文 Word 97-2003 DOC，以及包含三级标题、有序与无序列表和表格的生成式 DOCX。测试覆盖损坏输入、重复发布输出、工作区 DOC/DOCX 入库、manifest 路径、相对 inventory 文本，以及通过内置 `grep` 二进制与文件系统 `read` 工具完成的真实工具注册表往返。

## Alternatives considered

**保留工作区 parser，只让新调用方委托给 `extractDocument()`。** 拒绝，因为版面恢复、OCR 分类或 DOCX 结构修复可能在入库和直接提取之间再次分叉。

**继续用 `antiword` 解析 DOC。** 拒绝，因为必需的系统可执行文件会使默认 Windows 入库路径不可用，并引入进程、PATH 和编码失败模式。JavaScript parser 以减少二进制 Word 样式保真度换取可移植的文本提取。

**创建文档专用搜索或 chunk 索引。** 拒绝，因为语料是普通 UTF-8 文本，Harness 文件系统工具已经提供所需的发现与按行窗口读取行为。

## Consequences

每个受支持的投标入库文件都有一个语料正文路径，三种 Office 文档格式共享唯一生产 parser。DOC 在受支持的 Node 平台上无需安装步骤即可工作。二进制 Word 样式和复杂 PDF 表格仍会有损，扫描 PDF 需要后续 OCR 阶段，DOC/DOCX 分页仍为未知。系统会拒绝更早的 manifest 版本，不会用当前字段集合解释旧格式。

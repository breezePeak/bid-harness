# Agent Note: 系统默认 Word 模板唯一真源

Status: implemented

## Problem

系统默认 Word 导出以随包发布的 DOCX 为骨架，格式页、浏览器预览和页数测算却从 `DEFAULT_BID_CONFIG` 构造另一套 baseline。旧项目持久化的 baseline 还会继续覆盖模板更新，导致同一个默认选项在界面、测算和最终文件中使用不同字体、字号、段落和页面结构。

## Decision

`assets/templates/default-technical-bid.docx` 同时拥有系统默认模板的 OOXML 骨架和可解析格式。每次读取 `templateId === null` 时，Host 重新解析该文件，以 `defaultDocxFormatState()` 仅补齐字段集合，再通过 `resolveFormat()` 叠加持久化的 `userConfirmed`。`default.config.json` 只延续 revision、opened、用户覆盖和最近导出记录；其中旧的 extracted、模型解释、冲突及 resolved baseline 不进入读取结果。

格式表和浏览器预览读取这份 resolved。LibreOffice 真实分页与正式导出共用模板合成入口：系统默认选择读取内置 DOCX，上传模板读取其内容摘要命名的原始文件。真实分页缓存除正文、图片、格式版本和 resolved 外还包含原始模板内容摘要，内置文件更新会自然失效旧结果。快速页数仍是固定 A4 的交互近似。

本记录修正[项目 Word 模板库与真实分页](../feature/2026-09-12-bid-word-template-library-and-rendered-pages.md)中真实分页从零渲染固定 A4 的选择，并扩展[Word 模板原位合成](../feature/2026-09-14-word-template-first-composition.md)的共享范围；两份记录继续分别拥有模板库和 OOXML 合成规则。

## Alternatives considered

**把 `DEFAULT_BID_CONFIG` 改成当前内置模板的字体和字号。** 不采用；复制出的常量无法覆盖页面、编号、题注和后续模板更新，会继续形成第二真源。

**只在首次读取时把解析结果写入 `default.config.json`。** 不采用；随包模板更新后旧项目仍会沿用陈旧 baseline，必须另建迁移判断。

**保留真实分页的无模板 A4 Renderer。** 不采用；该结果漏掉封面、TOC、技术偏离表和模板分节，不能代表当前选择的最终 DOCX。

## Consequences

内置模板更新会同步改变系统默认格式、预览、真实分页和导出，不需要识别某个历史字体或删除项目文件。用户确认值及导出记录跨更新保留；不再保留系统 baseline 的项目级快照。真实分页包含模板固定内容和分节，因此与快速近似可能出现更大差异，但其输入与最终导出的模板链路一致。

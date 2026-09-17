# Agent Note: Word 导出图下表上排版、图号去重与题注样式重映射

Status: implemented

## Problem

DOCX 导出渲染流程图时先生成图题段落、后生成流程图图片，与常规公文“图下表上”规范相反；图题段落同时启用了 Word 原生列表编号并在文本运行（TextRun）中重复拼接了计数器生成的前缀，导致 Word 中显示重复图号（如“图 1 图 1 项目实施组织架构图”）。此外，模板原位合成阶段只重映射了标题与正文样式，遗漏了图题与表题样式重映射，且未声明独立的图题样式 ID，导致生成的题注段落回退继承模板正文的靠左对齐与首行 2 字符缩进。

## Decision

`renderDocx()` 将流程图生成顺序调整为先图片段落、后图题段落，图片段落携带 `keepNext: true` 避免跨页断裂；流程图图题文本去除 `${caption}` 重复拼接，直接使用 `spec.title`；HTML 预览同步将 `<figure>` 结构调整为 SVG 在前、`<figcaption>` 在后。图题与表题段落在 `firstLine` 为 0 时显式输出清零缩进属性。

DOCX 渲染器显式注册 `DshFigureCaption` 图题样式与 `DshTableCaption` 表题样式，并在原生题注编号定义中使对齐属性跟随题注格式配置；`composeDocxFromTemplate()` 的 `mappedStyle()` 增加对 `DshFigureCaption` 和 `DshTableCaption` 的识别，分别重映射为模板目标图题（`figureCaption`）和表题（`tableCaption`）样式。

## Alternatives considered

**在 S5 撰写阶段强制输出图题位置。** 不采用；S5 专注于语义内容与流程图元数据定义，文档排版与展示格式应由导出渲染器与模板合成统一保证。

**保留 Word 原生编号但在 TextRun 中保留完整标题。** 当前方案即通过 Word 原生编号提供序号，去除 TextRun 中的重复前缀；若完全放弃 Word 原生编号改用纯文本，则在 Word 中增删图表时无法利用 Word 字段能力自动更新。

## Consequences

导出的 Word 中流程图符合“图下表上”规范，图编号不再重复显示；带模板导出时图题与表题正确匹配模板设置的居中对齐与 0 字符缩进格式。定向回归固定流程图在 DOCX 中的部件顺序、图号无重复前缀及模板题注样式补齐。

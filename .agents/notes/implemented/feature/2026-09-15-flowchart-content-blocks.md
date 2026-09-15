# Agent Note: 流程图作为章节结构化正文内容

Status: implemented

## Problem

S5 章节正文原先只持久化 Markdown，流程图如果在 S6 临时生成就无法被 S5 预览、审核或局部修改，也会让导出阶段重复理解正文。

## Decision

章节 metadata 现在可持久化 `flowcharts`，每项是带 `type`、schema version、Host 分配的 `FLOW-*` 身份、节点和连线的结构化 FlowchartSpec。Writer 只提交节点 key 和语义，Host 负责生成身份、校验节点引用、分支和规模，并在旧 metadata 缺少该字段时使用空数组。

S5 正文详情和 S6 DOCX 共用无外部资源的确定性 SVG renderer。S6 通过内部 `flowchart` Markdown 块把已保存的 FlowchartSpec 交给 renderer，不再次调用模型；DOCX 使用 SVG 图片并提供显式 PNG fallback。

Visio OLE/COM 没有在当前跨平台包中伪造实现。需要 Windows + Office/Visio 的真正可编辑对象时，由独立平台 backend 负责，portable 环境继续使用 SVG/PNG 降级。

## Alternatives considered

**把流程图只存为 SVG/PNG。** 未采用，因为图片不能支持正文审核、局部修改或后续可编辑导出。

**让 S6 重新调用模型生成流程图。** 未采用，因为会破坏 S5 的权威结构、增加成本并造成导出不稳定。

**在本次跨平台包中手写 OLE 或伪造 Visio 文件。** 未采用，因为没有可靠的 Office/Visio运行时就无法保证双击编辑语义，伪装成可编辑比明确降级更危险。

## Consequences

旧章节和旧 session 继续按 Markdown 工作；新章节可以在 S5 直接看到结构化流程图。当前流程图预览按章节正文之后显示，精确正文位置、主 Agent 局部修改命令和 Windows 原生 Visio backend 仍是后续增量能力。

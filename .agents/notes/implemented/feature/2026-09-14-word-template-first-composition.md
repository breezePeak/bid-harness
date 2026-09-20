# Agent Note: Word 模板原位合成

Status: implemented

## Problem

Word 导出只把模板解析成格式值，再由 Renderer 新建文档。生成结果因此无法保留模板封面、固定文字、页眉页脚、分节、合并单元格和图片；S5 页数又会受模板纸型与方向影响，无法提供统一的篇幅基准。

## Decision

S5 继续从页数基准模板读取页边距、字体、字号、行距、段距、缩进、标题及表格文字格式。快速估算固定使用纵向 A4；LibreOffice 真实分页按[系统默认 Word 模板唯一真源](../bug-fix/2026-09-20-system-default-docx-single-source.md)与正式导出共用所选模板的原位合成结果。

S6 显式模板以 `word-export/templates/{hash}.docx` 的原始字节为最终包骨架，系统默认模板以随包发布的 `assets/templates/default-technical-bid.docx` 为骨架。`buildDocxFromResolvedTemplate()` 为真实分页和正式导出选择同一原始文件，再由 `composeDocxFromTemplate()` 把 S5 Markdown 渲染成单节 OOXML 内容，复制正文引用的样式、编号、关系和图片，并通过 `applyTemplateContent()` 插入正文内容控件、书签、占位段落或末节属性之前。模板原有 ZIP 部件、正文固定块和节属性不重建；系统默认模板不从零新建文档。

`inspectDocxTemplateStructure()` 用内容控件标签、书签和占位文字识别正文锚点。默认模板用稳定 tag 标出封面字段、真实 TOC 字段、技术偏离表及正文位置；封面由程序读取项目事实和 `bidderName` 配置填充，不进入 Writer。S3 确认边界把技术偏离表规范为固定第一章并拒绝“目录”节点，第二章以后保留确认目录。表格使用表头语义与 `tblGrid`、`gridSpan`、`vMerge` 形成逻辑列；默认技术偏离表按源数据调整行数并填充，固定第一章不再插入正文锚点。其他模板的内容控件标记列及响应语义列仍是可编辑区域，未完全容纳的普通源表随正文保留。模型只提供正文及既有样式角色解释，不接收封面、目录、XML、关系或单元格位置。

最终 DOCX 的全部正文、表格、图片及 Visio 对象完成后，`WordDocumentFinalizer` 才更新 Fields 和 TOC 页码。没有 Microsoft Word COM 时，导出保留真实 TOC 字段及 `updateFields=true` 并返回 `DOCX_TOC_UPDATE_DEFERRED`；程序不让模型生成目录，也不估算目录页码。

本记录替代[项目 Word 模板库与真实分页](2026-09-12-bid-word-template-library-and-rendered-pages.md)中 S6 只使用解析格式重新生成文档的限制，以及[模板证据解析与冲突确认](2026-09-10-word-template-evidence-resolution.md)中最终 DOCX 只由 `resolved` 决定的描述。模板身份、独立格式状态、冲突确认、缓存、上传与操作互斥仍由既有记录拥有。[技术偏离表横向页面](../bug-fix/2026-09-12-word-deviation-table-landscape.md)只约束无模板 Renderer；模板导出保留原始分节。

## Alternatives considered

**继续解析样式后重建整份 Word。** 不采用，因为任何受支持格式字段集合都无法重建模板的完整 OOXML 结构，新增更多格式选项仍会丢失固定部件。

**让模型返回 XML、书签或单元格索引。** 不采用，因为文档结构定位是确定性程序职责，模型输出无法可靠维护关系 ID、合并网格和分节不变量。

**按物理单元格序号写入固定列。** 不采用，因为 `gridSpan` 和 `vMerge` 会让物理单元格数组与用户看到的逻辑列不一致，模板稍作调整就会写错固定内容。

**没有正文锚点时拒绝模板。** 不采用，因为在末节属性之前追加正文能保留全部固定内容并覆盖普通模板；需要精确位置的模板可增加明确锚点。

**没有 Word 时生成静态目录或估算页码。** 不采用，因为分页只有最终排版引擎能够确定；静态文本会伪装成可更新目录并产生失效页码。

## Consequences

模板导出保留原始页眉页脚、分节、固定文字、表格结构和图片，同时支持正文标题、列表、普通表格、链接及项目图片。系统默认导出固定为纵向封面、纵向目录、横向技术偏离表和纵向正文；技术偏离表进入 TOC，但封面与目录标题不使用 Heading 样式。语义可编辑列允许人员表、设备表和参数表继续复用同一定位机制，不以固定 cell index 分支。

表格单元格填充值当前以纯文本 OOXML 写入，并沿用目标单元格首段及首个 Run 的格式；需要在模板单元格内保留 Markdown 富文本或图片时，应扩展单元格块级内容迁移。项目编号在 S2 没有稳定字段前保持为空；需要用户指定日期时再增加项目级输入。定向回归固定默认模板锚点、TOC 字段、封面填充、正文锚点、逻辑合并列、固定单元格、页眉页脚、分节、模板图片、新增正文图片关系及 finalizer 顺序。

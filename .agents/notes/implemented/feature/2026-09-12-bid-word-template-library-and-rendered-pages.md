# Agent Note: 项目 Word 模板库与真实分页

Status: implemented

## Problem

S5 只能按项目唯一 Word 格式估算正文，正式模板通常到 S6 才上传；正文控制篇幅时使用的排版参数与最终导出不同。单份格式状态也会让新上传覆盖已有模板的提取结果、冲突确认和用户选择。快速字符与块高度算法不能复现 Word Renderer、字体和分页引擎的全部行为，稳定正文仍可能出现较大页数偏差。

## Decision

`word-export/templates.json` 使用版本 1 Registry 保存内容摘要模板身份、单调 revision 和 `estimateTemplateId`。原始文件与解析缓存继续保存在 `word-export/templates/{hash}.docx` 和 `{hash}.format-{parserVersion}.json`；系统默认格式保存在 `word-export/default.config.json`，每份模板的版本 2 格式状态保存在 `word-export/templates/{hash}.config.json`。模板 ID 等于 SHA-256，重复字节复用已有模板且不增加 Registry 版本。首份模板在基准为空时成为 S5 基准，后续上传保持当前基准；显式选择基准只修改 Registry，不修改模板状态。

S1 和 S6 复用 `/api/bid-docx-template`。该端点只保存模板库数据，既不增加 `BidDocumentRole`，也不调用普通资料导入，因此模板不进入 manifest、Corpus、chunk、S2/S4/S5 资料上下文或普通文件数量上限。模板仍使用独立原始字节上限和项目 Word 操作锁。

所有具体模板操作携带 `templateId`：读取和确认格式、预览、手动页数测算、导出及下载均解析同一份独立状态。S6 的当前选择只控制本次操作；设置 S5 基准是单独 Remote。无参数的内部格式读取专用于 S5，按照 Registry 的 `estimateTemplateId` 解析系统默认格式或模板状态。S5 工作台、父节点汇总、Writer 候选、确定性页数验收和完成账本使用该基准；完成账本同时绑定格式 revision 与模板 ID，任一变化都会使旧结论失效。

页数结果携带 `source`、`method` 和模板身份。`fast` 使用 Markdown 高度算法，服务运行中刷新、章节与父节点汇总、Writer 候选和写作验收。`rendered` 使用正式 `renderDocx()` 生成临时 DOCX，调用 LibreOffice headless 转成 PDF，并由 PDF 解析器读取页数，服务稳定正文、S6 手动测算和导出前核验。LibreOffice 不存在或转换失败时返回标记为 `fast` 的结果，不阻断 S5 或导出。

真实分页缓存保存在 `word-export/page-estimates/{fingerprint}.json`。指纹包含完整 Markdown、项目图片内容摘要、模板 ID、模板格式 revision、排序后的 `resolved` 值和 Renderer 版本；同项目同指纹的并发计算合并为一次，进程内已知失败不反复启动转换。章节快速缓存按正文、模板身份、格式版本及图片变化失效。

只有旧 `word-export/config.json` 的项目在首次读取 Registry 时完成一次复制：带模板的状态按其摘要进入模板库并成为 S5 基准，无模板状态成为系统默认格式。Registry 写入后由新路径拥有后续状态，项目无需重跑 S1—S5。

## Alternatives considered

**把 Word 模板加入普通资料角色。** 不采用；模板是渲染配置而非项目证据，进入普通上传会污染检索上下文、占用资料配额并诱导模型引用模板示例正文。

**保留项目唯一格式状态，只保存多个原始 DOCX。** 不采用；模板切换仍会丢失各自的语义映射、冲突处理和用户确认，也无法让模板身份贯穿估算与 Renderer。

**每次刷新都执行 DOCX 到 PDF 转换。** 不采用；S5 轮询与 Writer 高频反馈会重复启动重量级进程。快速算法保留交互速度，真实分页只在稳定点按内容指纹复用。

**把 PDF 页数作为唯一且必需的结果。** 不采用；LibreOffice 不是所有部署的必备依赖，转换故障不能阻断写作和导出。结果携带方法，界面不得把快速估算冒充真实分页。

**S6 切换模板时同步改变 S5 基准。** 不采用；临时比较或导出另一模板不应使既有写作目标和完成结论发生隐式变化，基准修改必须由独立动作表达。

## Consequences

一个项目可以长期保存并切换多份模板，每份模板保留独立格式证据、冲突和导出记录。S1 可以提前建立 S5 排版基准但不增加工作流阶段，未上传模板的项目继续使用系统默认格式。S5 与 S6 都能展示模板和统计方法；S6 可比较不同模板页数而不改变 S5。

`rendered` 表示 LibreOffice 对当前 Renderer 产物的分页，不保证等于用户本机 Microsoft Word；字体可用性、LibreOffice 与 Word 的版式差异及打印环境仍会影响结果。上传模板仍只提取受支持的排版参数，不继承复杂封面、Logo、水印、浮动对象或任意 OOXML 母版结构。[S5 常驻审核与按需导出](2026-09-04-bid-s5-persistent-review-export.md)继续拥有导出准入与阶段生命周期，[模板证据解析与冲突确认](2026-09-10-word-template-evidence-resolution.md)继续拥有解析、语义映射和用户确认规则；这两份记录保留为活跃约束，不归档。

# 程序命令与产物

本页供执行 Agent 查阅。命令均在本包内独立运行；以 `python` 示意已经验证的 Python 3.10+，在 Windows 选用实际可执行文件完整路径。语义输入写成 UTF-8 JSON 文件传入，不在 Shell 参数中拼接大段正文。

## 项目与来源

```text
python scripts/project.py init WORKSPACE --title 项目名 [--bidder 投标人] [--date 落款日期]
python scripts/project.py status WORKSPACE
python scripts/sources.py add WORKSPACE --file 原文件 --role tender|company|reference|prior_bid|framework|web [--text 提取正文.txt] [--url https://来源] [--title 标题] [--extraction 提取方式]
python scripts/sources.py list WORKSPACE
python scripts/sources.py read WORKSPACE --source 1 --start 1 --end 30
```

原始招标、补遗用 tender，企业证明用 company，技术参考用 reference，旧标用 prior_bid，框架用 framework；网页用 web 且必须提供实际正文和 HTTP(S) URL。PDF、DOC、DOCX、表格和图片先由 WorkBuddy 实际可用的工具读取/OCR，再以 `--text` 提供带定位说明的文本。提取行号是保存文本的位置。程序保存原件及规范化文本并生成 UUID、时间和摘要；新增来源只追加，不覆盖旧版。

脚本不访问网络，不验证搜索查询是否执行；不要把自己撰写的摘要冒充来源原文。正文或原件被改动后，来源读取和交付检查拒绝继续。引用选择如下三个字段，真实来源身份、原文和摘要均由程序补齐：

```json
{"source_position":1,"start_line":2,"end_line":5}
```

已有项目加新来源不会抹掉正文或使全书自动失效。若新文件是补遗或推翻旧依据，必须主动更新 analysis/相关 research；程序不能判断新增资料在业务上替代了谁。

## 统一接纳入口

```text
python scripts/project.py prepare WORKSPACE analysis
python scripts/project.py prepare WORKSPACE outline
python scripts/project.py prepare WORKSPACE research --section 1
python scripts/project.py prepare WORKSPACE chapter --section 1
python scripts/project.py prepare WORKSPACE review --section 1
python scripts/project.py prepare WORKSPACE final-review
python scripts/project.py apply WORKSPACE --request requests/程序返回文件.json --input drafts/程序返回文件.json
```

`prepare` 保存一个与当前项目版本绑定的请求，返回其相对路径、可填写的输入文件和对象表。只修改输入文件中的语义字段，随后 apply。请求文件、project.json、ID、来源 Hash 和正式产物均由程序持有，不让模型抄写或修补。所有位置从 1 开始；改完目录后的章节位置以新对象表为准。

请求过期时保留语义草稿，重新 prepare 并按新对象表重新选择位置。不得改 request 的 revision 来绕过检查。脚本拒绝未知语义字段、越界和布尔位置、未登记的来源及不完整覆盖。状态写入采用原子替换；历史状态和正文版本保留。一个项目只支持一个协调写入者，多个 WorkBuddy 子任务可以起草，但接纳必须串行。

### analysis

输入字段为 project、requirements、scoring、compliance。project 包含 title、scope；每条 requirement 包含 text、mandatory、citations；scoring 包含 text（完整评分规则）、category（technical/business/price/qualification）、points（真实非负分值或 null）、citations；compliance 包含 text、citations。每条招标记录必须绑定 tender 原文。

更新时，未改变身份的记录填写对象表中的 existing_position，新增记录省略该字段。程序保留被选择记录的身份；不要按标题近似猜测归属。更改 analysis 会使旧章节研究和正文审核失效；旧正文仍保留，可在新研究完成后以原正文文件重新接纳和审核，不必重写。删除已被目录引用的条目后须更新目录。

### outline

输入包含 response_points、sections、document_items，可选 content_moves。每个 response_point 使用 scoring_position、text，可用 existing_position 保留既有响应点。sections 按以下形式提供：

```json
{"response_points":[{"scoring_position":1,"text":"实施方法具体且职责清楚"}],"sections":[{"title":"实施方案","parent_position":null,"purpose":"说明本次实施方法","summary":"","must_answer":["如何组织实施并形成记录？"],"requirement_positions":[1],"response_point_positions":[1],"compliance_positions":[],"dependency_positions":[]}],"document_items":[]}
```

parent_position 和 dependency_positions 选择本次提交的 sections 数组位置，父节点必须先出现；其余位置来自 prepare 对象表，response_point_positions 选择本次 response_points。程序按树整理顺序并生成编号，最多六级；有子节点的父章只填 purpose、summary，不承担 must_answer 或业务条目。叶节需非空必答问题。依赖必须是叶节且不能成环。summary 为客户正文概述，事实仍需全书审核。

所有要求、响应点、合规项都必须分配到章节或 document_items；每项评分至少一个响应点。附件、递交及全书任务使用 `{"kind":"compliance","position":1,"handling":"submission","plan":"由负责人完成签章及递交"}`。kind 也可为 requirement、response_point；handling 为 attachment、submission、whole_book。附件和价格任务不能靠泛化技术段落消除。

编辑已有目录时为保留的节点填写 existing_position（旧对象表位置）。会移除、覆盖正文或把已写叶节改成父节时，必须提供 content_moves：

```json
{"content_moves":[{"source_section_position":1,"start_line":1,"end_line":12,"target_section_position":2}]}
```

source_section_position 来自旧目录，target_section_position 来自本次输入目录。对每个参与迁移的旧正文，行范围必须恰好覆盖全部行且不重叠；目标原有正文也须纳入映射。程序原样拼接各片段，保留空行及可完整迁移的来源关联，拒绝切断声明引用的边界。迁出的旧文件留在历史中，当前目录不会重复引用；迁入内容需要重新研究、接纳和复核。这个入口不接受静默删除原文；确需删改时先在用户授权范围内用 patch，再迁移剩余原文。

### research

字段为 readiness（ready/needs_input/search_blocked）、reason、searches、answers。searches 为实际研究过程的简短记录，每项包含 query、outcome（read/no_relevant_result/failed）、note；未联网就保留空数组并说明为什么现有资料足够。

每个 checklist 项提交一次 answer：

```json
{"item_position":1,"mode":"proposal","claim_type":"proposal","content":"拟按角色、步骤和检查记录组织实施。","boundary":"方案设计不证明投标人已有特定人员。","citations":[{"source_position":1,"start_line":2,"end_line":2}]}
```

mode 为 supported、proposal、gap；claim_type 为 company_fact、requirement、technical_fact、proposal。企业事实只接受 company，采购要求只接受 tender；framework 不能证明事实。拟议方案可以没有外部事实来源，但必须明确内容和适用条件。gap 另外需要 required_input，描述确切所需资料。存在 gap 或非 ready 研究的章节可保存草稿，不能成为内容就绪。

### chapter 与 patch

chapter 输入为 `{"body_file":"drafts/正文.md","uses":[]}`，文件必须位于工作目录内。已有章节的输入模板会预填原正文文件及其声明和来源行范围；程序核验旧引用后转换为当前来源位置，可直接用于正文不变的重新接纳，不需模型抄写内部身份。每个实际事实或重要方案声明加入 uses：

```json
{"body_range":{"start_line":1,"end_line":3},"claim_type":"proposal","citations":[{"source_position":1,"start_line":2,"end_line":2}]}
```

正文引句与来源引句都由程序从范围读取。`uses=[]` 只说明未登记声明，不证明正文没有事实；审查仍须发现漏登记或无依据声明。图片使用工作目录内相对路径，程序登记其摘要；图片变化需重新接纳和复核。章节根标题、编号由程序提供，正文支持的 Markdown 见[Word 导出](word-export.md)。

局部改稿先运行 `prepare WORKSPACE patch --section 1 --start 4 --end 8`，输入仅包含 text 和 uses。text 是这段选区的新正文，空文字表示在用户授权下删除该选区；uses 的 body_range 相对于替换文本，从第 1 行开始。程序保留范围外原文，移动未受影响的引用位置，移除与修改范围交叉的旧声明记录；改动涉及的事实须在新 uses 中补齐。接纳后重新审核，不继承旧通过结论。仅对受影响章调用；不要为局部润色另用整章重写。

### review

prepare 返回 checklist、body_lines、claims、research 及 previous_review。输入为 review_mode（separate_context/self_review）、items、claims、quality、issues。

- items：每项使用 item_position、verdict（met/unmet/needs_input）、reason、body_ranges；met 至少选择一个当前正文范围。
- claims：覆盖每个声明，使用 claim_position、verdict、reason，判断原文是否支持及类型是否正确。
- quality：固定包含 specificity、feasibility、consistency、bidder_voice、no_padding、source_scope；每项填写 verdict、reason。
- issues：尚未解决的具体问题文字数组，包括正文未登记但实际存在的事实问题。

失败报告可接纳并保存。只有全项 met 且 issues 为空才算本章复核通过；不能为结束而改结论。程序校验审查完整性和引句，语义是否正确仍由审查任务负责。

### final-review

输入为 review_mode、items、quality、issues。items 逐项对应 document_items，每项为 item_position、verdict、reason、body_evidence、citations。body_evidence 使用 section_position、start_line、end_line 选择实际章节原文。attachment/whole_book 的 met 必须有实际正文或材料引用；需要证明的是事项已经满足，不能只引用提出要求的招标原文。

submission 项只接受 manual_action、unmet、needs_input，不能填 met；manual_action 的 reason 写明签章、复核或递交的具体动作和负责人。这些人工事项单列，不阻止生成可审阅正文，但绝不表示已经执行。quality 固定包含 terminology、parameters、schedule、responsibilities、duplication、scoring_visibility、format_requirements，各有 verdict、reason。任一正文或上游计划变化均使整书复核过期。

## 导出、恢复与能力边界

```text
python scripts/project.py build WORKSPACE
python scripts/export_word.py WORKSPACE --output WORKSPACE/output/投标文件.docx
python scripts/export_word.py WORKSPACE --output WORKSPACE/output/草稿.docx --draft
```

build 生成 build/book.json、manuscript.md、preview.html、review-report.json。它们是可重建视图，不手改 book.json 的状态或正文。Word 导出有项目状态时会先重新 build，拒绝陈旧的 ready 缓存；未就绪需要明确草稿导出。客户文件与内部审查报告分别交付。

中断后先 status，读取具体的待研究、正文过期、依赖变化及待审核条目。更改来源快照本身会拒绝读取，新的来源应追加。重做研究只使相应章节失效；更改招标分析会保守地使全书研究失效。依赖章节正文变化会使依赖它的候选过期，重新检查其交接内容。历史状态和版本文件可读取，但不通过直接覆盖 project.json 回滚；按当前对象表重新提交需要恢复的内容。

本包不连接投标平台，不完成签章或上传；不自带 OCR、网页搜索、标准数据库或通用复杂 Word 表单编辑器。WorkBuddy 的实际工具承担这些任务，缺少工具时明确具体缺口。企业事实真实性、标准适用性、评分说服力和最终页图质量不能仅凭程序通过认定。

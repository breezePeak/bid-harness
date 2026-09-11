# `@deepseek-ai/dsh-bid`

English | [中文](README.zh.md)

Workspace-local intake and shared bid control-plane types for the bid-writing profile. `BidWorkspace` saves supported PDF, DOCX, DOC, XLSX, XLS, TXT, and Markdown files below `.bid-harness/`. Every imported file receives `corpus/<stored-name>/document.md`; PDF, DOCX, and DOC additionally receive `structure.json` and `metadata.json` from `extractDocument()`. Manifest version 3 records the corpus and artifact paths. The caller persists `messageInventory()` with the user's request, so the agent sees workspace-relative source, document, chunk, and structure paths and can use its normal `grep` and `read` tools.

PDF, DOCX, and DOC share one parser entry:

```ts
import { extractDocument } from '@deepseek-ai/dsh-bid'

await extractDocument({
  sourcePath: './workspace/input/招标文件.pdf',
  outputDir: './workspace/corpus/招标文件.pdf',
})
```

PDF extraction uses text positions to retain physical lines and emits `<!-- page: N -->` comments. Text-free PDFs write their corpus with `needs_ocr`; this package does not run OCR. DOCX extraction retains Word headings, lists, and tables without inventing page numbers. DOC extraction uses the pure-JavaScript `word-extractor` parser, so Windows, macOS, and Linux require no Word, LibreOffice, `antiword`, or other system executable. DOC text retains paragraphs and tab-separated table cells, but the binary format does not expose dependable Markdown heading levels or page numbers through this parser.

Import rejects empty, unsafe, unsupported, oversized, and over-count uploads. A parse failure retains the original file and records the stable extraction error in `manifest.json`. Reusing an extraction output directory atomically replaces the three complete corpus files through `dsh-atomic-write`. `exportDocx()` accepts only project-local Markdown and writes under the project output directory.

## Word 导出

S6 通过项目级 `word-export/config.json` 保存格式来源、候选映射和用户覆盖，原始模板及解析缓存放在 `word-export/templates/`，不进入资料库。DOCX XML 解析支持样式继承、页面、六级标题、编号、正文、表格及页眉页脚。实际使用的标题和正文命名样式优先，局部文字字号不拆成额外标题；未明确角色的段落保留直接格式候选。默认正文首行缩进 2 字符，模板和用户覆盖保留字符或毫米单位；文字保留颜色和正斜体，继承链未声明的段前、段后间距按零处理。导出同时写入标题样式定义，避免生成库自带主题改变外观。多候选角色须手动映射或明确使用默认方案，缺失字段标记默认补充。候选不因超过 200 项而拒绝或截断；上传默认上限为 300 MiB，格式 XML 解压总量上限为 32 MiB。模板只提供格式，旧正文、目录和项目文字不复制。格式描述复用会话模型路由生成一次待确认建议；识别输入保留全部候选标识、名称和角色，按 64 KiB 预算缩短文字样本，具体格式值由程序按选中的候选应用。无可用模型或缩短样本后仍超过预算时可以手动配置。

预览与生成共用正文快照和生效格式，保留加粗、斜体、链接、嵌套列表、表格及项目内 PNG/JPEG 图片。图片路径相对于项目产物目录，外部资源不自动下载。浏览器只提供样式预览，分页与字体效果以 Word 为准。生成成功后保存下载记录和内容标识；修改正文、图片或格式会使旧文件需要更新。多分节、复杂封面、Logo、文本框、浮动对象和完整套版不复刻；标题使用关联“标题 1～标题 6”的 Word 原生多级编号，保留编号形式、起始值和跨父级重新编号设置；在 Word 中插入、删除或移动标题后可继续自动计数，并可按标题插入自动目录。浏览器预览使用同一编号配置计算显示文字，生成文件不把序号写入标题正文。

## Control plane types

The package exports the fixed `BidStage` and `StageRunStatus` values plus `BidRuntimeState`, `BidStagePolicy`, `BidStageTask`, `StageArtifact`, and `StageValidationResult`. The browser-safe `@deepseek-ai/dsh-bid/control-plane` subpath additionally exports `BidClientProjection`, the `BidUploadFile` request and `BidFileIntakeResult` response, its Host-admitted action list, and composer capability without loading document parsers or Node modules. `BID_STAGES` and `STAGE_RUN_STATUSES` are the runtime enumerations for validators and clients; their derived union types prevent a second stage or status vocabulary.

The seven `bid.*` records declaration-merge into the existing `@deepseek-ai/dsh-session` `SessionEventMap` and remain log-only. They record stage transitions, workspace artifact references, failure reasons, and user confirmations without storing document or generated-content bodies.

## Control plane runtime

`project-state.json` 保存 Workspace 级项目进度；新 Session 通过 `bid.project.resumed` 初始化当前控制面，不复制旧聊天。`BidOrchestrator` 在执行所用 Session 中通过 `reduceBidRuntimeState()` 归约已同步的状态。详见[项目生命周期](README.zh.md#控制面-runtime)。 `runCurrentProgramStage()` executes the pending or failed program-owned stage once. `drive()` follows each current `StagePolicy` while the Executor reports `canExecute(stage)`, and stops at user input, an unsupported pending stage, failure, or final completion. Fresh project intake waits for the dedicated upload action because its executor requires the admitted file batch. `retry()`, `confirm()`, `admitAction()`, and `admitPrompt()` enforce state and permissions on the Host.

`registerBidRuntimeProjection()` registers the same reducer as the `bid.runtime` DSH Session Projection. Its `BidClientProjection` exposes only Host-admitted actions, composer capability, and Host-configured file limits. S1 through S5 form the linear writing workflow. S6 is an on-demand export action available beside the completed S5 review workbench.

The browser sends one ordered, same-origin binary S1 request whose body contains the original selected file streams and whose small headers carry their names, roles, types, and sizes. The Host resolves the live Session from that request, admits the complete batch under a project lock, imports through `BidWorkspace`, validates the resulting `manifest.json`, input, corpus, chunk index, and chunks, then calls `drive()`. A body that cannot reconstruct every declared file records S1 as failed and cannot advance it. Host 在 `agent/session-start` 先读取项目状态；waiting_user、failed 和 completed 保持原状态，只由现有驱动器执行 pending 阶段。

S2 的 Main Agent 只用 `grep`、`read` 和五个阶段私有提交工具提取 Project、Requirements、Scoring 与 Compliance 语义；Host 解析 `T1` 等短文件引用和 `chunk_*`、唯一原文 quote，计算真实文件 ID 与行号，分配稳定 `REQ-*`、`SC-*`、`COM-*` ID，并统一写入四个正式 Artifact。评分原文保持完整且不包含响应点字段。S3 独立复核语义拆分的响应点，由 Host 分配稳定 `RP-*` 身份，适配可选框架树、保存精确框架标题引用、生成初始目录并拥有首次用户确认；一个响应点可以关联多个可写 Section。S4 按业务分支并行研究章节任务与资料，在一次目录深化后完成轻量 Final Check，向 S5 交付可直接写作的 Blueprint。

S5 的 Main Agent 把自然语言要求转成版本化任务契约：全书指令、逐节任务、逐节验收条件和整书验收条件。Writer 接收当前章节的完整契约；Reviewer 在既有 Requirement、Scoring、Compliance、Evidence、声明依据、章节职责和质量审核之外逐项记录动态验收结果。`required` 失败回到原 Writer 定向修复，`preferred` 失败保留在报告中但不自动阻断。Host 只负责身份、版本、并发、失效、持久化和显式确定性指标，不按需求文字选择业务分支。

After S5 completes, `exportDocx` validates the confirmed outline and complete chapter set, combines the bodies in outline order, and writes a fresh timestamped Markdown and DOCX pair under `outputDirectory`. Repeated exports do not change the completed S5 runtime or hide its review state. Existing projects already checkpointed at `docx_export/completed` retain the same review and export actions.

## Bid Agent behavior

### 等待确认时的阶段交互

S2、S3、S4、S5 的 `waiting_user` 开放普通消息；S5 的 `running` 与 `completed` 也保留主 Agent 对话。Main Agent 通过 `bid_stage_inspect` 读取最新阶段资料；S5 快照包含章节编号与 ID、Writer/Reviewer 尝试、最近问题、当前正文未取整页数、目标差额和 Word 格式身份。S3/S4 另提供 `bid_outline_apply_operations`、`bid_outline_regenerate_scope`，S4 提供 `bid_evidence_remap`。编号和标题由模型根据 inspect 的当前目录树解析为实际 Section ID，不要求用户填写内部 ID。检查结果、交互提示和工具结果都进入会话日志；动态工具集合改变后续请求的工具前缀，已记录的历史消息不改写。

S4 最终目录确认或 S5 重置启动后，S5 先停在 `chapter_writing/waiting_user`。Host 按确认目录哈希写入 `chapters/writing-request.json`，Main Agent 在当前对话询问整体写作要求；刷新或换 Session 不会重复询问，也不会启动 Writer。Main Agent 结合招标要求、确认目录、S4 Blueprint 与 Evidence 解释自然语言要求，只追问影响执行的歧义或冲突，获得确认或直接开始授权后通过 `bid_confirm_writing_plan` 保存用户原话及 `chapters/writing-plan.json`。模型提交条件描述、优先级和 `semantic` 或受支持的 `deterministic` evaluator；Host 绑定文档或章节 scope，分配稳定条件 ID 和单调计划版本。

S5 运行中或完成后的消息先进入主 Agent。进度询问、安排说明和正文解释只读取快照，不修改阶段、计划版本、询问标记或当前 Writer；明确的新要求才调用 `bid_confirm_writing_plan`。Host 把新计划送入当前调度器，不取消无关 Writer 或 Reviewer：未开始章节读取新契约，已完成的受影响章节进入定向修复，运行中的受影响章节递增输入 epoch 并丢弃迟到旧结果。`chapters/applied-writing-plan.json` 记录执行日志采用的计划版本；模型决定 `revision.affected_section_ids`，程序只扩展真实强依赖下游。

S1→S2、S2→S3、S3→S4、S4→S5 正式完成时，Host 在最终校验和确认成功后、下一阶段首次执行前替换 Main Agent 的模型可见阶段上下文。交接消息只列出 `getBidStagePolicy(nextStage).requiredInputs` 决定的正式 Artifact 路径及 SHA-256；旧阶段消息继续保留在追加式 Session 日志中，但不再由 `deriveMessages()` 投影给模型。同阶段修复、重试和审核交互不触发替换；阶段重置复用同一替换原语，使目标阶段及后续上下文失效。决定依据见[阶段上下文边界记录](../../../.agents/notes/implemented/architecture/2026-09-09-bid-stage-context-boundary.md)。

所有修改使用 Host 的项目锁、Draft revision/hash CAS 和目录 Validator。局部重生成使用无文件工具的独立 Child 返回编辑操作，经 `mutateOutlineDraft` 保存 Draft；范围外节点及选中根位置不得改变。目录编辑不启动资料复核，也不覆盖最近完成研究的目录。Main Agent 没有裸写、shell 或任意其他工具权限，不能绕过领域动作修改正式产物。

S4 交互重映射与初始研究共用执行器、Corpus Guard、Child 调度、有限修复及 Web Snapshot。指定可写叶子只研究该叶子，指定结构节点展开其可写后代；Final Check 复核最终合并的材料、任务和必要的祖先总述。`replace` 替换目标材料，`supplement` 去重合并材料；写作维度与缺口由独立任务操作确定，不从旧材料合并中恢复。Writing Brief 保存到 Draft，最近完成整体验证的目录基线保留。其他尚未研究的新叶节留待确认前复核，不能算作已审；最终确认运行整体验证并按引用清理快照。

修改成功更新 Draft revision，发布 `running → waiting_user`，客户端刷新并提示“已更新，请重新确认”。最终确认比较 Draft 与研究目录，只复核写作目标、必答问题、业务关联、写作要求或祖先语义变化影响的叶子；单纯排序不触发模型。复核同步 Writing Brief、父节点摘要与 Evidence，完整校验后发布确认产物；失败恢复正式产物并保留 Draft。聊天文字不代表确认，只有正式确认动作可以推进阶段。决定依据见[章节研究记录](../../../.agents/notes/implemented/feature/2026-09-03-bid-section-research-blueprint.md)。

### S2–S5 quality control

S2 在同一 live Agent 内逐项提交项目事实、原子技术要求、招标原文中的评分大项和影响技术方案的合规规则；评分大项保留完整细则，不在 S2 拆成评分响应点。每次提交都即时校验短文件引用、chunk 归属和 quote 唯一性并递增 staged revision；首次通过确定性校验的 `finish_tender_analysis({})` 不写文件，进入 `review_required` 后立即结束初始 Turn，并在 Host 启动独立全量复核前冻结全部 staged 提交和 finish。复核按 Host 提供的完整 staged snapshot 逐项重读来源，可用 runtime ref 原地修正；最终 finish 必须提交当前 `review_revision`，旧 revision 不能发布。Host 丢弃带 `parent_ref` 的误拆细则，按评分结构化内容去重并合并来源，补齐 schema version、空值、完整 tender 覆盖与正式 ID，把完整评分事实写入 `analysis/scoring-origin.json`，并初始化默认全选的 `analysis/tender-analysis-selection.json`。缺项续修使用配置预算，强制复核本身不消耗该预算，也不开放 `write`。最终 Validator 独立验证原始 Artifact 集合、严格 Schema、技术评分分类、完整性、重复 ID、真实 tender 来源、chunk、行号和文件覆盖；通过后 Orchestrator 才进入 `tender_analysis/waiting_user`。

S2 审核页始终从 `scoring-origin.json` 展示完整评分事实，`must_answer` 与“是否纳入后续响应”分别编辑和显示；选择变更立即由 Host 写入确认草稿，刷新或换 Session 后仍可恢复。正式确认只把选中评分项及允许的规范化修改写入 `analysis/scoring.json`，未进行筛选时两份评分集合一致。S3、S4、S5 只读取 `scoring.json`；回退 S2 复用阶段重置清理 `analysis`、`outline`、`chapters` 和 `output`，不会保留依赖旧评分集合的下游产物。

S3 在阶段中途生成只读的 analysis/scoring-response-points.json，并把正式路径和完整 RP 数据交给目录生成、质量复核及局部修复。模型选择 scoring_response_point_ids；Host 按正式清单重建 scoring_response_points 快照、合并所属 scoring_ids 并去重，保留合法独立评分关联。未知编号报错，每个 RP 必须至少由一个合适的可写叶子覆盖，允许多个章节共同响应。Blueprint Quality Review 只通过执行期私有工具提交结构化 advisory issues；Host 为当前未变化目录生成 v4 正式质量报告及完整 checked/reviewed 集合，模型不写质量候选文件。

遗漏 RP 时，Host 提供差集原文、所属评分项及当前目录，模型只提交局部编辑与具体 must_answer；Host 应用后重新规范化和校验。质量候选只记录问题，复核正常完成且目录版本未再变化后，Host 才发布正式报告的已检查清单。相同输入版本的失败重试复用有效 RP 清单和目录候选；输入变化使候选失效。成功停在 S3 用户确认，已有确认版本不被重试覆盖。详见[局部续修与复核条件](../../../.agents/notes/implemented/bug-fix/2026-09-07-bid-outline-response-point-recovery.md)。

S4 与 S5 共用 `buildWritableSectionWorklist`。初始研究按顶层业务分支分组；唯一根目录下的结构分支各成一批，直属可写叶子合为一批，保持 Host 并发上限。Initial Child 通过现有目录操作深化章节，并可在锁定前按当前目录分别起草章节任务、显式提交材料用途；找到资料不会隐式占用材料提交状态。每个 Child 只展开当前分支职责、对应 S3 基线、局部差异和确定性筛选的候选引用，并用 `global_outline_index` 获取全书轻量职责索引；无关分支的完整 Brief、Evidence 和全部 checkpoint 操作不重复注入。Host 校验结构范围、业务依据和 Section 身份，结构语义变化只使受影响章节及祖先的旧任务、材料和复核结论失效，纯 order/level 变化不触发失效。正式 Evidence Map schema v10、分块索引与 S5 输入保持不变。

S4 启动 Child 前复检 reference/reference_bid Corpus，损坏文件以 `EVIDENCE_MAPPING_CORPUS_INVALID` 报告身份与原因。程序根据标准化 Markdown 的实际标题位置、层级及现有分块行号定位正文，同名标题按出现位置区分，直接正文与包含子节的完整范围分别提供引用。`structure.json` 展示完整目录；无法确定对应的节点标记“定位未确定”，不推断缺失。跨标题分块显示全部实际覆盖范围。原始框架标题仅作结构输入，不进入事实 Evidence。

初始研究、重映射及 Final Check 共用 `read_source` 和 `search_sources`。模型选择程序提供的目录、全文件、材料或搜索范围引用；可直接读取，也可扩大字面搜索范围。长结果返回后续引用，由模型决定是否继续。来源标题、位置与整块覆盖范围保持原样。通用本地 grep/read 不向 S4 开放，不能绕过引用读取；联网搜索、抓取及已授权快照仍可使用。

`submit_section_mapping`、`replace_section_mapping` 只处理材料。模型提交绑定唯一文件与分块的 `material_ref`、usage 及 summary；程序回填真实身份，真实工具入口拒绝未知引用、来源覆盖及任务字段。summary 必须说明支持本章哪项任务、可用内容和展开限度，进入正式 Evidence；跨章复用分别保存用途。`update_section_task` 独立调整 Writing Brief、writing_dimensions、职责内 missing_topics 或明确的 coverage_override，并记录业务依据及前后差异。找到相关资料本身不构成扩展任务的理由。

目录深化与分支研究在同一 Child 内完成；目录操作通过共享结构校验后才更新分支状态，`lock_branch_outline` 也只锁定结构有效且带有非空对照结论的目录，失败时保持分支可编辑。合并后沿用现有独立目录复核与 Final Check，不新增常驻模型阶段。目录复核按每个最终可写叶节分别判断 Writing Brief、writing dimensions 和 missing topics 是否聚焦且充分，并提交具体 `section_id` 与原因；只有具体问题所在的原业务分支可进行至多一次局部研究和结构修复，再复核仍未解决则阻断，不能把结构问题交给 Final Check。Final Check 对照 S3 已确认任务、S2 要求、用户修改、S4 差异和全书职责审查任务与资料用途，不增删、移动、拆合章节或修改标题。Host 为任务、材料和父节点总述计算稳定 `review_key` 与内容 fingerprint，运行内 `review_ref` 只作短引用；fingerprint 未变的 keep 继续有效，任务变化只使本章任务、材料和祖先总述失效，材料变化只使该关联重新待审。Final Check Prompt 只展开 pending 项、必要 summary 依赖和 Web 引用，已复用项仅进入计数。correct 的新版本仍须复核。

无参数 `finish_final_check` 根据当前版本记录计算漏项、过期及阻断，不接受模型自报已审清单，baseline 也不算已审。全部收口后合并、去重、整体验证并发布正式产物；失败沿用有限修复及回滚。检查点 schema v5 在每次成功的任务修改、材料替换、总述提交和批量复核后保存当前 mapping、操作、summary、稳定复核记录及完成状态；恢复时重算 fingerprint，只向新 Child 交付新增、变化和未审项，合法的已完成 Final Check 不再启动 Child。旧版本必须重置 S4，不能静默解释为增量状态。日志 schema v3 区分 issues 与检索 warnings，并记录每个任务的 `prompt_context_stats` 和 Final Check 的 `review_progress`，不保存完整 Prompt；技术错误不能写入业务缺口。关键写入失败、取消及权限故障仍中止阶段。

S4、S5 的 Agent 按 web_search → web_fetch → 阅读正文研究新的公开资料；已登记候选正文可复用。共用 `buildWebEvidenceSnapshots` 只根据真实成功 fetch 的 HTTP(S) URL、HTTP 2xx 和非空正文生成本地 Snapshot 与正文 SHA-256。Web ledger schema v2 不保存工具调用关联；URL 与正文哈希确定 source ID，同 URL 不同正文分别保存。最终确认按引用裁剪 ledger 和无用快照。

S5 读取 `analysis/evidence-map.json`、`analysis/web-evidence-sources.json` 和 `outline/confirmed-outline.json`，按既定 Blueprint 组织正文。Writer 与 Reviewer 同时获得完整目录职责及当前祖先路径，依据父子关系、同级节点分工和本节任务检查正文归属，不根据固定章名或行业词指定内容位置。叶节使用段落、列表和表格，提交及恢复检查拒绝根标题以外的 Markdown 标题；Host 只按确认目录生成根标题编号。已有正文的预览和导出保留其子标题原文，不生成新的节内编号。Writer 优先使用 S4 Evidence，遇到具体资料缺口时可在全部成功解析的 reference/reference_bid/outline_framework 及登记 Web Snapshot 中有限 grep/read；相邻分块按索引读取，tender 始终禁止。补搜实际使用的资料写入当前 Chapter Metadata，不回写已确认 S4 Evidence Map；framework 保持草稿身份，不作事实 Evidence。

S5 以 `outline/confirmed-outline.json` 为唯一章节结构。各级父节点直接展示 S4 已确认的 `summary`；Word 导出在对应父标题下、子章节之前插入同一概述。S4 通过 `submit_branch_summary` 生成可直接用于技术标正文的自然总述：根据最终子章节任务与已确认信息概括业务内容和总体思路，不逐条解说目录、不展开操作步骤、不新增事实或承诺，也不声称核验尚未生成的正文。程序只校验节点身份、非空及复核完成状态，文体和适用性由模型判断。父节点不进入叶节 Writer 调度、审查进度和正文修订。Main Agent 只通过 `add_global_consistency_note`、`set_chapter_relations` 和 `finish_chapter_plan` 判断关系，不使用文件工具。Host 按目录遍历预置全部可写章节，补齐身份、版本和 Hash；至少一项真实全局说明及无环强依赖校验通过后原子写入 `execution-plan.json`。仅有合法 plan、尚无 execution-log 时也复用计划。

Writer 只提交完整 `markdown` 与语义 `metadata`，空数组和 handoff 成员可省略。三个 `section_id` 与三个 `covered_*` 索引由 Host 按 Blueprint 绑定；覆盖索引不代表正文已经响应。资料使用本章稳定的 M（映射材料）、F（可补搜文件）和 W（已验证网页）引用，工具读取仍使用真实路径。相同资料经不同短引用提交时按真实身份去重，语义冲突可恢复地拒绝。框架只作为 preserve/adapt/rewrite 写作输入，不进入 M/F Evidence；新 URL 必须有当前 Writer 的成功 fetch 正文。引用、chunk、usage 和 Snapshot Hash 在 `structured_output` 完成前校验，允许当前 Writer 修正。

Reviewer 通过 `review_coverage_items` 和 `review_claims` 分批 upsert，通过 `review_global_constraints` 独立核验全局要求，再由 `set_review_summary` 替换质量检查、职责冲突和额外阻断，最后以 `finish_chapter_review` 提交。canonical R Checklist 包含本章 must-answer、Requirement、评分响应点、局部 Compliance 和当前 `semantic` 验收条件；显式 `deterministic` 条件由 Host 测量并与同一报告合并。当前候选 Q 原文与只读 E Evidence Pack 包含相关 S2 确认事实、实际使用的本地 chunk、Hash 验证后的 Web 正文及前置 handoff，明确各来源的证明范围。每批可提交多项并分别返回接受项和失败项；漏项或缺少 summary 的 finish 保留记录并返回缺项。普通文本结束时在同一 Child 内按 `modelStageRepairAttempts` 有限续行。

Host 从记录确定 verdict：既有固定审核失败或任一 `required` 动态条件未满足都为 `repair`；`preferred` 未满足只保留独立 coverage，章节职责冲突为 `blocked`，不把错误分工作为正文缺陷交给 Writer 修订。成功 finish 表示报告收集完整，可以是 pass、repair 或 blocked。正文在 Reviewer 启动前即可读取；内容问题使用相同有界修复预算回到原 Writer，耗尽后保留最近的合法已审候选和真实问题。

全部章节完成后，现有 Main Agent 先完成文档级合规审核，再逐项验收当前计划的章节与整书条件。Main Agent 对 `semantic` 条件判断 met/unmet，显式 `deterministic` 条件服从 Host 测量；任一 `required` 未满足时选择最小充分章节并给出具体修订，调度器复用原 Writer 后重新执行章节审核、全局审核和整书验收。完成账本绑定计划版本、Word 格式版本、正文 Hash 和每轮修改前后身份；`preferred` 未满足可以随完成结论持久化。

私有工具通过 in-process 的 `subagent/child-setup` 在 Child 发布前安装，以真实 Agent 和本次章节尝试隔离。finish 调用 `concludeTurn()`，只在权威 `tools/result`（嵌套调用同时等待外层结果）成功后确认；结束或释放后不能修改结果。Writer、Reviewer 均为 fresh-context 一层 Child，默认章节并发为 3，强依赖等待、弱关联不阻塞。路径、持久化字段和版本不变；M/F/W/R/Q/E 不进入外部 Artifact。

Writer 或 Reviewer 异常结束时，执行日志和阶段失败消息保留 Provider 提供的安全诊断，便于区分模型服务故障与产物校验问题。

S5 将 `execution-log.json` 作为章节级检查点。模型流断开或结果通道错误使用独立运行重试预算；单章最终失败不取消无关章节。恢复验证当前计划版本、日志、正文、metadata、Reviewer 报告、资料完整性、内容 Hash 和 Child 身份；正文与 metadata 合法但 Reviewer 报告缺失或协议过期时保留正文并只重新审核，未完成、正文损坏、身份失效或当前计划明确影响的章节及其全部强依赖下游才重置为 pending。弱关联不传播失效，无关的合法 completed 继续复用。正常提交与最终读取共用 canonical 覆盖、引句、身份及 verdict 一致性检查。`review_sha256` 和 `review.candidate_sha256` 均绑定 `chapterCandidateSha256(markdown)`，不是报告 JSON 的 Hash。文档级报告逐项绑定其检查过的章节 Hash 与资料证据，未变化项可在恢复时复用，变化项重新审核。

候选 Web 来源缺失、Hash 错误或路径不安全时，预检及 W 引用表向 Writer 标明不可用，不影响无关章节，也不删掉对应写作要求；实际引用仍在当前提交工具中校验账本身份与正文。已发 W 在同章修复中保留编号，不因过滤或追加来源重编号。整体账本错误和 Host 写盘失败仍会使执行失败。

正文、metadata 和 review 的最终写入之间允许取消，完成日志排队期间也允许取消。串行队列实际开始一次原子完成日志替换后允许提交收敛；磁盘写入成功才发布共享 completed 状态。提交前取消的候选不视为完成，提交后的章节可恢复；全书 manifest 与文档级合规报告开始写入前再次检查取消。理由与取舍见[检查点与故障隔离](../../../.agents/notes/implemented/bug-fix/2026-09-04-bid-chapter-checkpoint-fault-isolation.md)和[全局合规审核](../../../.agents/notes/implemented/bug-fix/2026-09-09-bid-s5-global-compliance-review.md)。

Writer 在缺少真实项目数量、人员、设备或记录值时只保留正式字段和填写规则，不生成示例数据行。Reviewer 不得要求虚构或示例值，并把已填的“示例、待补、XXX、最终填写”等内容视为占位。


阶段重置不会自动开始执行。Host 会先取消并等待当前 Agent 树静止，清理目标阶段及其后续 Artifact，再将 S2–S5 置为 `waiting_start`；用户通过 UI 的“开始本阶段”或 `/bid-start` 明确确认后，才进入该阶段的正常执行路径。重启后内存执行记录缺失也不会跳过 Agent drain。

## Model Experience

### Bid inventory and S5 task context

#### What the model sees

调用方将 `messageInventory()` 持久化为用户消息，包含文件名、工作区相对源路径、解析正文与结构路径以及解析状态；文件字节和宿主绝对路径不进入这条清单。S4 研究任务另行携带旧标完整标题列表、当前分支职责、局部基线与差异、候选引用及全书轻量索引。S5 Main Agent 从用户要求生成任务契约；Writer 获得当前章节的完整契约，Reviewer 获得确认目录职责、当前章节路径及逐项验收清单，整书审核获得有界章节摘要和既有审核结论。这些输入均进入相应会话记录。

#### Token effect

文件清单按每份导入文档增加固定字段；S4 当前分支上下文随该分支规模增长，全书部分只随轻量职责索引增长，Final Check 详细上下文随 pending 项增长；S5 上下文随确认目录、适用任务条件和章节摘要增长。旧标标题按完整顺序提供，不重复每个标题的祖先路径；正文仍按需读取分块，整书验收也不再次注入完整正文。

#### KV Cache effect

持久化清单和任务交互是追加式会话内容；后续导入文件或热更新计划不会改写更早的请求前缀。计划版本变化会改变后续 Writer、Reviewer 和整书审核的任务输入。

### Chapter revision context

#### What the model sees

章节完成后的用户修订通过 `reviseChapter` 定位执行日志中的原 Writer；用户意见、当前正文和限定引用进入原 Writer 的会话日志。章节引用绑定完整正文 SHA-256，段落引用另带 UTF-16 起止位置与原文；会话恢复失败或选区身份不一致时，Host 在模型运行前拒绝修订。

#### Token effect

修订请求随当前章节正文、用户意见和引用数量增长，不重复注入其他章节正文。失败恢复章节正文、metadata、审查与执行记录，其他章节不重写。

#### KV Cache effect

修订追加到原 Writer 会话；既有 Writer 前缀保持不变。修订期间父 Agent 不执行模型步骤，失败不会改变其他章节的会话前缀。

## Known Limitations and Deferred Work

- PDF extraction does not perform OCR or full table reconstruction; positioned rows remain separate when columns cannot be recovered safely.
- DOC extraction preserves text, paragraph breaks, list markers, and tab-separated table cells but not all binary Word styling.
- DOCX and DOC page fields remain `null` because their source structures do not provide dependable pagination.
- DOCX export supports headings, paragraphs, lists, and tables; it does not apply a company Word template.
- S5 的证明范围与资料身份由 Host 校验，原文是否真正支持某项内容仍由 Reviewer 判断；无密钥回放验证协议，不能替代真实模型的语义质量评估。
- 整书语义验收使用有界章节摘要和既有审核结论，不把完整正文再次复制进 Main Agent 输入；需要跨章逐句比对的条件仍依赖模型在现有证据范围内判断。

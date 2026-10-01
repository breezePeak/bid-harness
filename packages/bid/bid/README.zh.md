# `@deepseek-ai/dsh-bid`

[English](README.md) | 中文

投标写作 profile 的工作区本地入库能力与共享控制面类型。一个 Workspace 对应一个 Bid 项目；`new BidWorkspace(workspaceRoot, config)` 将项目文件保存到 `projectDirectory`，默认是 `.bid-harness/`，同一工作区的所有 Session 共用。该目录包含 `project-state.json`、`manifest.json`、`input/`、`corpus/`、`analysis/`、`outline/`、`chapters/` 和 `output/`。不读取或迁移旧的 Session 独立目录。

支持导入 PDF、DOCX、DOC、XLSX、XLS、TXT 和 Markdown。每个入库文件都会获得 `corpus/<stored-name>/document.md`；PDF、DOCX 和 DOC 还会从 `extractDocument()` 获得 `structure.json` 与 `metadata.json`。Manifest 版本 4 记录文件角色、语料和产物路径。调用方将 `messageInventory()` 与用户请求一起持久化，因此 Agent 只会看到工作区相对的原文件、正文、分块与结构路径，并可使用常规 `grep` 和 `read` 工具。

PDF、DOCX 和 DOC 共享一个 parser 入口：

```ts
import { extractDocument } from '@deepseek-ai/dsh-bid'

await extractDocument({
  sourcePath: './workspace/input/招标文件.pdf',
  outputDir: './workspace/corpus/招标文件.pdf',
})
```

PDF 提取使用文本位置保留物理行，并输出 `<!-- page: N -->` 注释。无文字 PDF 会写出带 `needs_ocr` 状态的语料；本包不执行 OCR。DOCX 提取会保留 Word 标题、列表、表格和正文中的比较符号（如 `<`、`>`），不伪造页码，也不会把比较符号误判为 HTML 标签。DOC 提取使用纯 JavaScript 的 `word-extractor`，因此 Windows、macOS 和 Linux 都不需要 Word、LibreOffice、`antiword` 或其他系统可执行文件。DOC 文本会保留自然段和制表符分隔的表格单元格，但二进制格式无法通过该 parser 提供可靠的 Markdown 标题层级或页码。

入库会拒绝空文件、不安全文件、不支持格式、超大文件和超数量批次。解析失败会保留原文件，并在 `manifest.json` 中记录稳定的提取错误。复用提取输出目录时，系统通过 `dsh-atomic-write` 原子替换三个完整语料文件。`exportDocx()` 只接受项目目录内 Markdown，并写入项目输出目录。

S4 的映射计划和检查点通过当前 Agent 的文件系统服务提交；任一任务成功后立即将结果和 `completed=true` 写入关键状态队列，恢复调度和进度统计均以该完成标记覆盖执行日志中的瞬时状态。执行日志仅在子会话建立后标记任务运行中；准备子会话和等待重试期间保持待启动状态，旧日志中没有活动子会话身份的运行标记也按待启动投影。执行日志保留真正失败、运行中与未开始任务的区别并使用独立的尽力写入队列和原子替换；恢复只调度失败与未开始任务，首个失败任务通过恢复屏障后立即按配置并发继续。短暂的 Windows 文件占用会有限重试，重试耗尽只记录 Host 告警且不阻断后续检查点。

## 控制面类型

本包导出固定的 `BidStage` 与 `BidTaskStatus`，以及判别联合 `BidTaskState`、`BidRunContext`、`BidStagePolicy`、`BidStageTask`、`StageArtifact` 和 `StageValidationResult`。`BidTaskState` 是唯一业务状态，只有 `running` 与 `suspended` 分支携带 Run 执行数据。browser-safe 子路径 `@deepseek-ai/dsh-bid/control-plane` 还会导出 S1 与 DOCX 模板二进制端点常量、`BidFileIntakeResult`、`DocxTemplateUploadResult`、Host 允许的 action 列表和 composer capability，而不会加载文档解析器或 Node 模块。

`bid.*` 记录通过声明合并接入现有 `@deepseek-ai/dsh-session` `SessionEventMap`。`bid.project.resumed` 把唯一任务状态和 revision 写入当前 Session，用于初始化或同步 `bid.runtime` Projection；`bid.task.changed` 提交显式业务结果，Run 开始、挂起和完成事件只描述执行尝试。事件不保存文档、Artifact 原文、绝对路径或调用栈；`StageValidationIssue` 使用稳定 `code`、项目相对 `artifact`、Schema `path` 和安全 `message`。

## 控制面 Runtime

`stopRun` 同时取消发起停止的会话回复和项目后台 Run，保留待处理的用户消息；后台执行收敛并保存挂起状态后返回。主会话空闲时也可停止后台 Run。

[执行与恢复所有权](README.md#执行与恢复所有权)说明默认流程、主 Agent 故障处理、显式 Goal 和 Host 重启续行。

S4 Initial Mapping 的客户可见编号检查只归当前任务可编辑的 Section 子树所有；其他章节的总述问题由各自任务处理，Final Check 仍检查完整目录。修复客户可见总述时保留正式目录中的评分 ID 绑定。

`project-state.json` 是项目进度的持久化来源，schema version 4 扁平保存 `stage`、`status`、`run`、单调递增 revision 和 `updated_at`，不保存聊天消息、工具调用、提示词或摘要。读取器会把结构合法的 v3 状态归一为 v4，后续写入只使用 v4。Bid Session 启动时从 `session.header.cwd` 定位项目；缺少状态文件时初始化 S1 等待上传，否则通过 `bid.project.resumed` 恢复当前 Session 的 Projection。Workspace 的“+”继续调用 `sessions.create()`：新 Session 不读取其他 Session 的聊天或模型上下文，也不建立父会话关系。

`BidOrchestrator` 绑定执行操作所用的 DSH Session，并通过 `reduceBidTaskState()` 归约当前 Session 已同步的状态。Run 只记录一次执行尝试的身份、epoch、基线 revision、工作描述和进度，停止原因属于外层 `suspended` 状态。Host 为每次自动执行传入强制 `BidRunContext`；调度准入、Child 收敛、取消信号和正式写入栅栏都归该 Run 所有。读取到没有活动 operation 的未完成 `running` 时，Host 在项目锁内先将其改为 `suspended(host_restart)`，释放启动操作后对绑定的 S2～S5 目标自动恢复原 Work；能力 Work 已有可验证的正式提交凭据时只补完成结算。恢复必须同时匹配挂起 Run ID 和项目 revision，并由执行器按持久检查点核对已完成工作。

`capability_task` 用一个 Work 和一个 Run 顺序执行已有能力。不可变请求冻结真实用户原话、选定意见全文、接纳时的待处理队列及完整计划；模型概括的 `goal` 不能替代这些来源。隔离、只读的子会话分别核验计划与实际产物，只返回语义要求及按输入顺序排列的判断；Host 绑定来源、章节、要求索引和文件摘要，并检查目录节点、Writer 身份和当前审核。同一 Work 已发生的计划拒绝、补丁和完成步骤由 Host 提供给后续核验。来源要求完整保留迁移原文时，验收判据记录 `preserve_migrated_content`，Host 检查当前可写叶节的原段落、表题、表格和流程图定义，并将确定性结果提供给语义核验；原章标题可由新目录标题替代，重复写作已完成叶节仍须保留原文块。步骤完成不代表任务完成：核验未通过时保留候选及已完成前缀，`bid_plan_task` 可修改后缀或追加步骤，再通过原 Work 恢复；真实授权冲突须澄清。业务文件、发布凭据及已满足意见在同一发布事务提交，结算从最新队列合并，保留后来新增的意见。`bid_project_inspect` 可按历史 Work 的对象位置读取任务、候选、检查点与核验；缺少核验的历史记录不会被视为新任务的完成证明。

模型工具从最近一次 inspect 的 `objects` 选择位置，Host 绑定章节、业务条目、审批意见、模板、真实消息和历史 Work 身份；原生目录编辑使用 `draft_sections`，并沿用 inspect 时的草稿 CAS。对象表按页提供全局位置和截断信息，正文块只在本次读取窗口内展示；`objects_page` 可单独选择对象表页。段落引用的偏移、原文和 SHA、批次任务 ID、迁移块身份、当前 Run、写作请求及计划版本都由程序处理，模型提供身份字段会被拒绝。`bid_plan_task` 用 `replace_pending` 或 `append` 表达调整方式，Host 定位原 Work 与可修改起点。业务归属和原文迁移子会话按输入顺序返回语义分配；段落 Writer 按输入顺序返回替换文本，Reviewer 选择意见或块的位置，程序写入持久记录的真实 ID。原生 SDK 和磁盘记录仍使用完整身份。

混合审批任务的正文批次可以只处理相关意见的正文子集，完整任务仍须覆盖全部相关来源。内部 Writer 或审核失败保留原错误码、批次及成功候选，由主 Agent 在原 Work 定向恢复；只有真实缺业务输入才等待用户，冲突、凭证或输入损坏仍阻断自动恢复。历史 completed 意见保留在对象表中，显示原状态和引用；新用户授权可以绑定最新正文进行定向纠正，读取历史意见不会重开旧队列。

导出要求须有唯一的末尾 `docx.export`，该步骤与内容步骤共同保存在有效计划中。内容执行器发布正文后，独立导出器读取补丁后的尾步骤；导出失败保留内容凭据，目标保持未完成，重试只执行导出。

合并或删除的原范围在接纳时目录核对，结果目标按本 Work 的合法结构操作和退役记录解析；核验、内容保留及意见结算沿用原来源身份，未知节点或范围外迁移仍拒绝。

S5 私有工具同样按本轮对象位置选择章节关系、验收条件和合规条目，程序绑定完整身份。首次计划从当前 Main 所属的持久已回答请求绑定身份；已消费请求不能复用，已有有效计划时不读取初始请求记录。保留迁移原文时，Writer 用 `{{reuse:位置}}` 安排原文块，程序插入原段落、表题、表格和锚点，并继承原流程图定义；缺失或改写的块拒绝提交。恢复原 Writer 时，Host 从真实会话 Header 找回并验证所属 parent 和项目，批次共享同一 parent 的恢复句柄，只释放本次恢复拥有的句柄。

纯章节审查交付与当前正文绑定的报告；报告发现可修复问题或缺少外部资料时仍完成审查，不自行改写正文，也不将报告发现当作等待补充输入的执行阻塞。纯整书审查核对正文、审核报告和当前目录摘要，历史 Writer 输入版本与正文质量问题记录在报告中；正式正文交付仍执行完整质量和输入版本校验。正文修订任务需要外部输入时仍保留候选并等待真实回答。

主 Agent 对挂起能力 Work 的恢复指令作为执行上下文传给失败步骤；模型适配器仅在对应失败单元的提示中使用它，不改变不可变任务、输入摘要或已完成步骤。Provider、额度、凭证等阻断仍通知主 Agent 读取诊断并向用户说明，但不提供自动恢复工具。Host 重启续行失败保留当前 Run 的错误通知并唤醒主 Agent。

等待输入的步骤将旧候选复制到新输入身份的候选项目，Host 在业务校验前对全部授权路径比较候选与 Work 的新增、改动和删除，并把差异并入同批发布凭据。每轮仍需输入时按本轮输入摘要发出新的原生问题，已保存的回答不会冒充下一轮回答。

主 Agent 通过 `bid_run_task` 统一规划自然语言要求和选定审批意见，`chapter.revision_batch` 在当前候选复用原批次调度器、段落修订和各章原 Writer。段落范围只允许同选区修订；保存为段落的意见不能授权新增目录子章。真实拆章须依次修改目录、迁移原文、基于 seed 写完新叶节并审核。旧正文批次工具不进入 Main 工具目录。排队任务结算并释放项目锁后，以持久化结果通知唤醒空闲 Main。`docx.export` 作为独立尾效果保留在完整目标中，内容发布与导出回执均有效时才有 `goal_met=true`；导出失败保留内容结果及未完成目标。

原生章节修订先核对当前正文摘要，并持久化真实用户请求；该请求的授权仅在本次入口调用与所属 Session 内有效。局部章节修订只提交授权范围的正文和审核，整书审查报告由独立能力步骤更新。`bid_run_task` 持久接纳能力 Work 后返回 `execution_status=started` 与 `completed=false`，后台执行及结算允许同一 Main 继续处理新消息并登记排队。完成通知及结果凭据决定实际交付状态；内容与导出组合任务的完成通知等待独立导出结算。

模型入口的目录迁移时序由程序从后续 `chapter.reorganize` 或明确暂缓正文的目标推导；模型不提交 `defer_content_migration`。任务校验错误使用模型选择表的位置字段名，避免要求模型填写持久身份；缺少迁移来源仍拒绝接纳。

目录能力以当前确认目录为已写项目的基线，首次确认前读取当前 Draft。`outline.update` 同时应用结构操作与经过真实招标 ID 校验的业务归属；拆分子章不会机械继承父章的全部要求。`outline.refine` 使用 S4 的章节研究、结构判断和终审，依据实际资料决定是否深化目录；新叶节由 Host 分配 ID 并独立形成任务级依据。`chapter.reorganize` 把旧正文按完整 Markdown 块交由子会话分配，Host 核对源正文 SHA、块身份、目标范围、完整覆盖及显式共享或删减。迁移成果写入 `chapters/reuse-seeds.json` 并保持待写、待审；退役章节的计划、资料和旧 Manifest 归属保存在 `outline/reassignment.json`，未分配的旧正文由 `chapters/pending-reorganization.json` 指明。目录、Draft、授权来源为 `user_task` 的 confirmation、Evidence、Writing Plan、执行索引及 Manifest 在同一步候选中校验，再由能力 Work 发布实际改变的精确文件。

`evidence.research` 与默认 S4 使用同一章节研究执行器：`supplement` 保留并去重旧材料，`replace` 只替换目标章节；范围外映射和既有 Web 来源顺序保持原样。首次调用可从空 Evidence Map 和 Web Ledger 建立资料。`allow_outline_refinement=false` 保持确认目录的结构、职责与必答项；明确授权为 `true` 时，研究后的结构判断可在授权子树内深化目录。拆分后的退役章节资料只作为待判断候选，当前正文草稿只辅助检索意图，二者都不自动成为 Evidence。每个当前可写叶节的 `answer_plan` 逐项记录具体回应、依据边界或真实缺口；历史映射仍可读取，写作前会定向补齐缺失计划。写作和审核保留缺口及修复结论，全节缺少可成文内容时等待真实输入。新增 Web 快照从严格来源账本取得精确文件许可；阶段映射计划和检查点留在步骤候选内，等待输入时由原 Work 校验并复用。

选中非叶章节并允许深化时，首轮研究以该父节点为结构编辑根，覆盖完整子树；新增叶节随后单独研究。固定目录研究的 Initial Mapping 和 Final Check 均拒绝改变 Blueprint 职责或业务覆盖，结构问题直接报告。Final Check 之前持久化当前 Evidence 与目录候选，恢复只复用匹配研究请求、章节范围、目录和语料身份的检查点。用户补充的文字仅作为新研究的待核验输入；当前范围的 gap 必须重新评估，不能自动改为有依据。

全新项目的文件接入必须等待专用上传操作，因为其 Executor 需要已准入的文件批次。S2 的 Stage Policy 声明 `requiresUserConfirmationAfterValidation`；初次校验通过后记录 `bid.user_confirmation.required`，不记录完成事件。`confirmValidatedStage()` 在正式 Artifact 再次通过 Validator 后才记录用户确认和阶段完成。

`registerBidRuntimeProjection()` 把同一状态归约函数注册为 DSH Session Projection `bid.runtime`。Projection 返回 `{ task: BidTaskState, ... }`，不再投影第二套 runtime、workflow 或最近 Run 状态。`allowedActions`、composer 能力以及 `allowedExtensions`、`maxFiles`、`maxFileBytes`、`maxTotalBytes` 限制均由 Host 生成；Client 不归约 Bid Event，也不根据 Stage、聊天或 Agent 活动推导业务状态和权限。`@deepseek-ai/dsh-bid/control-plane` 是不依赖 Node 文档处理库的 browser-safe 数据契约出口。

Host 插件注册该 Projection，并全局拒绝已解析 Preset 为 `bid` 的 Session 进入通用 Prompt 路径。`webSearchEnabled` 是 Bid 唯一的联网业务开关，默认开启，并同时控制 `web_search` 与 `web_fetch`；`evidenceMappingMaxConcurrency` 和 `chapterWritingMaxConcurrency` 分别限制 S4 Mapping Subagent 与 S5 Chapter Subagent 的同时运行数量，均默认为 3，可配置为 1–8；`chapterWritingCompletionRepairRounds` 单独限制 S5 整书验收后的修订轮数，默认为 3，不随并发数变化。

`bid` Agent Preset 为 Bid Session 注册 `/bid-reset-s2` 至 `/bid-reset-s5` 四个无参数重置命令。重置可以选择当前阶段或更早阶段；Host 原子占用项目，无论内存中是否仍保留运行记录，都会取消并等待主 Agent、Subagent 和并发 Worker 静止，再删除所选阶段及其后续阶段拥有的 Artifact。旧操作已经开始结算时，重置等待其完成；否则重置与操作收尾共用一次 Run retirement，排空 child 后才释放父 Execution Agent。S2、S3、S4 提交 `ready` 并结束重置请求后，由持有同一项目操作的后台续行进入正常执行；续行结算前不释放 Execution Agent 或项目锁。S5 回到 `waiting_user` 且不创建 Execution Agent；内部 S1 重置同样回到 `waiting_user`。短暂文件事务先自然结算；未来阶段、第二个并发重置和带参数命令会被拒绝。用户发起的取消不会记录 `bid.stage.failed`，命令结果也不进入模型历史。

浏览器将一次 S1 所选原文件按顺序组成同源二进制请求，并只在小型请求头中声明名称、角色、类型和大小。Host 由该请求解析实时 Session，以工作区的规范绝对路径作为项目锁键，准入完整批次，通过 `BidWorkspace` 入库并校验生成的 `manifest.json`、原文件、语料、分块索引和分块文件，随后调用 `drive()`。同一 Workspace 的不同 Session 不能并发修改项目；不同 Workspace 可以并行。请求体不能还原全部已声明文件时，S1 会记录 Workflow 失败且不能推进。`modelStageRepairAttempts` 配置 S2–S5 的内容校验修复轮数；内部错误保留挂起 Run 和恢复诊断，确定的输入、权限及模型基础设施阻断结算为 `failed`。S2、S4 和 S5 分别从逐条分析、任务与章节检查点恢复未完成或失效工作。

DOCX 模板通过独立同源二进制请求上传，请求头只携带 Session、文件名、长度和配置 revision。`docxTemplateMaxBytes` 默认 300 MiB，浏览器按 `DocxFormatView.templateMaxBytes` 预检，Host 按相同值和声明长度限制请求体；模板解析需要 ZIP 随机访问，因此 Host 只在准入后把原始二进制体缓冲一次，不生成 base64 字符串。Host 解析 docDefaults、Theme、样式继承、段落与 Run 直接格式、页面和编号，再让当前会话模型仅依据模板正文与候选解释格式说明和角色；模型选择候选后只合并该候选，模板说明中的常用中文字号在页面显示原名称和对应磅值。模型解释失败时保留确定性提取结果，并提示用户重新上传以重试解释。模板上传、冲突确认、独立格式建议和导出使用项目级 Word 操作锁，不占用 S1—S5 阶段 operation；同项目各会话均可配置或导出 Word，阶段启动与 Word 操作可并行；会删除章节和输出的阶段重置与 Word 写入互斥。`word-export/config.json` 分别保存 `extracted`、`modelInterpreted`、`conflicts`、`resolved` 和 `userConfirmed`，预览与导出只读取 `resolved`。

S1 资料上传、S2 招标分析、S3 初步目录生成、S4 目录生成/资料映射和 S5 正文编写组成线性流程；S6 是 S5 完成后在审核工作台内随时可用的按需导出动作。S2 只提取 Project、Requirements、Scoring 和 Compliance；评分原文在 S2 保持完整。S3 独立复核按语义拆解的评分响应点，由 Host 分配稳定 `RP-*` ID，再适配可选人工框架、保存精确框架标题引用并生成初始目录；同一响应点可覆盖多个可写 Section。S4 按 Section 规划和研究，直接形成 `section_mappings`，完成一次基于证据的目录深化，并只对新增或语义变化的可写 Section 补充映射。S5 在 Writer 候选通过 Host 校验后，先回流实际使用的新资料并定向重研 Answer Plan，再以最终章节依据启动独立 Reviewer；审核后提交正文；明确问题回到同一 Writer 会话，按 `modelStageRepairAttempts` 自动修复（默认 3 次，含初稿共最多 4 轮），最终仍有问题时保留 `needs_attention`，不阻断 Word 导出。

S5 将 `execution-plan.json` 和 schema v4 `execution-log.json` 绑定当前 Writing Plan 版本，并以日志作为章节级检查点。日志在排队、编写、审核和修复期间记录当前 phase，失败时保留失败 phase；Host 据此生成审核工作台的章节状态。Host 读取 schema v3 日志时会确定性迁移为 v4，已完成章节保持完成，待执行和中断运行章节仅重新排队，失败章节按可确认的最后失败角色保留失败语义。每次 Writer 和 Reviewer 尝试都绑定计划版本、section epoch，以及全部强依赖章节的正文和 handoff 身份；正文、审核、文件写入与完成日志提交前都会重新核对 Run fence。计划、章节或上游交接变化会使迟到结果记为 `stale-input` 和 `accepted=false`，不能覆盖正文或成为最终审核。模型流断开或结果通道错误使用独立运行重试预算，不占内容修订次数；单章最终失败不会取消无关章节。Run 恢复严格校验关系计划、日志、正文、metadata、Reviewer 报告、内容哈希和 Child 身份，保留仍绑定当前契约的 completed 章节，只重新排队失效、failed、running 和 pending 章节。恢复不会删除章节文件；显式阶段重置才执行清理。

章节尝试还绑定当前章节的 Evidence、Answer Plan、已映射本地及 Web Chunk 和适用招标记录；依据变化保留有效正文重新运行 Reviewer，不连带重写无强依赖的章节。Writer 实际使用且验证通过的新资料由 Host 在 Reviewer 启动前合并到当前章节 Evidence，旧 Answer Plan 失效并经单节固定目录研究重新生成；模型判断资料支持边界，真实缺口继续等待输入。`chapter.revise` 和 revisionBatch 的写前研究分别只覆盖被修订章节和批内实际章节；默认整书写作才扫描全部可写叶节。

Writer 使用私有 `submit_chapter` 提交完整候选，工具参数错误在当前回合纠正；每轮语义修复保留 Writer 身份并启动独立 Reviewer，引用和报告按当前候选重新生成。正文标题在审查前按确认目录统一编号；页面读取同一正文，Word 保留相同编号并调整文档标题层级。

Writer 在缺少真实项目数量、人员、设备或记录值时只保留正式字段和填写规则，不生成示例数据行。Reviewer 不得要求虚构或示例值，并把已填的“示例、待补、XXX、最终填写”等内容视为占位。

S2 的 `project.json` 记录项目背景、建设目标、实施约束和项目技术重点；`scoring.json` 只保存评分原文、分值与简单规范化字段，不含评分响应点。纯商务、资格和报价评分不得进入 `scoring.json`。Validator 检查覆盖、严格 schema、来源文件、分块和引用行后，S2 停在 `tender_analysis/waiting_user`。

`bid/getTenderAnalysisForConfirmation` 返回 S2 的四个 Artifact；`bid/confirmTenderAnalysis` 只允许编辑规范化项目、要求、评分与合规字段。原文、分值、ID、`source_refs` 与招标文件覆盖集合不在操作协议中。Host 原子替换四个原路径文件并再次执行完整 S2 Validator；无效输入返回问题并保持 `waiting_user`，通过后才完成 S2 并启动 S3。

`bid/getDetails` 只读已发布详情：已存在的 `outline/confirmed-outline.json` 与章节位置决定最终目录和正文入口是否可见；没有最终目录时仍按首次确认边界显示初始或候选目录。阶段标签不会隐藏已有正式正文，也不改变确认接口的编辑准入。

新的整本目录深化任务须由 Main Agent 随请求提交 2–8 个具体工作项，界面展示该拆分，旧请求仍可恢复。运行中的资料映射进度读取当前能力步骤候选工作区的日志；不会把项目根目录的旧 S4 日志显示成当前任务。Bid Main Agent 可在任意阶段通过 `bid_run_task` 提交真实用户消息授权的能力计划。运行中的跨能力请求先写入不可变请求，再登记到原 Work 的 `commands.json`；原 Work 结束后按顺序启动独立能力 Work，挂起时保留待办并让原 Run 先恢复。`getCapabilityTaskPlan` 从请求和步骤检查点返回实际进度，未登记的孤立文件不构成接纳。`tender.analyze`、`outline.generate` 和 `document.review` 只接受项目范围；整书审核重新核对已完成正文并更新全局合规与整书验收记录，不启动 Writer 或改写正文。`docx.export` 只能作为任务最后一步，在前序能力正式结算后使用独立 Word 导出；导出提示包含正文快照摘要。执行父会话只由 Host 阶段指令启动模型回合，Child 报告和结算通知不能触发额外父会话执行。局部任务成功不推进或倒退默认整本路线，首次 S2–S5 确认仍由原生阶段入口执行。

S3 的评分响应点拆解与语义复核都上报 `analyzing`，对应计划第一步；`reviewing` 只用于目录确定性校验通过后的目录质量复核。首次执行和候选恢复遵守相同的进度含义，评分响应点复核失败时不标记目录生成或校验已完成。

## Model Experience
## S2–S5 质量控制

S3 初次生成、按反馈重新生成和目录修复均由 Host 固定第一章为“技术偏离表”，使用 `dsh-technical-deviation-table`、`parent_id=null`、`order=1`、`level=1`、`writable=true`。自动补入的章节保留空需求与评分归属；S4 按该固定 ID 读取全部技术需求作为只读研究上下文，实质性正文覆盖仍由后续章节承担。

S2 首次提取后立即执行 Validator；通过时进入 `tender_analysis/waiting_user`。技术评分提取先以 grep 定位评分区域，再从 `chunks/index.json` 的相邻关系读取连续小窗口，并只用一次轻量 grep 寻找远距离的额外评分区域。Requirement、Scoring item 和 Compliance item 的 `raw_text` 可以在引用原文含义内提取、压缩、去冗余和原子化，但不得改变关键数字、单位、强制语义或新增要求。每条 Project fact、Requirement、Scoring 和 Compliance 提交及 Review phase 都原子写入 Run 栅栏保护的 `analysis/tender-analysis-checkpoint.json`；恢复校验 tender 文件身份并把中断的 reviewing 收敛到 `review_required`。正式 Artifact 已完整通过 Validator 时直接复用，否则从检查点继续。重置任一阶段会取消待处理输入，并从模型可见上下文移除该阶段及后续阶段的消息；原始会话日志仍用于审计和回放。

S3 先按评分语义产生候选响应点，再由独立语义复核回看评分场景是否完整；Host 用评分 Artifact 哈希和单调序列建立稳定目录。Agent 随后以 Response Point、Requirements、Compliance 和可选人工框架生成初始目录，按主框架、补充框架和无关框架明确适配，并在 Section 上保存精确 `framework_refs`。目录只组织需要向采购方展开的技术方案、实施措施和交付成果；纯投标资格、企业资质证书及行政递交要求留在 `global_compliance_ids`，不生成要求解读章节。目录质量复核负责语义粒度；Host 只校验确定性的 Schema、树、ID、覆盖和框架引用，不要求响应点全局唯一归属。用户确认结果保存为 `outline/initial-confirmed-outline.json`。

S3 的 JSON 格式修复保留原文且只允许序列化标点与空白变化；字段错误只修改定位范围，未知 RP 或评分由模型重新选择合法关联。RP 覆盖、需求/合规/框架引用与结构问题使用有相应字段权限的局部操作，非法操作不覆盖候选。质量复核在同轮提交全部必要修改、自检修改后的目录并返回非阻断建议；Host 应用操作并通过确定性校验后发布质量报告及待确认草稿。可选润色只作为建议，合法修改不会触发新一轮完整复核。格式或操作错误使用独立的 `maxRepairAttempts` 重试预算，耗尽后保留目录供继续运行。正式输入损坏或版本变化要求通过阶段重置处理。S3 与 S4 目录复核的模型输出不包含问题代码或编号：建议只返回 `severity` 与 `message`，S4 阻断问题只返回职责索引中的 `section_position` 与 `reason`；程序分别填写固定诊断类别 `OUTLINE_QUALITY_ADVISORY` 和 `OUTLINE_STRUCTURE_REVIEW`。

S4 按目录业务分支分批映射，Evidence 以 Section ID 保存。模型工具使用目录、业务对象、研究依据、材料和复核条目的位置；程序绑定身份并生成覆盖记录。结构或材料变化后用 `list_mapping_objects` 获取最新位置表。Initial Child 逐次编辑并锁定自己的业务分支，再用 `submit_section_mapping` 按章 upsert；Host 当场校验 Section、短文件引用、分块、usage、Web 正文和 coverage，并由 `finish_mapping_task` 返回缺失章节。未完成时，修复轮次同时接收 Host 根据当前研究、Blueprint、结构判断、锁定、映射和复核状态生成的顺序清单，避免仅凭错误文本猜测下一项工具调用。Final Check 以既有 Mapping 为 baseline，只提交替换章和结构节点摘要；摘要以我方方案、措施和成果直接作答，不复述采购要求，也不显示项目内部追踪 ID。目录深化与用户编辑只对齐 Evidence，空材料由 S5 按缺口继续研究。单个 Mapping Task 只对显式的子任务物化、恢复和结果通道故障做固定有界重试；429、Provider 文本和 retry-after 不在 S4 内解释或退避，由统一 Run 挂起与恢复边界处理。最终 Evidence Map 格式与 S5 输入保持不变。详见 [S4–S5 资料映射规则](README.md#s2s5-quality-control)。

S5 的首次整体要求由 Host 使用 Interaction Session 的原生 `ask_user_question` 询问，并将回答保存到 `chapters/writing-request.json`；Main Agent 从 `task_contract_context.writing_request` 读取回答。自定义回答由 Host 原样加入首次 Writing Plan 顶层 `user_requirements`，原生回答不伪造 `user_message_refs`；Main Agent 选择真实用户消息的位置，Host 绑定 Session、Message 和 Seq 并回查原文。首次提交包含完整 Task Contract；后续提交 patch，Host 绑定当前版本，分别更新全书指令、document acceptance、section task、section acceptance 和删除项。Host 保留未修改章节及其 `AC-*`，把实际提交 section patch 自动并入影响范围，并校验 AC 全局唯一及 scope 与容器一致。普通进度询问可以不引用，因此不会修改 Task Contract 或停止 Writer；没有额外动态要求时 section 和 document criteria 可以为空。

动态 acceptance 与 Requirement、Scoring Response Point、Compliance 的 `covered/missing` 覆盖协议彼此独立。语义条件由相应 Reviewer 选择 `criterion_position` 并提交 `met/unmet`、正文 quote 引用和 reason，程序绑定实际 Criterion ID；否定条件可以在 `unmet` 时引用违规句，整章或整书判断可以不提交单句 quote。确定性条件只由 Host 按显式 metric 计算，Reviewer 不能覆盖。Chapter Reviewer 是 section acceptance 的唯一权威，required 失败会回到原 Writer 并重新审核；Final Main Agent 只判断 document semantic acceptance、消费章节权威结果并选择最小修复范围，不能重判 section criterion。整书判断需要正文时可通过只读工具按 Section 位置获取最多 12,000 字符的当前完成正文。

S5 只把 `outline/confirmed-outline.json` 作为章节结构来源。Main Agent 根据当前 Task Contract 生成绑定 Writing Plan 版本的章节关系计划；共用背景、资料或业务流程先后不构成写作强依赖，只有必须消费前章具体决策、成果结构或最终索引时才使用 `depends_on`。Writing Plan 更新后，Main Agent 重新判断受影响范围的 `depends_on`、`related_sections`、章节规划说明和全书一致性说明，Host 校验 DAG 并按实际强依赖传播失效。Host 按每个 Section 的 `framework_refs` 注入精确框架正文分块；框架正文是可保留、适配或改写的写作输入，不是当前项目事实 Evidence。每份有效候选正文和 Metadata 在 Reviewer 启动前即可读取；Reviewer 没有工作区或网络工具。正文以我方拟采用的方案、措施、职责、成果和承诺直接作答；主要复述采购要求、解释资格条件或采用需求分析口吻时，Reviewer 通过 `bidder_response_voice` 要求原 Writer 修订。企业事实缺少本地依据时只保留在 `unresolved_topics`，不在客户正文生成要求解读、无依据承诺或占位内容，也不得由框架或 Web 资料替代。明确作为拟议方案的实施方法、分工、台账字段与质控措施，只要不违背采购要求，不因原文未逐项列出而自动判为无依据。目录、总述及正文不得显示内部 Requirement、Scoring、Compliance、Response Point、Section 或 Acceptance Criterion ID；招标原文自身使用的同名条款编号不受影响。

最终 Validator 不依赖 Final Main Agent 复述章节判断，而是独立校验当前计划版本的全部 required section 结果来自最新 Chapter Reviewer、required document 结果来自最终整书验收、确定性结果等于 Host 当前事实，并复核 Writer 启动时的计划、章节与依赖身份以及最终 Reviewer 对当前 Evidence 的输入身份。通过后才发布 S5 完成状态。

S5 完成后项目保持 `chapter_writing/completed`，审核项标签和逐章状态常驻。审核工作台中的“导出 Word”调用 Host `exportDocx`，程序核对章节 manifest 的确认目录哈希、完整章节集合及正文路径，再按确认目录顺序保留结构标题并组合正文；组合结果仍含项目内部 ID 时拒绝导出。每次成功导出在 `outputDirectory` 写入一对带时间标识的 Markdown 和 DOCX 文件。导出成功或失败都不改变 S5 状态，可重复执行。已经保存为 `docx_export/completed` 的旧项目同样保留审核工作台和导出动作。

流程图属于 S5 章节的结构化 metadata。Writer 提交语义 `key` 和正文中的 `{{flowchart:key}}`，Host 生成 `FLOW-*` 与节点 ID，并校验每张图恰好有一个 anchor；`{{flow_ref:key}}` 在导出快照中按图形顺序解析为图号。同名图在各章分别编号，引用优先绑定本章图形；跨章引用须使用全书唯一的语义键，源正文不改写。浏览器预览继续使用 SVG。正式 Word 导出在 Windows 上先用 PowerShell COM 创建原生 Visio Shape 和 Connector，再由 Word COM 在正文 marker 处以 `LinkToFile=false` 嵌入对应 VSDX；Word 或 Visio 不可用时以 `VISIO_RUNTIME_UNAVAILABLE` 或 `WORD_RUNTIME_UNAVAILABLE` 失败，不降级为图片。

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
- 原生 Visio 导出需要已注册的 Microsoft Word 和 Microsoft Visio COM；非 Windows 环境以及缺少任一 Office 应用时不会生成静态图片替代品。
- DOCX 模板只提取支持的页面、Theme、段落、表格与编号样式，不复制旧正文、封面、图片、浮动对象、批注或页眉页脚文字；模板正文最多保存前 2000 段供格式说明解释。

文件接入按文件返回结果：名称、格式、大小、二进制长度或解析失败会附带文件名、角色、稳定错误码和错误消息，不阻断同批次的其他有效文件；至少一个成功解析的招标文件才能推进阶段。

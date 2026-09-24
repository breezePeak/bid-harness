# 标书能力与控制面

标书项目由 [Bid 包](../../packages/bid/bid/README.zh.md)提供项目级资料、阶段任务、能力调度和成果状态。主会话可按用户要求组合局部能力；项目级写任务串行，读取项目上下文不会创建写入任务。具体状态、文件格式和恢复语义由包文档及其契约定义。

## Cordis 服务与事件

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

本区由 `scripts/gen-cordis-catalog.ts` 根据源码生成，`pnpm run verify-cordis-catalog` 检查内容是否最新。签名代码块保留源码 JSDoc；事件派发模式见 [Cordis 入门](../cordis-primer.zh.md#dispatch-modes)，框架继承的 `ctx` API 见 [Cordis API](../cordis-api/inherited.md)。

<a id="ctxbid--bidhostruntime"></a>

### `ctx.bid` — `BidHostRuntime`

Host-owned Bid RPC runtime that serializes stage mutations and publishes durable stage state.

```ts cordis-catalog
/**
 * 安装能力步骤执行器；后续能力适配器共用此单一 Run 入口。
 * @param dispatcher 负责授权文件、执行和业务校验的适配器。
 * @returns 仅移除当前注册实例的 disposer。
 */
registerCapabilityTaskDispatcher(dispatcher: CapabilityTaskDispatcher): () => void

/**
 * Rewind to the current or an earlier Bid stage and apply its fixed restart policy.
 * Active work is cancelled and drained before artifacts owned by the selected
 * stage and every later stage are removed.
 * @param agent - live Bid Agent receiving the scoped command.
 * @param stage - current or earlier stage named by that command.
 * @returns S2-S4 已提交的 ready 状态；S1 与 S5 返回 waiting_user。
 */
async resetStage(agent: Agent, stage: BidStage): Promise<BidTaskState>

/**
 * Ask the Main Agent for manual S5 writing requirements.
 * @param session - live Bid Session waiting before chapter writing.
 * @param intent - whether to ensure or retry the writing request.
 * @returns the unchanged waiting state after the request is durably queued.
 */
@Remote('requestWritingRequirements') async requestWritingRequirements( session: Session, intent?: WritingEntryIntent, ): Promise<BidChapterWritingGateResult>

/**
 * Start S5 with a Host-generated plan that contains no user requirements.
 * @param session - live Bid Session waiting before chapter writing.
 * @returns the state reached through the existing confirmed-stage orchestrator.
 */
@Remote('autoStartChapterWriting') async autoStartChapterWriting(session: Session): Promise<BidChapterWritingGateResult>

/**
 * 停止当前会话回复及项目后台 Run，保留待处理的用户消息。
 * @param session 发起停止的 Bid 主会话。
 * @returns 后台任务停止并保存状态后确认接受。
 */
@Remote('stopRun') async stopRun(session: Session): Promise<{ accepted: true }>

/**
 * Import and validate one browser-selected file batch for the current Bid stage.
 * @param session - Host-resolved live Session; only its header supplies workspace identity.
 * @param files - Browser file metadata and canonical base64 bytes.
 * @returns the next runtime state or one stable business rejection.
 */
@Remote('uploadFiles') async uploadFiles(session: Session, files: readonly BidUploadFile[]): Promise<BidFileIntakeResult>

/**
 * Run the common S1 admission, persistence, manifest validation, and stage transition for raw bytes.
 * @param session - live Session selected by the browser transport.
 * @param incoming - every decoded selected file in request order.
 * @param failures - file-level transport decode failures retained for an S1 failure.
 * @returns the durable S1 outcome.
 */
async uploadIncomingFiles( session: Session, incoming: readonly IncomingFile[], failures: readonly BidFileIntakeFileResult[] = [], ): Promise<BidFileIntakeResult>

/**
 * 接纳一个由真实用户消息授权的能力序列。
 * @param agent 公开主会话的 Agent。
 * @param task 有序能力步骤与任务范围。
 * @param authorization 用户消息身份。
 * @param inputPaths 本次任务读取的正式输入文件。
 * @param onAdmitted Run 落盘后调用的可选接纳回调。
 * @returns Run 结算后的项目状态。
 */
async runCapabilityTask( agent: Agent, task: BidCapabilityTask, authorization: CapabilityTaskRequest['authorization'], inputPaths: readonly string[], onAdmitted?: (run: BidRunContext) => Promise<void>, ): Promise<BidTaskState>

/**
 * Resume one exact suspended Run after checking its project revision and durable checkpoints.
 * @param session - Bid Session that owns the suspended Run.
 * @param suspendedRunId - Exact suspended attempt selected by the client.
 * @param expectedProjectRevision - Project revision observed by the client.
 * @param onAccepted - Callback invoked after the replacement Run is durable.
 * @param recovery - Bound Goal request revalidated and recorded inside the project lock.
 * @returns State reached when the resumed work next settles.
 */
async resumeCurrentRun( session: Session, suspendedRunId: string, expectedProjectRevision: number, onAccepted?: (run: BidRunContext) => void, recovery?: { goalId: string; instruction: string }, ): Promise<BidTaskState>

/** 读取项目 Word 模板列表，不解析模板或生成文件。
 * @param session 当前标书会话。
 * @returns 模板身份、页数基准和各模板格式摘要。
 */
@Remote('getDocxTemplateLibrary') async getDocxTemplateLibrary(session: Session): Promise<DocxTemplateLibraryView>

/** 读取一份明确的项目 Word 配置，不解析模板或生成文件。
 * @param session 当前标书会话。
 * @param templateId 模板 ID；null 明确选择系统默认格式。
 * @returns 已保存格式与来源。
 */
@Remote('getDocxFormat') async getDocxFormat(session: Session, templateId: DocxTemplateId | null): Promise<DocxFormatView>

/** 保存一份模板的项目格式，独立于 S1—S5 的资料与阶段状态。
 * @param session 当前标书会话。
 * @param templateId 模板 ID；null 表示系统默认格式。
 * @param request 包含版本及用户配置的请求；模板字节使用独立二进制端点。
 * @returns 保存后的格式。
 */
@Remote('saveDocxFormat') async saveDocxFormat(session: Session, templateId: DocxTemplateId | null, request: DocxFormatRequest): Promise<DocxFormatView>

/** 修改 S5 页数基准，不改变 S6 当前选择或任一模板格式。
 * @param session - 当前标书会话。
 * @param templateId - 页数测算模板；null 表示默认格式。
 * @param revision - 要修改的配置版本。
 * @returns 保存后的模板库视图。
 */
@Remote('setEstimateDocxTemplate') async setEstimateDocxTemplate( session: Session, templateId: DocxTemplateId | null, revision: number, ): Promise<DocxTemplateLibraryView>

/** 使用已保存配置和固定正文快照生成浏览器预览，不完成 S6。
 * @param session 当前标书会话。
 * @param templateId 模板 ID；null 表示系统默认格式。
 * @returns 带内容标识的样式预览。
 */
@Remote('previewDocx') async previewDocx(session: Session, templateId: DocxTemplateId | null): Promise<DocxFormatView>

/** 生成待确认的格式建议，不修改模板、正文或生效配置。
 * @param session 当前标书会话。
 * @param templateId 模板 ID；系统默认格式不需要模型建议。
 * @returns 带来源原文的建议。
 */
@Remote('suggestDocxFormat') async suggestDocxFormat(session: Session, templateId: DocxTemplateId): Promise<DocxFormatSuggestion>

/** 下载当前项目最近一次成功的 Word，不接受浏览器文件路径。
 * @param session 当前标书会话。
 * @param templateId 本次导出使用的模板 ID；null 表示系统默认格式。
 * @returns 下载名称和文件字节。
 */
@Remote('downloadDocx') async downloadDocx(session: Session, templateId: DocxTemplateId | null): Promise<{ data: string; name: string }>

/**
 * 按完整目录和已保存正文生成 Word，不暂停写作，也不离开审核阶段；导出不代表审核通过。
 * @param session 当前项目的 Bid 会话，无需持有阶段操作。
 * @param templateId 本次导出使用的模板 ID；null 表示系统默认格式。
 * @returns 新文件信息，或稳定的拒绝结果。
 */
@Remote('exportDocx') async exportDocx(session: Session, templateId: DocxTemplateId | null): Promise<BidDocxExportResult>

/** 使用正式 Renderer 尝试核验指定模板的当前导出页数。
 * @param session - 当前标书会话。
 * @param templateId - 待测算模板；null 表示默认格式。
 * @returns 页数估算及其配置基准。
 */
@Remote('estimateDocxPages') async estimateDocxPages(session: Session, templateId: DocxTemplateId | null): Promise<import('./control-plane-contract.ts').BidPageEstimate>

/**
 * 将用户意见交给目标章节原 Writer；整个操作互斥，失败保留正文。
 * @param session 发起修订的 Bid 会话。
 * @param request 章节或完整连续段落引用与编写意见。
 * @returns 新正文，或可重新选择原文后重试的业务错误。
 */
@Remote('reviseChapter') async reviseChapter(session: Session, request: BidChapterRevisionRequest): Promise<BidChapterRevisionResult>

/**
 * Read the live S5 writing and per-chapter review state without disclosing workspace paths.
 * @param session Bid Session whose writing workbench is requested.
 * @returns Browser-safe chapter workbench rows and aggregate progress.
 */
@Remote('getReviewWorkbench') async getReviewWorkbench(session: Session): Promise<BidReviewWorkbenchView>

/**
 * 读取 S5 叶节正文及审查结果，或父节点在确认目录中保存的概述。
 * @param session 持有章节产物的 Bid 会话。
 * @param sectionId 确认目录中的章节 ID。
 * @returns 浏览器可展示的章节正文、证据和审查状态。
 */
@Remote('getReviewChapter') async getReviewChapter(session: Session, sectionId: string): Promise<BidReviewChapterView>

/**
 * 读取当前审批意见队列；不持有项目锁，仅读取持久化文件。
 * @param session Bid 会话。
 * @returns 浏览器安全的审批意见队列视图。
 */
@Remote('getRevisionQueue') async getRevisionQueue(session: Session): Promise<BidRevisionQueueView>

/**
 * 读取一条已完成审批意见所属 batch task 的完整前后正文。
 * @param session Bid 会话。
 * @param issueId 审批意见身份。
 * @returns 精确历史 comparison；旧记录不伪造缺失快照。
 */
@Remote('getRevisionComparison') async getRevisionComparison(session: Session, issueId: string): Promise<BidRevisionComparisonResult>

/**
 * 向队列追加一条 `pending` 审批意见；不启动任何 Writer。
 * @param session Bid 会话。
 * @param request 浏览器提交的意见输入。
 * @returns 更新后的队列视图，或可重新选择原文后重试的业务错误。
 */
@Remote('addRevisionIssue') async addRevisionIssue(session: Session, request: BidAddRevisionIssueRequest): Promise<BidRevisionQueueResult>

/**
 * 编辑一条 `pending` 审批意见的 instruction/suggestion/reference。
 * @param session Bid 会话。
 * @param request 浏览器提交的编辑输入。
 * @returns 更新后的队列视图，或可重新选择原文后重试的业务错误。
 */
@Remote('updateRevisionIssue') async updateRevisionIssue(session: Session, request: BidUpdateRevisionIssueRequest): Promise<BidRevisionQueueResult>

/**
 * 物理删除一条 `pending` 审批意见；其他状态拒绝浏览器直接删除。
 * @param session Bid 会话。
 * @param request 浏览器提交的删除输入。
 * @returns 更新后的队列视图，或可重新选择原文后重试的业务错误。
 */
@Remote('deleteRevisionIssue') async deleteRevisionIssue(session: Session, request: BidDeleteRevisionIssueRequest): Promise<BidRevisionQueueResult>

/**
 * 读取当前能力 Work 或已登记请求的计划；只返回检查点中的步骤状态。
 * @param session 项目公开主会话。
 * @returns 最近任务的只读摘要；尚无能力任务时为 null。
 */
@Remote('getCapabilityTaskPlan') async getCapabilityTaskPlan(session: Session): Promise<BidCapabilityPlanView | null>

/**
 * Read the current S4 Mapping Task counts while evidence mapping is active or reviewable.
 * @param session - Bid Session that owns the S4 execution log.
 * @param observed - caller projection used to reject stale observations.
 * @returns task counts, or null when S4 has not reached an observable state or has not produced its log.
 */
@Remote('getEvidenceMappingProgress') async getEvidenceMappingProgress( session: Session, observed?: BidClientProjection, ): Promise<BidEvidenceMappingProgress | null>

/**
 * 组装 Bid 详情页可读取的已发布阶段产物。
 * @param session 持有已恢复项目状态的 Bid 会话。
 * @returns 已发布的招标信息、目录和正文入口；S4 等待确认时使用已生成目录，执行中保留 S3 确认目录。
 */
@Remote('getDetails') async getDetails(session: Session): Promise<BidDetailsView>

/**
 * 读取 S2 待确认或已确认结论；编辑准入仍由 confirmTenderAnalysis 校验。
 * @param session 持有招标分析产物的 Bid 会话。
 * @returns 分析产物及评分响应项选择状态。
 */
@Remote('getTenderAnalysisForConfirmation') async getTenderAnalysisForConfirmation(session: Session): Promise<TenderAnalysisConfirmationView>

/**
 * Persist one S2 scoring-response decision before final confirmation.
 * @param session Bid Session waiting at the S2 confirmation gate.
 * @param scoringId Stable original scoring item id.
 * @param selected Whether the item enters the downstream response workflow.
 * @returns Updated S2 confirmation view.
 */
@Remote('setTenderScoringSelection') async setTenderScoringSelection( session: Session, scoringId: string, selected: boolean, ): Promise<TenderAnalysisConfirmationView>

/**
 * Apply controlled S2 edits, revalidate canonical artifacts, and continue only after explicit confirmation.
 * @param session Bid Session waiting at the S2 confirmation gate.
 * @param operations Validated edits to canonical tender-analysis artifacts.
 * @returns Confirmation result and resulting runtime state, or a stable rejection.
 */
@Remote('confirmTenderAnalysis') async confirmTenderAnalysis( session: Session, operations: readonly TenderAnalysisEditOperation[], ): Promise<BidTenderAnalysisConfirmationResult>

/**
 * Read the S4 draft only while its user-confirmation stage owns the session.
 * @param session Bid Session waiting for outline confirmation.
 * @returns Current editable outline artifact.
 */
@Remote('getOutlineForConfirmation') async getOutlineForConfirmation(session: Session): Promise<OutlineArtifact>

/**
 * 读取或初始化 S3/S4 等待用户确认的持久化 Draft。
 * @param session 等待目录确认的 Bid 会话。
 * @returns 当前 Draft 及用于 CAS 编辑的身份。
 */
@Remote('getOutlineDraft') async getOutlineDraft(session: Session): Promise<OutlineDraftView>

/**
 * 读取目录差异审阅所需的上游事实和基线。
 * @param session 等待目录确认的 Bid 会话。
 * @returns S3 确认基线及已有章节关联资料；不运行生成或映射。
 */
@Remote('getOutlineReviewContext') async getOutlineReviewContext(session: Session): Promise<OutlineReviewContext>

/**
 * 使用 CAS 保存目录编辑；仅校验结构和覆盖，S4 语义复核留到最终确认。
 * @param session 等待目录确认的 Bid 会话。
 * @param request 携带 Draft 身份的结构编辑操作。
 * @returns 更新后的 Draft，或冲突及校验问题。
 */
@Remote('applyOutlineDraftOperations') async applyOutlineDraftOperations(session: Session, request: OutlineDraftMutationRequest): Promise<OutlineDraftMutationResult>

/**
 * 确认 Draft 前仅复核语义变化的 S4 可写章节；校验失败恢复已发布产物并保留 Draft。
 * @param session 等待目录确认的 Bid 会话。
 * @param request 用于拒绝过期提交的 Draft 身份。
 * @returns 确认后的运行状态，或稳定拒绝。
 */
@Remote('confirmOutline') async confirmOutline(session: Session, request: OutlineDraftIdentityRequest): Promise<BidOutlineConfirmationResult>

/**
 * Regenerate a temporary S4-quality candidate from the current persisted S5 draft.
 * @param session Bid Session waiting for outline confirmation.
 * @param request Current draft identity and the user's regeneration feedback.
 * @returns Updated draft candidate and change set, or a stable rejection.
 */
@Remote('regenerateOutline') async regenerateOutline( session: Session, request: OutlineDraftIdentityRequest & { readonly feedback: string }, ): Promise<BidOutlineRegenerationResult>
```

Types: [Agent](core.zh.md) · [Session](session.zh.md)

Source: [`packages/bid/bid/src/index.ts`](../../packages/bid/bid/src/index.ts)
<!-- END GENERATED cordis-surface -->

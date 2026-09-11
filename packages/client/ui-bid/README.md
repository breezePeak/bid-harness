# @deepseek-ai/dsh-client-ui-bid

English | [中文](README.zh.md)

Bid Session browser UI. The plugin contributes `BidStagePanel` to the conversation-declared `conversation.input.dock` list and renders only when the Host-resolved Session preset is `bid` and the `bid.runtime` projection is available. The compact dock row uses the existing DSH composer geometry, state indicator, typography, and button primitives to show only the current `projection.runtime` stage and status; DSH transcript, Todo, and tool renderers remain the execution-progress UI. The client does not fold Bid events, advance stages, derive permissions, or keep a local stage or status.

`projection.allowedActions` controls upload, retry, outline-confirmation, and Word-export controls, while the Host-projected file limits configure the picker and its rule text. File selection keeps browser `File` objects locally until the user explicitly uploads the batch. These actions use dedicated Bid Host entry points and never call `session.prompt()`.

The panel mirrors `projection.composer.enabled` and its stable reason code into `ctx.conversation.blocks` for the same Session. The review-items view remains available throughout S5 and after S5 completes, retaining chapter and Reviewer status plus an on-demand Word export button. Existing `docx_export/completed` projects render as completed S5 projects. A non-Bid preset or unavailable projection clears the block and hides the panel, preserving the ordinary composer and attachment path for non-Bid Sessions.

After an S2–S5 reset, the panel renders the Host-owned `waiting_start` state, keeps the composer disabled, and exposes one “Start this stage” action backed by `bid/startStage`. Reset itself never starts model execution.

输入框左侧工具栏为每个 Bid Session 提供“手动确认 / 自动确认”选择，默认手动且不写入项目状态。自动确认模式在 S2 使用审核页当前编辑结果确认；S3/S4 等待 Draft 保存后，按阶段、revision 和 SHA-256 最多提交一次确认；S5 调用正式 Host Action 生成无用户原话的默认 Writing Plan 并启动正文。自动操作失败不循环重试，`failed` 与 `waiting_start` 始终保留人工处理。

## Word 导出页面

正文工作台的“导出 Word”打开同级详情页签，正文详情仍可切换。页签首次打开后随项目保存，新会话和刷新可恢复已保存配置。左侧提供模板上传、样式候选、各组实际值与来源、格式描述建议及覆盖差异；右侧通过“更新预览”显示样式，通过“生成 Word”执行导出，成功后提供下载。上传、保存和预览不完成 S6，切换页签不重复解析或生成。修改配置后提示预览及文件需要更新，生成失败保留上一份下载。

预览标注“样式预览，分页以 Word 为准”，缺失的标题、列表、表格、图片与题注采用明确标记的样例，不写入正文。样式映射按用途筛选候选，首行缩进可选择字符或毫米，文字颜色和正斜体可逐组编辑。生成按钮旁显示进度、错误和待确认角色；用户选择模板样式或点击“未确认项使用默认方案”后才能生成。模型建议必须由用户应用；模型不可用时仍能手动编辑并生成。

## Model Experience

None, as this browser UI package adds no prompt content, ordinary Session prompt, tool schema, or model-visible Bid input; the Host Bid packages own file persistence, workflow events, and automatic confirmation actions.

#### KV Cache effect

Rendering Bid projections, selecting local files, and choosing confirmation mode do not change any model request prefix.

## Known Limitations and Deferred Work

- **File intake uses one JSON/base64 request** — browser and Host memory include the encoded batch within the configured limits.
- **The panel is a business-status row** — it does not duplicate the DSH task list or tool-call tree.

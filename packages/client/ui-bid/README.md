# @deepseek-ai/dsh-client-ui-bid

English | [中文](README.zh.md)

Bid Session browser UI. The plugin contributes `BidStagePanel` to the conversation-declared `conversation.input.dock` list and renders only when the Host-resolved Session preset is `bid` and the `bid.runtime` projection is available. The compact dock row uses the existing DSH composer geometry, state indicator, typography, and button primitives to show only the current `projection.runtime` stage and status; DSH transcript, Todo, and tool renderers remain the execution-progress UI. The client does not fold Bid events, advance stages, derive permissions, or keep a local stage or status.

`projection.allowedActions` controls upload, retry, outline-confirmation, and Word-export controls, while the Host-projected file limits configure the picker and its rule text. File selection keeps browser `File` objects locally until the user explicitly uploads the batch. These actions use dedicated Bid Host entry points and never call `session.prompt()`.

The panel mirrors `projection.composer.enabled` and its stable reason code into `ctx.conversation.blocks` for the same Session. The review-items view remains available throughout S5 and after S5 completes, retaining chapter and Reviewer status plus an on-demand Word export button. Existing `docx_export/completed` projects render as completed S5 projects. A non-Bid preset or unavailable projection clears the block and hides the panel, preserving the ordinary composer and attachment path for non-Bid Sessions.

After an S2–S5 reset, the panel renders the Host-owned `waiting_start` state, keeps the composer disabled, and exposes one “Start this stage” action backed by `bid/startStage`. Reset itself never starts model execution.

## Word 导出页面

正文工作台的“导出 Word”打开同级详情页签，正文详情仍可切换。页签首次打开后随项目保存，新会话和刷新可恢复已保存配置。左侧提供模板上传、样式候选、各组实际值与来源、格式描述建议及覆盖差异；右侧通过“更新预览”显示样式，通过“生成 Word”执行导出，成功后提供下载。上传、保存和预览不完成 S6，切换页签不重复解析或生成。修改配置后提示预览及文件需要更新，生成失败保留上一份下载。

预览标注“样式预览，分页以 Word 为准”，缺失的标题、列表、表格、图片与题注采用明确标记的样例，不写入正文。样式映射按用途筛选候选，首行缩进可选择字符或毫米，文字颜色和正斜体可逐组编辑。生成按钮旁显示进度、错误和待确认角色；用户选择模板样式或点击“未确认项使用默认方案”后才能生成。模型建议必须由用户应用；模型不可用时仍能手动编辑并生成。

## Model Experience

S5 完成后可将有正文的章节名称拖入对话框，或在正文选择一个、相邻多个段落后右键选择“添加到对话框”。引用显示为独立标签，长内容缩略；输入框只填写编写意见。每次修订引用一个章节或一段连续选区。章节修改按意见决定重写幅度，段落修改严格保留选区外原文。成功后刷新正文并移除引用，失败保留引用及意见；正文版本变化时需重新选取。不支持在该修订请求中附带图片，也不提供豆包工作空间操作。

S4 审核保留 S3 已确认目录、S4 当前目录和章节详情三栏。两侧通过稳定 `section.id` 双向选择并展开对应祖先，各自滚动且避开底部聊天区；新增与删除章节明确提示无对应章节，删除章节的 S3 原内容只读。差异按标题、编写要求、关联信息、父节点及稳定同级顺序分类，详情列出具体增减和前后路径；“仅看变化”保留祖先和当前联动上下文。展示编号顺延、对象属性顺序和集合关联 ID 排列不构成修改。

“目录详情”依据 Host 持久化产物来源选择展示模式。S3 初步目录为两列；S4 最终目录确认后，在 S5/S6 继续保留三列、差异和已有资料上下文，并标记“最终目录已确认 / 只读”。只读关闭确认、编辑、拖拽、删除和保存状态，仍可导航、搜索、折叠与查看变化；“正文详情”独立保留。基线或资料读取失败明确展示文件错误，不因空资料、零差异或阶段推进退回初步目录模式。

章节写作工作台支持点击各级父节点，在阅读区标题下查看 S4 已确认的简短概述，了解下属章节的主要内容；父节点状态标为“章节概述”，资料栏引导查看子章节依据。默认优先打开已有正文的叶节，尚无正文时可阅读父节点概述；刷新保留当前章节。父节点概述不提供正文修订引用。写作工作台按祖先到当前章节的 `order` 显示完整层级编号，与正文标题编号一致；折叠不改变编号，悬停显示完整编号与标题。

S5 审核结果按责任范围分开展示：章节正文缺口和章节职责冲突进入对应章节详情；跨章节或整本文档问题进入独立的“文档级问题”；签署、盖章、格式交付等没有执行证据的事项进入“交付待办”。文档级问题与交付待办不增加章节红点或章节问题计数，三处均只呈现 Host 已保存并校验的报告。

工作台保留 Host 返回的当前请求错误。阶段或状态切换会清除阶段卡片中上一操作的旧错误并使在途操作失效，文件接入的部分失败仍保留供用户核对；刷新、选择章节和阶段切换会使正文工作台的旧请求结果失效，迟到响应不能覆盖当前页面；重置后尚无正文时清空旧正文。

S2/S3/S4 等待确认时，Composer 跟随 Host projection 开放；正式确认和重新生成按钮独立保留。阶段交互执行时临时阻止发送，完成后按新的 projection 自动读取 Draft revision 和映射进度，显示“已更新，请重新确认”。客户端不从聊天文本推导确认，也不自行推进阶段。

None directly. This package adds no prompt content and sends no ordinary Session prompt; the Host owns file persistence, workflow events, and every model-visible Bid input.

#### KV Cache effect

None. Rendering a projection and selecting local files do not change the model request prefix.

## Known Limitations and Deferred Work

- **File intake uses one JSON/base64 request** — browser and Host memory include the encoded batch within the configured limits.
- **The panel is a business-status row** — it does not duplicate the DSH task list or tool-call tree.

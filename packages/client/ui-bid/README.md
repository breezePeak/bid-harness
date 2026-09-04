# @deepseek-ai/dsh-client-ui-bid

English | [中文](README.zh.md)

Bid Session browser UI. The plugin contributes `BidStagePanel` to the conversation-declared `conversation.input.dock` list and renders only when the Host-resolved Session preset is `bid` and the `bid.runtime` projection is available. The compact dock row uses the existing DSH composer geometry, state indicator, typography, and button primitives to show only the current `projection.runtime` stage and status; DSH transcript, Todo, and tool renderers remain the execution-progress UI. The client does not fold Bid events, advance stages, derive permissions, or keep a local stage or status.

`projection.allowedActions` controls upload, retry, outline-confirmation, and Word-export controls, while the Host-projected file limits configure the picker and its rule text. File selection keeps browser `File` objects locally until the user explicitly uploads the batch. These actions use dedicated Bid Host entry points and never call `session.prompt()`.

The panel mirrors `projection.composer.enabled` and its stable reason code into `ctx.conversation.blocks` for the same Session. The review-items view remains available throughout S5 and after S5 completes, retaining chapter and Reviewer status plus an on-demand Word export button. Existing `docx_export/completed` projects render as completed S5 projects. A non-Bid preset or unavailable projection clears the block and hides the panel, preserving the ordinary composer and attachment path for non-Bid Sessions.

## Model Experience

目录确认与章节写作工作台在父节点标题下显示简短 summary，折叠子树后仍可了解下属章节的主要内容。写作工作台按祖先到当前章节的 `order` 显示完整层级编号，与正文标题编号一致；折叠不改变编号，悬停显示完整编号与标题。

工作台保留 Host 返回的当前请求错误。阶段或状态切换会清除阶段卡片中上一操作的旧错误并使在途操作失效，文件接入的部分失败仍保留供用户核对；刷新、选择章节和阶段切换会使正文工作台的旧请求结果失效，迟到响应不能覆盖当前页面；重置后尚无正文时清空旧正文。

S2/S3/S4 等待确认时，Composer 跟随 Host projection 开放；正式确认和重新生成按钮独立保留。阶段交互执行时临时阻止发送，完成后按新的 projection 自动读取 Draft revision 和映射进度，显示“已更新，请重新确认”。客户端不从聊天文本推导确认，也不自行推进阶段。

None directly. This package adds no prompt content and sends no ordinary Session prompt; the Host owns file persistence, workflow events, and every model-visible Bid input.

#### KV Cache effect

None. Rendering a projection and selecting local files do not change the model request prefix.

## Known Limitations and Deferred Work

- **File intake uses one JSON/base64 request** — browser and Host memory include the encoded batch within the configured limits.
- **The panel is a business-status row** — it does not duplicate the DSH task list or tool-call tree.

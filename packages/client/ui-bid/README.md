# @deepseek-ai/dsh-client-ui-bid

English | [中文](README.zh.md)

Bid Session 浏览器 UI。插件向 Conversation 声明的 `conversation.input.dock` 列表注册 `BidStagePanel`，只在 Host 解析的 Session preset 为 `bid` 且存在 `bid.runtime` 投影时渲染。运行或取消中的阶段把当前 `run.progress.phase` 映射为 S1–S6 有序计划并使用共享 `PlanListPanel`；插件不注册 Bid Run Chat Node，也不写入 `todo/write`。挂起、失败、等待和完成状态保留阶段状态行及适用控件。客户端不折叠 Bid 事件、不推进阶段、不推导权限，也不保存本地阶段或状态。

`projection.allowedActions` controls upload, retry, outline-confirmation, and Word-export controls, while the Host-projected file limits configure the picker and its rule text. File selection keeps browser `File` objects locally until the user explicitly uploads the batch. These actions use dedicated Bid Host entry points and never call `session.prompt()`.

面板把 `projection.composer.enabled` 及稳定原因码投影到同一 Session 的 `ctx.conversation.blocks`。正文工作台在 S5 运行、失败和完成后都保留章节与 Reviewer 状态；缺少企业资质、证书等项目资料的章节显示黄色状态灯且标为“待补项目资料”，正文修复问题及其他审核结果按高、中、低风险展示，不把审核未通过呈现为导出阻断。Word 按完整目录导出当前已保存正文，执行和审核状态不影响收录；缺失正文保留标题并标注，页面显示后端返回的内容范围。既有 `docx_export/completed` 项目仍按已完成 S5 展示。非 Bid preset 或缺失投影会清除 block 并隐藏面板，不影响普通会话的输入框和附件路径。

批量审核历史中的已完成意见可打开对应 task 的 Markdown 前后快照，固定左侧显示修改后、右侧显示修改前。顶层 Markdown block 组成共享双列行，新增或删除的缺失侧保留自然等高空单元格；两列共用正文阅读区的单一垂直滚动位置。旧记录缺少快照时只提示无法还原，章节标题仍提供普通正文定位。

S2–S4 reset clears downstream artifacts, publishes `ready`, and immediately drives the selected stage in the same Host operation. S5 reset publishes `waiting_user` with no Run or child execution so the existing writing-requirements flow can collect the next explicit user decision.

输入框左侧工具栏为每个 Bid Session 提供“手动确认 / 自动确认”选择，默认手动且不写入项目状态。自动确认模式在 S2 使用审核页当前编辑结果确认；S3/S4 等待 Draft 保存后，按阶段、revision 和 SHA-256 最多提交一次确认；S5 调用正式 Host Action 生成无用户原话的默认 Writing Plan 并启动正文。自动操作失败不循环重试，`failed` 与 `suspended` 始终保留人工处理。

## Word 导出页面

正文工作台的“导出 Word”打开同级详情页签，正文详情仍可切换。页签首次打开后随项目保存，新会话和刷新可恢复已保存配置。S5 运行或失败时，页面说明当前文件只包含已完成并保存的章节；同项目任意会话均可上传模板、确认格式、预览和导出，不暂停正在执行的 Writer 或 Reviewer，也不阻止 S5 启动。上传、保存和预览不完成 S6，切换页签不重复解析或生成。修改配置后提示预览及文件需要更新，生成失败保留上一份下载。

预览标注“样式预览，分页以 Word 为准”，缺失的标题、列表、表格、图片与题注采用明确标记的样例，不写入正文。样式映射按用途筛选候选，首行缩进可选择字符或毫米，文字颜色和正斜体可逐组编辑。生成按钮旁显示进度、错误和待确认角色；用户选择模板样式或点击“未确认项使用默认方案”后才能生成。模型建议必须由用户应用；模型不可用时仍能手动编辑并生成。

## Model Experience

None, as this browser UI package adds no prompt content, ordinary Session prompt, tool schema, or model-visible Bid input; the Host Bid packages own file persistence, workflow events, and automatic confirmation actions.

#### KV Cache effect

Rendering Bid projections, selecting local files, and choosing confirmation mode do not change any model request prefix.

## Known Limitations and Deferred Work

- **File intake uses one JSON/base64 request** — browser and Host memory include the encoded batch within the configured limits.
- **一个 phase 只标识当前阶段步骤** — 计划可把有序前置步骤标为完成，但 Host 报告后续 phase 后不保留分支历史。

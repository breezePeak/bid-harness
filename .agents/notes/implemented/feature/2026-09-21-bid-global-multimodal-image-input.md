# Agent Note: Bid 复用原生多模态图片链路

Status: implemented

## Problem

Bid 业务提交器可以改写章节引用文本，却只能调用纯文本发送接口，导致引用章节或段落时丢失 Composer 图片。模型配置页也无法声明自定义模型的图片输入能力。S2 只能读取 PDF 抽取文本，S5 Writer 则无法看到自己提交的流程图在 Host 中的真实渲染结果。

## Decision

Bid 不拥有独立图片协议、附件存储或视觉模型配置。主对话继续使用通用 `ImageBlock`、`AttachmentStore` 和当前 `LlmRuntime` 路由；业务 `ComposerSubmitHandler` 只能通过 framework-owned `forward` 改写文本并进入同一次普通富内容提交，图片序列化、提交身份、草稿释放和失败恢复仍由 `ConversationController` 负责。

Models 页面是模型输入能力的唯一配置入口。Pi-AI 模型编辑 `input`，DeepSeek 模型编辑 `inputModalities`；字段缺失表示继承，恢复继承会删除字段。该决策在 UI 配置范围内取代[Pi-AI 路由默认输入模态](../../implemented/architecture/2026-08-12-pi-ai-route-default-input-modalities.md)中不提供 `input` 编辑界面的限制，不改变其能力解析顺序和保守默认值。

S2 的私有 `view_pdf_page` 只接受本次执行中 `role=tender`、`parseStatus=success` 的 locator 和单个 PDF 页码。Host 使用 PDF.js 把指定原页直接渲染为 PNG、写入现有附件存储，并向同一个 S2 Main Agent 返回文本信封与 `ImageBlock`。文本定位仍优先使用 grep/read；图片不产生 OCR 文本，也不成为扫描 PDF 的伪造 source anchor。

S5 在候选通过结构、引用和 anchor 校验后，默认将 FlowchartSpec 真实渲染为 PNG，并把图片作为富内容 followup 发回提交该候选的同一个 continuable Writer。Writer 修改的仍是完整 candidate 和结构化 FlowchartSpec；Host 比较按顺序组合的最终 PNG 摘要，画面不变即完成视觉确认，画面变化最多展示四次，视觉轮次不占用正文 `maxRepairAttempts`。当前 S5 work 的 `flowchart_visual_review_policy` 命令保存在 `runs/<workId>/commands.json`，最后一条策略在挂起恢复后仍生效；`skip` 只绕过 PNG 回看，结构、anchor 与正文 Reviewer 继续执行。独立 Chapter Reviewer 不承担图片识别。

所有图片入口按实际 Writer 或 Main Agent 路由查询 `inputModalities`。明确不支持图片或无法解析路由时，操作给出可诊断问题并要求用户在 Models 页面选择支持图片的模型；任何阶段都不静默切换 Provider 或 Model。

## Alternatives considered

**新增图片识别插件、Vision ProviderManager 或第二套密钥配置。** 未采用，因为现有附件、模型目录和 Provider 请求投影已经拥有完整的图片生命周期；第二套配置会产生互相漂移的路由事实。

**先由视觉模型生成文字报告，再交给 S2 Main Agent 或 S5 Writer。** 未采用，因为中间报告会丢失原图证据并引入第二个判断主体；原页和流程图应直接进入负责业务决策的现有会话。

**让 Bid 组件自行上传图片或构造 base64。** 未采用，因为会复制准入、持久化和草稿所有权，并可能产生第二个提交身份或重复 outgoing 消息。

**对所有 PDF 页面执行 OCR 或视觉分析。** 未采用，因为 S1 的确定性文本与 source provenance 是 S2 引用校验的基础；按需单页查看足以补充复杂版式，扫描 PDF 需要另行设计页级视觉来源。

**为流程图创建独立视觉 Reviewer 或直接修改 PNG。** 未采用，因为前者无法继承 Writer 的研究和候选上下文，后者会丢掉可审核、可重渲染的 FlowchartSpec。

## Consequences

章节引用、普通聊天、queue、steer 和纯图片提交共享一条富内容发送链路；失败不会提前清除引用或图片草稿。自定义视觉模型可以从 Models 页面声明图片输入，但错误声明仍会由实际 Provider 拒绝。

S2 单页查看与 S5 流程图视觉修复都会增加附件存储和当前模型请求成本。S5 的视觉确认最多展示四次不同的真实 PNG，与正文修复预算独立。策略为 `required` 时，附件服务缺失、图片数量超限或 text-only 路由都会阻止候选假装通过；`skip` 时不请求图片能力。

## Verification

客户端测试覆盖引用消息的图片透传、image-only、queue/steer、失败保留，以及两种模型编辑器的显式能力和恢复继承。Bid 测试覆盖 PDF 页真实 PNG、越界与 locator 拒绝、ImageBlock 输出、S2 私有工具限制，以及同一 Writer 的真实流程图 followup、PNG 未变确认、可见修改后重渲染、text-only 拒绝、独立视觉轮次和跳过策略的挂起恢复。

# Agent Note: Bid 局部目录与正文迁移

Status: implemented

## Problem

目录编辑原先只改变 Draft；拆分叶节会把父章的业务引用整套复制到每个子章。已写正文仍按旧章节存在，章节 Manifest、Evidence Map、Writing Plan 和确认记录会与新目录分离，局部修改难以作为同一 Work 的可恢复结果发布。

## Decision

`outline.update` 在一个步骤候选中应用结构操作和显式业务归属，Host 从真实 Requirement、Scoring、RP 与 Compliance 清单核对 ID，然后对最终目录运行共享结构与覆盖校验。新章节 ID 由 Host 按步骤身份稳定分配；拆分子章起初不继承父章业务 ID。`outline.refine` 的独立子会话先产出结构操作，再根据 Host 新 ID 产出业务归属。

`chapter.reorganize` 读取原章节 Markdown 和 metadata，将顶层 Markdown 块连同原偏移、源正文 SHA 与块 SHA 提供给独立子会话。Host 要求每个块恰好分配一次，只有明确授权才接受删除，共享须显式标记；表格、代码和流程图 anchor 保持整块。迁移后的 metadata 保留来源资料与流程图规范，正文作为待复核草稿写入固定存储序号和 `chapters/reuse-seeds.json`，不继承旧 Writer 或 Reviewer 的完成身份。未分配原文和退役章节的旧任务、资料及 Manifest 归属分别保存在 `chapters/pending-reorganization.json` 和 `outline/reassignment.json`。

目录改变时，同一步候选同步当前目录、Draft、confirmation、Evidence Map、Writing Plan、执行计划和日志、当前 Manifest。confirmation 的 `user_task` 来源绑定真实 Work 与用户消息；旧 confirmation 缺少来源字段仍可读取。新章及内容职责改变的章节待写、待审；未变章节的正文、存储路径、验收条件 ID 和有效审核保持原样。能力步骤只申报实际改变的文件，由同一 Work 精确发布。

## Alternatives considered

**拆分时复制父章的所有业务引用和正文。** 子章会重复承担同一强制要求，正文与流程图也可能重复进入导出，无法证明每个新章的真实职责。

**让模型重写整章来完成结构修改。** 整章生成会改变没有授权重写的原文，并丢失表格、代码、图片和既有资料归属；块身份校验允许结构调整直接复用已写成果。

**每个产物单独正式发布。** 目录、确认 SHA 和 Writer 输入会经历互不匹配的中间状态；步骤候选与 Work 的最终同批发布保持可恢复的一致版本。

## Consequences

已写项目能够在同一能力 Work 中先深化目录再迁移原文；纯目录设计留下可见的待迁移与待写任务。旧正文文件保留为可恢复历史，不进入当前 Manifest。业务归属和原文块仍需要模型作语义判断，Host 只接受真实 ID、完整块和通过全局校验的结果；后续资料研究与写作能力消费重分配记录及草稿 seed。

# Agent Note: 批量修订历史保存任务级前后正文

Status: implemented

## Problem

审批意见队列只记录正文摘要和当前状态，无法在同一章节连续修订后还原某一批次实际提交的修改前后正文。根据当前正文或段落引用推算历史会把后续版本冒充为较早修订结果。

## Decision

每个成功提交的批量修订 task 在章节正文 publication 中写入一份 comparison artifact，路径为 `chapters/revisions/comparisons/<batch_id>/<task_id>.json`。artifact 保存 task 的 batch、section、issue 身份以及完整 before/after Markdown 和各自 SHA-256；同一 task 的多条 issue 共享该 artifact。

Host 通过 `issue_id → batch_id → task_id` 解析历史版本，并重新校验 task 身份、issue 顺序和正文摘要。旧的 completed 记录没有 comparison artifact 时返回明确的不可用结果，不读取当前正文补造历史。

浏览器把 Markdown 解析为保留原始 source slice 的顶层 GFM block，使用 LCS 找到相同块锚点，并把锚点间 gap 顺序配成修改、新增或删除。对比阅读区固定左侧为修改后、右侧为修改前；每个差异项是一个双列 CSS Grid 行，因此缺失侧的空单元格与有内容侧自然等高。两列位于同一个垂直滚动容器，不维护第二套 `scrollTop`。

## Alternatives considered

**在 queue 中保存每条 issue 的完整正文。** 同一 task 的多条 issue 会重复保存完全相同的章节，且队列 CRUD 会承担与状态无关的大文本；任务级独立 artifact 保持队列职责和版本单位一致。

**点击时读取当前章节并结合引用推算 before。** 后续修订会覆盖当前正文，段落引用也不包含完整章节，无法真实还原历史版本。

**并排渲染两篇全文并同步滚动比例。** 增删块使两边内容高度不同，比例同步不能保持后续相同内容对齐；共享 Diff Row 和单一滚动坐标直接表达对应关系。

## Consequences

comparison artifact 与最终正文共享 crash-recoverable publication，失败候选不会产生历史快照；恢复重试只接受身份及正文摘要完全相同的既有 artifact。历史流程图没有保存旧版 spec，对比视图只渲染 Markdown 中的占位文本，不使用当前流程图冒充旧版本。

块级 LCS 的时间和空间复杂度为顶层 block 数量的平方；章节顶层块规模使实现保持可预测，只有真实章节规模证明该成本不可接受时才需要替换算法。

# Agent Note: S5 常驻审核与按需 Word 导出

Status: implemented

## Problem

章节写作完成后，线性阶段自动进入 `docx_export`，客户端随即隐藏 S5 审核项。用户无法在完整章节和 Reviewer 状态旁复核内容，也不能从审核工作台重复生成 Word；导出行为错误地决定了写作审核页面是否存在。

## Decision

线性工作流在 `chapter_writing/completed` 结束，Host Projection 此时开放 `export_docx`。审核项从 S5 开始常驻，完成后保留逐章写作和 Reviewer 状态；工作台通过独立 `bid/exportDocx` Remote 按需导出，每次在输出目录生成带时间标识的 Markdown 和 DOCX 文件。导出持有项目锁并重新校验确认目录、章节集合和 DOCX 产物，不修改 S5 状态。已保存为 `docx_export/completed` 的项目投影同样开放审核和导出，以便现有项目继续使用。

## Alternatives considered

**导出后继续停留在 `docx_export`，仅让前端伪装成 S5。** 这会让 Host 状态仍把导出误作章节写作的后继阶段，新 Session、准入和其他客户端仍会看到错误的线性关系。

**在运行状态中增加第二套 S6 子状态。** 当前需求只需要可重复导出及结果路径；独立子状态会增加 Session Event、项目格式和 SDK 投影改动，却不改善导出准入或章节审查。

## Consequences

S5 完成状态和章节检查点保持稳定，导出失败不会遮蔽审核工作台，也不会要求重跑章节。每次导出使用独立文件名，已打开的旧 Word 文件不会阻止新导出；输出目录会保留用户主动生成的多个版本。`docx_export` 阶段类型暂时保留，用于读取既有项目状态和底层导出任务，但新流程不再自动进入该阶段。

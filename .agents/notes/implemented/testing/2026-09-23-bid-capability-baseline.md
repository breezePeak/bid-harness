# Agent Note: Bid 能力化回归项目基线

Status: implemented

## Problem

目录位置、章节文件和默认生成阶段目前相互关联。能力化开发会改变这些关系，单项执行器测试无法证明既有正文、资料来源、审核和导出视图仍指向同一章节。

## Decision

`packages/bid/bid/tests/capability-fixture.ts` 从真实入库的招标文件和参考资料建立两个旧格式项目：五个叶节全部完成，以及仅前两节完成。两者共用目录、评分响应点、资料缺口和 Writing Plan；完成章节包含正文、metadata、review、Manifest 与 Child 执行记录。目标章节包含流程段落、表格和流程图锚点，相邻章节引用目标章节。

`capability-baseline.spec.ts` 解析已保存产物，固定章节文件身份、正文 hash、资料映射、验收条件 ID、Child 记录及独立导出 Markdown 身份。快照只省略临时目录和运行时身份；业务字段保留。默认路线的阶段确认顺序另由 `orchestrator.spec.ts` 固定，目录确认校验的职责由 `outline-confirmation-architecture.spec.ts` 固定。

## Alternatives considered

**只复用单章测试夹具。** 它无法暴露章节移动、拆分或部分完成时的相邻文件错配。

**保存完整二进制项目副本。** 二进制副本较难审查、扩展和定位字段错误；测试内从真实入库文件组装项目，能继续经过当前解析器验证。

## Consequences

能力化修改可以对比真实旧项目的章节归属和用户可见导出。此夹具不替代真实模型对资料相关性、原文分配和写作质量的验收；这些验收需要固定招标项目的端到端运行。

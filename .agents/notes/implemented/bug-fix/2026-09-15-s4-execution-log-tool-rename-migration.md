# Agent Note: S4 执行日志工具统计迁移

Status: implemented

## Problem

S4 的 Child 工具从 `fetch_web_source` 改为 `web_fetch` 后，已有执行日志仍以 schema v3 保存旧字段名。严格 schema 会在恢复、进度投影和验收报告读取阶段拒绝日志，使已保存的 checkpoint 无法被执行器使用。

## Decision

S4 执行日志当前使用 schema v4，所有读取统一调用 `parseEvidenceMappingExecutionLog()`。该入口只复制并规范化执行日志中的工具统计：v3 日志升级为 v4，顶层 `statistics.tools` 及每个 `tasks[].research_stats.tools` 的 `fetch_web_source` 迁移到 `web_fetch`；两个字段同时存在时，对 calls、succeeded、failed、hits 求和，并按出现顺序去重合并 failure_reasons，随后删除旧字段。规范化结果最后交给当前严格 schema，未知字段仍然拒绝。

恢复只复用 checkpoint 已完成任务的正式结果；未完成任务沿用 S4 现有重建路径创建新的 Child，不对旧 Child 做 continuation，因此旧 descriptor 中的 `fetch_web_source` 不会进入当前工具注册。Research Pool、Web Snapshot、Evidence Map、Outline、Mapping Plan、Task 结果、Checkpoint 完成状态和 Section ID 不由该迁移修改。

## Alternatives considered

**继续让 resume 直接解析 v3。** 不采用。工具字段结构已经变化，重试只能重复同一确定性 schema 错误，无法触达已保存的任务进度。

**对执行日志使用 `.passthrough()` 或删除未知字段。** 不采用。前者放松了整个持久化边界，后者可能吞掉未识别的数据；迁移只处理已知的一个旧字段，并在最终严格校验中保留其他错误。

**清空 S4 并从头执行。** 不采用。已完成任务的 checkpoint 结果和共享 Research Pool 仍然有效，未完成任务只需按当前工具集合建立新的 Child。

## Consequences

旧 v3 日志可在当前版本直接读取并在恢复首次持久化时写成 v4；只读的进度投影和验收报告也通过同一入口获得规范化结果。当前写入只产生 `web_fetch` 统计。2026-09-15 的回归覆盖顶层统计、多个 Task 统计、新格式、双字段合并和 suspended S4 恢复；旧 Child 不被续接，已完成 Task 不重跑。

该记录补充[S4 Web Research Pool 与 Chunk 证据边界](../architecture/2026-09-14-s4-web-research-pool.md)的持久化兼容约束。

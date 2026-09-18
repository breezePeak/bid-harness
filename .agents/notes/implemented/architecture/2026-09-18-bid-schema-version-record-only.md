# Agent Note: Bid schema_version 只记录不阻断

Status: implemented

## Problem

Bid 产物跨阶段恢复时，结构字段仍然合法的文件会因为 schema_version 不是当前数字而被拒绝，导致项目恢复、Run resume、正文工作台和导出链路进入错误状态。

## Decision

`packages/bid/bid/src/schema-version.ts` 提供统一的 `recordOnlySchemaVersion`。Bid 的项目状态、发布清单、Work Descriptor、S1–S3 产物、S4 执行日志、S5 写作/审核/修订产物和工作台解析器只对 schema_version 做记录：正整数保留原值，缺失或非法值回退当前写出版本；其他业务字段继续使用严格 Schema。

S4 质量报告的模型 JSON Schema 不再用 `const` 限定版本，Host 在正式持久化前补写当前版本。流程图校验只检查类型和真实结构，不检查版本数字。

Host 在 S5 工作台读取边界可以追加 `bid.schema.warning`。该事件按 artifact、期望版本和观测值去重，属于诊断事件，不参与 stage、gate、run 状态、重试、暂停、用户询问或 allowedActions；持久化 catalog 同步登记该事件。

## Alternatives considered

**按版本号迁移全部产物：** 未采用。当前目标是避免版本字段阻断，真实业务结构不兼容仍应由严格字段校验报告，全面迁移会扩大格式和恢复风险。

**把整个对象改为 passthrough：** 未采用。`revision`、hash、引用关系、状态枚举和路径等业务不变量仍是流程准入条件，不能因版本兼容而失去校验。

**让每个底层 parser 持有 Session 并直接写 warning：** 未采用。parser 保持无 Session 的纯解析边界，warning 只在拥有 Session 的 Host 边界生成，避免改变底层接口和生命周期。

## Consequences

旧版、未来版、缺失或非法 schema_version 不再单独造成 reject；非法业务字段、hash/CAS 冲突、引用错误和真实阶段规则仍会失败。schema_version 异常在已接入的工作台读取路径可追踪，但没有 Session 的解析调用只执行回退，不产生持久化告警。

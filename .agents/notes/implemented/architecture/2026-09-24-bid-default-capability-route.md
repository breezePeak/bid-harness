# Agent Note: Bid 默认路线共用能力适配器

Status: implemented

## Problem

上传后的首次执行与项目恢复续行各自分发 S2–S5 执行器及 Validator，同一业务阶段存在两份调用配置。局部能力若再独立实现，会让并发、修复预算与完成门禁产生差异。

## Decision

`bid-capability-registry.ts` 为默认 S2–S5 提供固定能力映射和薄适配器，直接调用现有执行器及整阶段 Validator。S5 的 Writer、Reviewer 与整书审核仍由原章节执行器调度。上传与恢复都使用 Host 的 `automaticOrchestrator()`，S1 文件入库在同一个编排器内使用原 Work 和校验；其后的模型工作使用 Execution Agent。`BidOrchestrator` 独占 Run 结算、阶段确认、后继阶段和 S5 等待用户边界。

默认路线的 `BidStageTask` 只为现有执行器提供内部参数。公共能力是否可调用由能力 ID、任务授权和真实输入决定，不能据此内部阶段标签放权。独立 DOCX 导出继续使用既有入口。

## Alternatives considered

**保留上传专用的 S2–S5 分发。** 两条路径的恢复指引、并发和修复参数会继续漂移，也无法证明默认流程复用了公共能力。

**让能力适配器直接完成阶段转换。** 用户确认和失败恢复会拥有第二个状态驱动者，与现有 Run 和 Goal 结算竞争。

## Consequences

默认执行的执行器、Validator、修复预算和并发参数只有一处映射，上传与续行共享同一阶段边界。适配器仍调用完整阶段执行器；局部修改必须在后续能力实现中提供精确范围与写入校验，不能把整阶段包装直接当作局部权限。

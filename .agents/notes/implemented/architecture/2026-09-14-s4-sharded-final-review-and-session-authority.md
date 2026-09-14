# Agent Note: S4 分片终审与 Bid Main Session 权限

Status: implemented

## Problem

S4 的单个 Final Check Child 同时接收全书章节、材料、复核对象和父节点总述，目录较大时会在启动前或运行中超过模型上下文，失败重试仍使用同一输入。Bid 前端又只凭继承的 `agentPreset=bid` 判断项目能力，Subagent Session 因而能够显示并调用只属于 Main Session 的项目控制；二进制上传入口也缺少同一所有权校验。

## Decision

Bid 项目能力以 `agentPreset === 'bid' && origin !== 'subagent'` 作为 Main Session authority。前端阶段面板、详情、审阅、导出和 Composer 上下文共用该判断；Host 的阶段重置与三个上传入口同时校验 Bid preset、非 Subagent origin 和项目 cwd。通用 remote fence 保持不变，项目边界在能力入口重复校验。

Final Check 的叶节复核按目录一级或二级业务分支构造稳定任务，根级可写叶归入单独文档根分片。Prompt 按实际字符数接受 48,000 字符预算；超限任务在启动 Child 前按估算 payload 权重二分，运行中只把带稳定上下文溢出错误码的当前分片替换为更小任务。兄弟任务使用独立 checkpoint，任一失败不取消已经完成的兄弟结果。

父节点总述改为独立 `branch_summary` 任务，每个任务只获得父节点自身职责、直接子 Section 的最终 Blueprint 与直接子节点已通过的 summary，并按目录深度自底向上分波执行。该任务只注册总述提交、复核和完成工具，不提供来源读取、研究、映射或任务编辑能力。全部叶节复核与父节点总述完成后，Host 确认任务所有权、稳定复核 fingerprint、无待审或阻断记录、完整章节覆盖和目录一致性，再发布正式产物；不再增加单个全书模型终审。

私有 plan schema 提升为 v7，checkpoint schema 提升为 v12。任务 ID 由精确 Section ID 集合派生；完成 checkpoint 只有在作用域输入 fingerprint 一致时复用。未完成分片保留已审且 fingerprint 未变的记录，相关章节、材料或直接子节点变化只使对应叶节与祖先总述重新执行；无关分支不重跑。

本记录部分替代[逐叶研究任务](2026-09-11-s4-leaf-mapping-task-scope.md)中的 Final Check 任务范围与 checkpoint v11、[材料用途与父节点总述](../feature/2026-09-08-s4-material-purpose-review.md)中的单个 Final Check、整棵后代总述输入和恢复失效范围，以及[章节研究与 Blueprint](../feature/2026-09-03-bid-section-research-blueprint.md)中的单个轻量 Final Check。旧记录继续约束初始逐叶研究、材料用途语义、复核协议和 S5 输入，不归档。

## Alternatives considered

**提高单个 Final Check 的上下文上限。** 目录与材料仍会线性累积，无关分支继续互相污染，运行中溢出也无法缩小失败输入。

**按固定章节数量切片。** Section 的材料、Requirements、Scoring 和复核记录大小差异显著；按实际 prompt 预算和估算 payload 权重拆分能在稳定边界内减少不必要任务。

**保留一次全书模型终审。** 它会恢复同一个上下文瓶颈。跨分片闭环改由 Host 的确定性所有权、fingerprint、完整覆盖和无阻断校验承担。

**只在通用 remote fence 阻止 Subagent。** UI 仍会暴露不可用控制，上传等项目专用入口也可能在 fence 外获得状态；Main Session authority 必须在前端与 Host 能力入口一致表达。

## Consequences

大型目录的 Final Check 调用数量增加，但每个叶节分片只携带相关业务上下文，父节点总述只携带直接子节点，失败和恢复的重跑范围局部化。结构变化、旧 plan 或旧 checkpoint 会触发 S4 重建；正式 Evidence Map 与 S5 schema 保持不变。Main Session UI 与 Host 都拒绝继承 Bid preset 的 Subagent，普通 Bid 主会话行为不变。

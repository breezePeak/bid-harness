# Agent Note: S4 逐叶研究任务与动态 Section 队列

Status: implemented

## Problem

S3 已经把技术标目录细化为可写叶子，S4 却再次按顶层业务分支聚合这些叶子。一个 Mapping Child 因而同时承担多个章节的资料读取、Web 研究、Writing Brief 和目录判断，任务数量受顶层结构限制，长会话会累积无关上下文并混用兄弟章节资料。原来的目录工具同时把业务分支当成任务范围、编辑范围和映射范围；直接取消聚合会继续允许单章 Child 修改或映射兄弟节点。

## Decision

`buildEvidenceMappingPlan()` 按 `buildWritableSectionWorklist()` 的稳定顺序为每个可写叶子创建一个 `section_mapping` 任务。任务以单个 `section_ids` 表示正式映射范围，以 `outline_edit_scope_id` 单独表示可编辑子树根，并用 `generation` 表示动态队列代次；Remap 和 Final Check 继续使用自己的任务种类且不获得目录编辑范围。

Initial 与 Repair Child 完成[研究充分性判断](../bug-fix/2026-09-11-s4-research-before-outline-refinement.md)后，只能通过 `apply_section_outline_edit` 修改当前 Section 自身及其后代。Host 在每次操作和并发合并时按根 ID 校验子树快照，使用任务 ID 派生的命名空间分配新 Section ID；父节点、兄弟节点和子树外的新父节点均不属于该任务权限。

可写叶子被拆分后，原任务的正式 Mapping 范围变为空，`lock_section_outline` 只把最终新叶作为 `queued_leaf_sections` 返回；父 Child 可以明确新叶职责，但不能提交它们的 Evidence。Host 合并这一代目录后，只为从非可写状态新变成的可写叶创建下一代独立任务，其他已完成任务不重跑。Repair 也走同一队列；目录复核同时指向祖先和后代时，Host 把问题归并到同一个最上层受影响子树，只并发互不相交的修复范围。

每个完成任务把成功 `read_source` 返回的材料引用和成功 Web Snapshot 身份保存为 `research_candidates`。动态子任务只把这些记录作为检索入口；Host 不据标题、关键词或父任务判断生成 `local_materials` 或 `web_materials`，子任务仍须按自身 Requirement、Scoring、Response Point 和职责读取、判断并显式提交。私有 plan schema 为 v6，checkpoint schema 为 v9；正式 Evidence Map 维持 v10，S5 不读取 Mapping Task、代次或研究候选。

本记录替代[增量映射工具](../simplification/2026-09-07-s4-incremental-mapping-tools.md)、[章节研究任务](../feature/2026-09-03-bid-section-research-blueprint.md)和[目录结构与叶节写作](../bug-fix/2026-09-08-bid-outline-structure-before-writing.md)中的业务分支任务范围；这些记录继续分别约束小工具提交、S5 补搜与叶节正文结构。

## Alternatives considered

**保留业务分支聚合，只提高并发或上下文上限。** 分支数量仍由目录上层结构决定，同一 Child 仍会读取多个兄弟章节；扩大资源上限不能消除资料污染和长会话。

**拆分后由原 Child 顺便完成全部子叶 Evidence。** 这会在目录变细时重新形成多章节长任务，也无法证明父任务资料适用于每个新职责；原任务只产出结构与候选，新叶分别研究。

**任一目录变化后重建并重跑全部 S4。** 全量重跑能规避增量合并，但会丢弃无关章节已完成的研究并降低并发收益；代次队列只调度新变成可写叶的 Section。

**按固定目录层级或标题规则划分任务。** 不同招标书的层级和语义不稳定；可写叶子和 Section ID 是现有目录契约中足够的确定性边界。

## Consequences

初始 Mapping Child 数量等于 S3 可写叶子数，受现有并发上限调度；单个 Child 的详细上下文限于一个 Section 子树，全书只提供轻量职责索引。目录拆分增加后续代次和独立模型调用，但父任务不会替子任务确认 Evidence，其他 Section 也不会因局部深化重跑。恢复必须拒绝旧 plan 或 checkpoint，正式目录、Evidence Map 与 S5 schema 不变。

定向测试固定五叶五任务、非可写父节点无任务、独立叶并发、兄弟编辑拒绝、三子叶动态入队、拆分父任务无 Mapping、候选传递但不占用 Evidence、局部 Repair 不重跑兄弟、Final Check 以及二十七叶验收目录的逐叶执行。

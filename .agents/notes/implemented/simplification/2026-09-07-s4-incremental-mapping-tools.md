# Agent Note: S4 增量映射工具

Status: implemented

## Problem

S4 Mapping Child 通过一个工具同时提交 Task 身份、全量章节数组、目录操作、资料引用、覆盖关系、未变更章节和分支摘要。模型需要手工维持 Section 精确覆盖、预测新章 ID 并复制 Host 已知字段，导致遗漏、重复和引用错误与真正的资料判断共用修复轮次。[旧结构化提交](../bug-fix/2026-09-04-s4-structured-mapping-submission.md)把参数错误移入工具回合，但单次参数仍包含整项任务的确定性集合。

## Decision

材料字段、独立任务操作及 Final Check 完成机制遵循[材料用途与职责复核](../feature/2026-09-08-s4-material-purpose-review.md)；本记录保留逐次工具提交、分支范围和同回合参数修复的取舍。

Initial Mapping Child 在自己的业务分支内逐次调用 `update_section_task` 保存研究草稿，并可与 `apply_branch_outline_edit` 交替；Host 对现有 `OutlineEditOperation` 形成的候选执行共享结构校验，成功后才发布分支状态、返回实际生成的临时 Section ID 并失效结构或职责受影响的草稿，失败操作不污染后续目录。`lock_branch_outline` 再次检查共享结构，保存[目录粒度结论](../bug-fix/2026-09-08-bid-outline-structure-before-writing.md)，只在目录有效时固定分支并返回权威可写章节。Child 随后通过 `submit_section_mapping` 逐章 upsert 正式材料，通过 `add_mapping_suggestion` 去重保存全局建议，并用 `finish_mapping_task` 请求 Host 按真实提交状态检查缺失章节和可修正问题。Remap 使用已锁定范围内的 `submit_section_mapping` 与 `finish_mapping_task`，不获得目录工具。

Section 工具只要求模型提供章节 ID、Writing Brief 和资料语义。省略的材料、缺口、展开维度和写作数组由 Host 补为空数组；既有 Section 省略 coverage 时继承锁定目录，S4 新建 Section 必须一次提交当前 Task 范围内的 Requirement、Scoring 和 Response Point override。Host 在单次调用内解析短文件引用、绑定真实文件身份、校验分块存在及 usage，并只接受当前 Child 已成功抓取或 Host 已登记正文的 Web URL。每个 Section 使用 Map 保存当前内容，另由 Host Set 记录成功的材料工具结果；再次提交覆盖材料且不能形成重复项，只更新任务不会冒充材料已提交。显式空材料提交仍会记录成功，已有有效 baseline 在局部重映射和 Final Check 中继续复用。

Final Check 只注册 `replace_section_mapping`、`submit_branch_summary` 和 `finish_final_check`。未替换章节自动保留 Host baseline；缺少 baseline 的最终章节和缺少摘要的结构节点由 finish 返回明确列表。Final Child 没有目录编辑或建议工具，也不提交未变更 ID、全量 Mapping 数组或空建议数组。

finish 成功后，Host 从锁定目录、章节 Map、建议 Set、baseline 和摘要 Map 组装内部 `EvidenceMappingPartialResult`。只有成功的权威 `tools/result` 使该结果生效并结束 Child 回合；真正的语义失败和 Child 异常仍可使用一次同会话修复。最终 Evidence Map schema、Web ledger、目录质量复核、Validator、用户确认局部复核和 S5 输入保持不变。检查点版本及结构对照要求遵循[目录结构与叶节写作](../bug-fix/2026-09-08-bid-outline-structure-before-writing.md)。

## Alternatives considered

**继续强化单个大工具的 Prompt 和动态 Schema。** 不采用，因为 Schema 可以拒绝错误，却不能替模型维护经过目录编辑后的精确集合；少章、重复章和未变更列表仍会消耗完整提交。

**把每个 Section 改成一个 Mapping Task 或 Child。** 不采用，因为业务分支是目录深化与资料研究的语义范围；拆成逐章 Child 会改变计划、并发和分支内合并判断。

**由 Host 自动推断新章 coverage。** 不采用，因为拆分后 Requirement、Scoring 和 Response Point 如何分配是语义判断；Host 只限制候选范围，不能凭结构猜测。

## Consequences

模型不再填写 task_id、真实 file_id、source_kind、Web 快照字段、全量章节数组、精确覆盖列表或临时新章 ID。未知章节、错误文件或分块、非法 usage、未抓取 URL、缺失章节和重复提交在工具状态内即时处理，不再成为最终数组校验失败。代价是 S4 Child 作用域维护一份目录和多张小型 Map，并增加多次低负载工具调用；最终 Validator 仍独立验证完整 Artifact，严格程度不降低。

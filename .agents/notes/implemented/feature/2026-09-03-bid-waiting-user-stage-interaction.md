# Agent Note: Bid 等待确认期间由 Host 执行受控阶段修改

Status: implemented

## Problem

用户在目录和资料映射完成后仍需咨询、调整局部结构及重新研究指定章节。仅开放聊天不能完成修改，而开放文件写工具会绕过 Draft CAS、目录覆盖校验和正式确认。调用中的 Main Agent 也不能再次等待自己空闲后执行模型阶段。

## Decision

目录编辑的发布时机与最终确认复核由[章节研究与 Blueprint](2026-09-03-bid-section-research-blueprint.md)规定：连续修改只保存 Draft，确认前完成受影响章节复核。本记录保留受控工具、CAS 和生命周期的设计依据。

S2/S3/S4 的等待态开放 Composer，运行态拒绝普通消息。工具按实时阶段仅注册给 Bid Main Agent；执行入口重新检查身份、阶段、CAS 和项目锁。`bid_stage_inspect` 返回当前编号树、实际 ID、业务引用、材料缺口和映射任务；模型负责自然语言定位，Host 不把展示编号当内部 ID。

目录编辑复用 `mutateOutlineDraft`；局部重生成与整本重生成共用反馈要求，独立无工具 Child 只返回编辑操作，Host 验证范围后走同一 Draft mutation。初始 S4 与 targeted remap 共用映射执行器，仅任务范围、Evidence 合并方式和是否深化目录不同。`replace` 不保留目标旧证据，`supplement` 按本地文件/分块或 Web source ID 去重；无关章节不重新运行。

修改期间复用 Host `inFlight` 与取消信号，保存前状态用于失败恢复。成功后运行当前阶段基础 Validator、更新 Draft revision 并重新要求用户确认。阶段交互提示以普通插件消息入日志，工具结果记录实际修改；交互代码不调用确认动作、不产生确认收到或阶段完成事件。

## Alternatives considered

**等待态只开放 read。** 无法处理用户明确提出的目录修改和局部资料替换。

**让 Main Agent 直接写 JSON。** 无法保持 Draft CAS、范围校验和正式确认的统一入口，也会暴露 shell 等间接写入路径。

**每次目录修改全量重新映射。** 无关章节会重复研究；仅标题微调不必重映射，新增和拆分章节可以先保留明确缺口或候选资料。

**在阶段工具内运行等待 Main Agent 空闲的生成流程。** 工具本身占用该 Agent，形成自等待。局部目录规划由独立 Child 返回操作，资料 remap 只等待 Mapping Child。

项目文件、跨 Session 进度同步及共享锁由[Workspace 项目记录](../architecture/2026-09-03-bid-workspace-project.md)约束。

## Consequences

修改可连续执行，但每次均须基于最新 CAS；Evidence-only 修改也提升 revision，旧确认请求不能接受新资料。回滚覆盖目录、Draft、质量报告、Evidence、Web ledger、映射计划和日志；新建但尚未采用的 Web 快照不作为正式证据。快照内容按 URL 与正文哈希命名，保留其他章节引用的正文。

本记录部分扩展[资料映射减法](../simplification/2026-09-03-bid-evidence-mapping-reduction.md)：保留自动 reconcile 不强制补映射的决定，同时提供用户主动要求的局部研究。它也部分替代[Host 准入](../bug-fix/2026-08-29-bid-host-runtime-admission.md)中禁用全部普通消息的规则，保留 Host 决策和单一投影的依据；这两份记录仍有独立决策价值。

真实 Main Agent 与源码 Loader 回放覆盖普通咨询、否认隐式确认、裸写拒绝、拆分、局部重生成、单节 remap、并发拒绝、失败恢复和工具释放；Host 测试覆盖 replace/supplement 与未选中证据保留，UI 测试覆盖自动刷新和最新 revision 确认。自然语言理解的质量仍取决于模型，脚本模型测试证明控制链路而不证明真实模型的目标理解准确率。

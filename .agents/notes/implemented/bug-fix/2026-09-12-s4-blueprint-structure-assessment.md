# Agent Note: S4 Blueprint 后结构判断

Status: implemented

## Problem

研究充分性和目录承载能力需要不同输入。研究阶段提前逐主题归位，会让完整写作任务形成后的结构判断沿用旧结论；后续任务变化没有版本约束，拆分却需要重新填入 Host 已知引用。全书复核若主要接收这些归位结论与材料用途，容易继续接受粗粒度叶子。Web 搜索失败也不能证明模型已经完成自己选择的研究。

## Decision

保留[研究先行](2026-09-11-s4-research-before-outline-refinement.md)、[主题归位与局部修复](2026-09-11-s4-topic-disposition-outline-lock.md)及[逐叶调度](../architecture/2026-09-11-s4-leaf-mapping-task-scope.md)；本记录部分替代前两项中的研究字段、锁定协议和 checkpoint。S4 内部顺序为研究、完整 Blueprint、Structure Assessment、必要结构操作、当前版本重判与锁定、全书复核及局部 Repair、Final Check。S3、用户确认和 S5 的职责不变。

Research Assessment 只保存是否足以设计 Blueprint、中性 findings、已核实依据、专业推演边界和缺口。项目事实须有来源；方案设计可以基于任务提出方法，不能冒充采购人已指定的条件。模型先通过 `update_section_task` 明确完整写作任务，再判断当前目录在禁止 S5 自建正式标题时能否清晰承载。连续流程和评分点只提供参考；方法、场景、成果责任与评审导航决定结构价值，普通步骤、参数和表格不自动成节。

Host 用当前子树、Blueprint 和 Research Assessment 计算 fingerprint。参与判断的语义字段变化使结论 stale 并解除锁定；相同内容重交不失效。每次结构编辑和最终锁定都调用同一个当前指纹校验，旧判断不能再执行下一项编辑。结构操作只接受 finding 序号与理由，真实 ID 和 finding→节点绑定由 Host 保存，已有绑定跟随后续拆分后的可写后代。模型不因新 ID 重交研究报告；每项编辑后重新提交受影响的 Blueprint 与结构判断，全部编辑结束后的当前判断才允许锁定。Host 校验真实依据、ID、版本和树结构，不根据行业词、维度数量或节点配额决定 KEEP/REFINE。

`reviewRefinedOutline()` 根据最终 Blueprint、中性 findings、S3 职责、父子同级责任和覆盖摘要给出独立第二意见，优先检查过粗、过拆和隐藏标题压力。同一方法的步骤不能仅因各自具有输入输出就独立成节；复核须说明段落、列表和表格不能承载的实际技术差异。Repair 读取研究内容和具体阻断问题，不注入旧归位理由，也不把 Reviewer 的拆分建议视为业务事实。非阻断建议的工具字段与正式质量报告保持相同的 advisory 对象结构。Final Check 保留任务、Evidence、材料用途、缺口、父总述与完整性复核，结构问题必须由具有目录编辑权限的前序任务解决。

是否联网仍由模型选择，执行沿用已有 Web 服务配置。已调用的 search 或 fetch 若全部失败，Host 拒绝研究充分、结构判断、编辑和锁定；失败后先修复 Provider 或重试，再重新提交研究判断。只有成功 fetch 的正文可绑定 Web Evidence。独立搜索服务的配置不依赖聊天 Provider 是否支持 hosted search；未配置时不假定存在 Tavily 等服务。

私有 checkpoint 升为 v10；旧格式明确要求重置 S4，不补造判断或双轨解释。恢复已完成拆分时复用计划中的初始叶任务，只有结构 Repair 可以为既有叶子安排重新研究，避免重复任务合并同一子树。正式 Evidence Map v10、Outline v3、稳定 Section ID 和用户手工修改后的局部确认保持现有格式。执行日志继续 v3，以可选统计记录研究工具成败与原因、findings、KEEP/REFINE、结构失效、实际操作、全书阻断和 Repair 是否改变结构。

`bid:s4-replay` 将指定 S1–S3 Workspace 的 `.bid-harness` 复制到全新输出目录，在隔离副本中调用同一 S4 执行器。验收报告不另建运行日志，而是从 v3 执行日志、v10 检查点、任务计划及 S3/S4 目录投影全书统计和可选原始 Section 记录；Section 筛选不影响执行范围，也不内置具体项目 ID。该报告只提供实际研究、结构操作和复核事实，目录过粗、过拆与隐藏标题压力仍需结合真实内容验收。

## Alternatives considered

**先找独立写作单元再拆目录再研究。** 缺少研究和完整 Blueprint 时无法知道真正的方法差异与表达压力，保留研究先行可避免结构判断替研究预设结论。

**调高拆分比例或按行业模板拆分。** 节点数量不能衡量目录质量，会将同一方法普通步骤切碎；语义回归同时要求过粗案例深化和聚焦案例允许 KEEP。

**继续在 Research Assessment 中保存归位并让模型自行更新。** Host 无法确认模型何时重判，且 Repair 继承旧归位会放大锚定；中性研究与版本化结构判断分别承担这两项职责。

**新增全书模型阶段或在 Final Check 修目录。** 现有 Reviewer 和子树 Repair 已有结构复核职责；重复阶段增加上下文并破坏 Final Check 的权限范围。

## Consequences

KEEP 与 REFINE 都要求完整 Blueprint 和当前版本判断；REFINE 额外执行实际结构操作，确定性引用维护由 Host 完成。结构语义仍可能误判，必须通过全书第二意见和真实模型验收观察，不能只依赖 schema 校验。

协议测试覆盖完整任务时序、语义变化失效、相同更新复用、stale 编辑与锁定拒绝、连续目录操作和自动绑定、失败联网阻断及成功重试、局部 Repair、恢复和用户手改确认。回放入口测试覆盖参数、Section 筛选和隔离复制，报告测试核对现有日志到逐节记录的投影。真实 Loader 无密钥回放覆盖研究、Blueprint、结构判断及 stale 锁定拒绝。真实模型案例包括不同技术责任的粗叶、同一方法普通步骤的聚焦叶和煤矿实测及历史地上地下核查边界；独立 Reviewer 测试植入仅凭连续流程得到的 KEEP，要求发现目录承载问题。语义评估检查隐藏标题压力和过度拆分，不规定新增数量或层级。

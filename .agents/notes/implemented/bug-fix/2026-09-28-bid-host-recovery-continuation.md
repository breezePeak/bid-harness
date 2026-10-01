# Agent Note: Bid Host 持续恢复内部失败

Status: implemented

## Problem

S2～S5 的内部错误可能没有恢复元数据，或在 Run 收尾时直接变成 `failed`；未知校验码又默认阻断主 Agent。Goal 在 Session 重启时失去进程内授权，Host 重启的 Run 等待用户继续。目录修复回执会阻断新 Run，S4 锁定后也缺少客户可见总述的合法修正路径。

## Decision

Host 在 Run 收尾时用完整错误码集合识别确定的输入、权限、模型服务和数据安全阻断；其他 S2～S5 内部失败保留 `suspended` Run 与恢复诊断。短暂连接错误可以重试。资料映射优先保留结构化 `QUOTA`、`AUTH` 与 `NO_ADAPTER`，不因错误文本含 429 而降为可重试限流；限流任务共用 Provider 冷却截止时间，仍分别计算重试预算，持久化失败记录后只等待该截止时间。失败由[主 Agent 恢复工具](../architecture/2026-09-29-bid-goal-decoupling.md)分析和处理；Host 不代替主 Agent 决定修复方案。

Host 把遗留 running Run 持久化为 `suspended(host_restart)`，释放启动操作后按精确 Run ID 与项目 revision 调用原恢复入口，不依赖 Goal。能力 Work 在恢复准入前核对不可变请求的授权会话；其他会话的恢复被拒绝，不创建新 Run，也不改变原 Work。原 Executor 的检查点、输入指纹与提交栅栏决定能否续行；用户停止、等待输入和 S5 明确停止的写作入口不自动恢复。Goal 重激活由上述解耦决策替代；重复指令检查使用独立的 bid.recovery.requested 事件。

S2～S5 的 Host-owned Run 在兜底结算、后台目录交互、目录重生成、目录确认、章节修订和批量修订发生内部错误时保存结构化 recovery metadata。目录重生成候选返回失败也作为失败 Run 结算；错误码和结构化 issues 保留输入、权限及 Provider 的阻断分类。目录确认仍要求用户确认，主 Agent 只恢复已经授权的候选执行。

S3 的局部确定性修复每个 Run 至多一次，正式回执记录最近一次操作，不消耗后续 Run 的修复资格。S4 锁定子树仍拒绝结构和职责编辑，只允许当前任务范围内的 summary-only `update_section`；写入前检查客户可见内部编号，摘要变化不使 Structure Assessment 失效。

S4 Initial Mapping 只检查本任务可编辑子树的客户可见编号，避免其他任务范围内的总述问题阻断已完成章节；Final Check 仍检查完整目录。客户可见总述中的内部评分 ID 必须移除，正式 `scoring_ids` 和响应点绑定仍保留。

## Alternatives considered

**只为已知校验码添加白名单。** 新 Validator 和子代理协议问题仍会被默认阻断，无法解决相同类别的后续故障。

**非模型执行器错误全部结算为 failed。** 缺失恢复元数据和模型协议错误会进入同一终态，主 Agent 无法分析真实诊断并改变处理办法；确定的外部与安全问题仍明确阻断。

**重复指纹或固定次数后停止。** 相同检查点不能证明新策略无效；原设计要求改变策略并沿用原生 Goal 总轮数，未新增 Bid 预算；当前由主 Agent 根据诊断决定下一步。

**让主 Agent 直接修改正式文件或重置阶段。** 这会绕过原 Executor 的局部范围、用户确认及 Run 提交栅栏。

## Consequences

主 Agent 的错误分析仍可能需要外部修复代码；诊断和恢复指令留在 Session 中以供定位。Host 重启续行与主 Agent 修复复用同一项目锁和原 Work 检查点。测试覆盖混合错误分类、Host-owned Run 错误结算、精确 Run 续行、S3 新 Run 局部修复、S4 锁定摘要编辑，以及无 Goal 时主 Agent 接管并保留七个已完成任务。

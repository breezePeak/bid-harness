# Agent Note: Bid Host 持续恢复内部失败

Status: implemented

## Problem

S2～S5 的内部错误可能没有恢复元数据，或在 Run 收尾时直接变成 `failed`；未知校验码又默认阻断主 Agent。Goal 在 Session 重启时失去进程内授权，Host 重启的 Run 等待用户继续。目录修复回执会阻断新 Run，S4 锁定后也缺少客户可见总述的合法修正路径。

## Decision

Host 在 Run 收尾时用完整错误码集合识别确定的输入、权限、模型服务和数据安全阻断；其他 S2～S5 内部失败保留 `suspended` Run 与恢复诊断。短暂连接错误可以重试。主 Agent 的接管次数和连续相同指纹来自 `bid.goal.recovery.requested`，仅用于提示改变策略；相同指纹下完全重复的指令被 Host 拒绝。原生 Goal 的总轮数仍限制自动对话。

Session 启动后，Bid 只对自己绑定、仍处于 active 且未耗尽轮数的 Goal 恢复进程内授权；用户暂停、停止及等待输入不自动恢复。Host 把遗留 running Run 持久化为 `suspended(host_restart)`，释放启动操作后按精确 Run ID 与项目 revision 调用原恢复入口。原 Executor 的检查点、输入指纹与提交栅栏决定能否续行；恢复失败保留诊断并交给用户处理。

S3 的局部确定性修复每个 Run 至多一次，正式回执记录最近一次操作，不消耗后续 Run 的修复资格。S4 锁定子树仍拒绝结构和职责编辑，只允许当前任务范围内的 summary-only `update_section`；写入前检查客户可见内部编号，摘要变化不使 Structure Assessment 失效。

## Alternatives considered

**只为已知校验码添加白名单。** 新 Validator 和子代理协议问题仍会被默认阻断，无法解决相同类别的后续故障。

**非模型执行器错误全部结算为 failed。** 缺失恢复元数据和模型协议错误会进入同一终态，主 Agent 无法分析真实诊断并改变处理办法；确定的外部与安全问题仍明确阻断。

**重复指纹或固定次数后停止。** 相同检查点不能证明新策略无效；拒绝完全相同的指令并沿用原生 Goal 总轮数，避免机械重试而不新增 Bid 预算。

**让主 Agent 直接修改正式文件或重置阶段。** 这会绕过原 Executor 的局部范围、用户确认及 Run 提交栅栏。

## Consequences

内部程序错误也可能消耗原生 Goal 轮数，直到外部修复代码；诊断和恢复指令留在 Session 中以供定位。Host 重启续行与主 Agent 修复复用同一项目锁和原 Work 检查点。定向测试覆盖混合错误分类、重复指令、Goal 重启授权、精确 Run 续行、S3 新 Run 局部修复、S4 锁定摘要编辑，以及八个初始任务中保留七个完成检查点并修正剩余任务的内部编号总述。

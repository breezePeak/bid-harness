# Agent Note: S4 状态写入复用文件系统服务

Status: implemented

## Problem

资料映射计划和检查点使用独立的临时文件加 rename 保存，绕过了 Agent 文件系统服务。执行日志、恢复检查点和 Web Evidence 又共用一个 Promise 队列；一次非关键日志写入失败会拒绝整条队列，阻止后续关键状态提交。Windows 短暂占用目标文件时，原子替换还会立即因 `EPERM`、`EACCES` 或 `EBUSY` 失败。

## Decision

映射计划和检查点通过当前 Agent 的 fs 服务提交，并传递当前 Session 的 sandbox policy。检查点与 Web Evidence 使用 `criticalStateWrites` 串行提交，任何失败都会终止当前批次；任务首次状态提交纳入 finally 清理范围。没有已完成任务时，失败重跑允许检查点文件尚未创建；日志已标记完成但检查点缺失时仍拒绝恢复。

执行日志使用独立的 `progressLogWrites` 队列和 `writeFileAtomic`。单次日志写入重试耗尽后记录 Host warning，队列恢复为可继续状态，不改变关键写入的成功或失败。`writeFileAtomic` 对瞬时 rename 错误按 20、50、100、200、400、800 毫秒有限退避；不删除正式目标，最终失败时清理临时文件并抛出首次瞬时错误。文件格式、并发数与映射规则保持不变。

## Alternatives considered

不新增锁组件或存储模型；withFileLock 只协调参与相同协议的写入者，不能解决任意外部占用。失败的检查点队列不能吞错继续提交，否则可能发布不完整任务。

## Consequences

计划和检查点获得框架的路径策略与目标级串行化；日志短暂失败不再污染恢复状态。有限重试最多增加约 1.57 秒 rename 等待，持续外部占用或权限不足仍明确报错。定向回归覆盖关键 checkpoint 失败、单次日志失败后的 checkpoint 成功、三类瞬时错误重试、耗尽后首次错误和临时文件清理。

Host 状态提交通过 sandboxPolicy.resolve({ session }) 传递既有会话策略，避免落入后端启动目录的默认边界；不覆盖会话权限模式。回归装配使用 SandboxedFileSystem（继承 LocalFileSystem），同时验证失败收尾传递项目边界。

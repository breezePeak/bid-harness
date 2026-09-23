# Agent Note: Bid 主会话对 S2～S5 失败的有界接管

Status: implemented

## Problem

Bid 的阶段执行由 Host 和执行子代理持有，主交互 Agent 保持可聊天。阶段挂起时，原生 Goal 驱动器只知道主 Agent 空闲；若直接启动 Goal Round，会在后台正常运行期间空转或重复发起阶段。失败任务的候选、检查点和校验问题又只保存在 Host 所有的工作区和会话事件中，主 Agent 不能凭聊天摘要安全地重试。

## Decision

Bid Host 在 S2 Run 的 running 检查点成功后，将一个原生 Goal 绑定到同一主 Session。驱动器的同步等待门只在该 Session 存在当前可自动修复的挂起工作时放行 Round；等待不改变 Goal 生命周期，也不消耗 Round。Host 继续负责 S2～S5 的正常调度、用户确认和写作提问。

Host 将执行器和最终校验的实际问题分类并保存在 Run failure 中。主 Agent 通过 `bid_stage_inspect(view="recovery")` 读取有界诊断，再用 `bid_recover_task` 提交当前目标的改进指令。Host 在原项目锁内复核 Goal、Run 或写作请求身份、输入指纹、停止状态和预算，持久化一次恢复事件，然后复用原 Run 恢复或已回答写作计划的派发入口。工具在新 Run 的 running 检查点持久化后返回；S2～S5 的真实执行模型只接收与失败单元匹配的指令，正式产物仍经原提交和校验流程。

同一 work 或写作 requestId 至多接受两次自动接管；相同问题与检查点无进展时立即停止。用户停止、Host 重启、输入身份冲突、提供方与权限故障不取得自动接管权。Goal 的暂停、清除和完成约束主会话的自动续行；S1 文件处理和 S6 独立导出不由这个目标恢复。

## Alternatives considered

**在主 Agent 内重做阶段执行。** 主 Agent 缺少执行子代理的原始工作身份和私有候选，重做会绕过既有检查点、确认与提交权限。

**每次 Host 状态变化都请求 Goal Round。** 正常后台执行期间会产生空轮次，并与 Host 的单一项目写入者竞争；只读等待门把 Round 准入限制在可处理的故障边界。

**把恢复预算留在内存或按新 Run 计数。** 刷新、重启和每次新 Run 都会刷新额度；恢复事件保存在主 Session 中，以 work/request 身份和进展指纹计数。

## Consequences

自动修复仍受原生 Goal 总轮数及原执行器局部修复预算限制。主 Agent 可以给出处理办法，但不能修改正式 Artifact、伪造用户确认或替代 Host 校验；无法定位或安全处理的故障回到原人工决策。绑定和恢复记录成为会话回放中可重建的授权与预算依据。

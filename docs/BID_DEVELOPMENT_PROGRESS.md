# Bid Harness 总体开发进度与并行开发计划

> **唯一架构基准：** `docs/bid-harness-architecture/bid-overall-architecture.zh.md`
>
> 本文只回答三个问题：
>
> 1. 总体架构中的每个模块现在开发到哪里；
> 2. 下一步应该开发什么；
> 3. 哪些模块可以并行开发。
>
> 本文不得引入总体架构之外的第二套 Orchestrator、状态机、任务系统、搜索系统或 Agent 框架。

---

# 1. 总体架构固定不变

Bid Harness 的总体架构固定为：

```text
用户
 ↓
Web Client
 ↓
────────────────────────────────
控制面
  Bid Orchestrator
  Stage Policy
  Stage Validator
────────────────────────────────
 ↓
────────────────────────────────
执行面
  Bid Agent Preset
  当前阶段任务单
  阶段工具与 Guard
  Harness Agent Loop（DSH 已有）
  Model（DSH 已有）
────────────────────────────────
 ↓
────────────────────────────────
数据面
  Document Pipeline
  Workspace Knowledge
  DSH 原生 grep / read
────────────────────────────────
 ↓
────────────────────────────────
产物与持久化
  Stage Artifacts
  Session Event Log
  Workspace
────────────────────────────────
```

核心原则：

> 程序决定现在做哪一步，Agent 决定这一步具体怎么做，Validator 决定这一步是否完成，用户确认关键业务节点。

以后所有开发计划、提示词和进度判断都必须映射回这套架构。

---

# 2. 固定业务阶段

业务阶段严格沿用总体架构，不再另造一套阶段名称：

```text
S1 文件接入与拆块
 ↓
S2 提取招标要求和原子评分项
 ↓
S3 搜索资料并建立评分证据映射
 ↓
S4 生成详细目录和每章提纲
 ↓
S5 用户确认目录
 ↓
S6 按章节编写正文
 ↓
S7 整书评分覆盖与事实审核
 ↓
S8 确定性导出 DOCX
```

不得跳阶段。

MVP 截止到：

```text
S5 用户确认目录
```

也就是：

```text
真实文件上传
→ 文档拆块
→ 招标分析
→ 评分证据映射
→ L3 目录
→ 每章详细提纲
→ 用户确认
```

---

# 3. 正确的状态管理

状态管理属于 **Bid Orchestrator + Session Event Log**。

不要再创建独立于总体架构的 `.bid-dev` 状态机。

## 3.1 状态结构

建议只维护两层：

```ts
interface BidRuntimeState {
  stage: BidStage
  status: StageRunStatus
}
```

其中：

```ts
type BidStage =
  | 'file_intake'
  | 'tender_analysis'
  | 'evidence_mapping'
  | 'outline_generation'
  | 'outline_confirmation'
  | 'chapter_writing'
  | 'book_review'
  | 'docx_export'
```

阶段内部运行状态：

```ts
type StageRunStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'failed'
  | 'completed'
```

不要再增加另一套 `FILES_READY / CORPUS_READY / ...` 业务阶段。

文件、chunks、analysis 等是否存在，应由 **Artifact + Validator** 判断。

## 3.2 状态归属

```text
Bid Orchestrator
    ↓
决定 stage / status
    ↓
写入 Session Event Log
    ↓
Web Client 从真实状态展示进度
```

Agent：

```text
无权修改 stage
无权声明 stage completed
```

Workspace：

```text
保存内容
不决定状态
```

---

# 4. 正确的任务分配

任务分配属于：

```text
Bid Orchestrator
        ↓
读取 Stage Policy
        ↓
生成“当前阶段任务单”
        ↓
交给对应执行者
```

执行者有三种：

```text
deterministic program
Agent
User
```

不是所有阶段都交给 Agent。

---

# 5. Stage Policy

每个固定阶段必须有一个 Stage Policy。

Stage Policy 定义：

```ts
interface BidStagePolicy {
  stage: BidStage

  executor:
    | 'program'
    | 'agent'
    | 'user'

  requiredInputs: string[]

  allowedTools: string[]

  forbiddenTools?: string[]

  requiredArtifacts: string[]

  validator: string

  nextStage: BidStage | null
}
```

例如 S2：

```yaml
stage: tender_analysis

executor: agent

requiredInputs:
  - tender chunks

allowedTools:
  - glob
  - grep
  - read
  - write

requiredArtifacts:
  - analysis/project.json
  - analysis/requirements.json
  - analysis/scoring.json
  - analysis/compliance.json

validator:
  tender-analysis-validator

nextStage:
  evidence_mapping
```

---

# 6. 当前阶段任务单

Orchestrator 不能只告诉 Agent：

```text
“分析招标书”
```

必须根据 Stage Policy 生成完整任务单。

例如：

```ts
interface BidStageTask {
  stage: BidStage

  objective: string

  inputs: string[]

  requiredArtifacts: string[]

  allowedTools: string[]

  constraints: string[]
}
```

Agent 每次只接收当前 StageTask。

Agent 不需要看到整套流程并自己判断下一步。

---

# 7. Validator

Validator 属于控制面。

固定流程：

```text
Orchestrator
 ↓
分配 StageTask
 ↓
Program / Agent 执行
 ↓
产出 Stage Artifact
 ↓
Validator
 ├─ 失败 → 状态仍留在当前 Stage
 └─ 成功 → Orchestrator 切换下一 Stage
```

Agent 的自然语言回复：

```text
不是阶段完成凭证
```

Stage Artifact 通过 Validator 才算完成。

---

# 8. Session Event Log

DSH 已经有 Session Event Log 基础设施。

Bid Harness 只需要增加 Bid 业务事件。

例如：

```text
bid.stage.started
bid.stage.failed
bid.stage.completed
bid.user_confirmation.required
bid.user_confirmation.received
```

事件保存：

```text
阶段
状态变化
失败原因
用户确认
执行进度
```

不保存：

```text
大体积正文
chunks 全文
最终标书正文
```

这些仍放 Workspace。

---

# 9. Artifact

每一个阶段都必须有确定性的 Stage Artifact。

| Stage | 必须产物 |
|---|---|
| S1 文件接入与拆块 | manifest + document + chunks/index |
| S2 招标分析 | project / requirements / scoring / compliance |
| S3 证据映射 | evidence-map |
| S4 目录与提纲 | outline |
| S5 用户确认 | confirmation record |
| S6 正文 | chapter drafts |
| S7 审核 | review report |
| S8 导出 | final docx |

Validator 校验 Artifact。

Orchestrator 不通过“Agent 说完成了”判断状态。

---

# 10. 当前代码实际完成度

## 10.1 Web Client

**状态：⬜ 未开发 Bid 接入**

总体架构职责：

```text
上传资料
展示进度
目录确认
正文查看
产物下载
```

当前 Bid 专用 Web 接入尚未完成。

---

## 10.2 Bid Orchestrator

**状态：⬜ 未实现**

当前总体架构已有设计，但没有对应 Bid Orchestrator 生产实现。

需要负责：

```text
读取当前阶段
读取 Stage Policy
创建当前 StageTask
调用执行者
等待结果
调用 Validator
记录状态
阶段切换
等待用户确认
```

---

## 10.3 Stage Policy

**状态：⬜ 未实现**

需要定义八个固定阶段的：

```text
executor
inputs
allowed tools
required artifacts
validator
next stage
```

---

## 10.4 Stage Validator

**状态：⬜ 未实现**

目前还没有完整的 Bid Stage Validator 系统。

应按 Artifact 校验。

---

## 10.5 Bid Agent Preset

**状态：⬜ 未实现**

DSH Preset 基础设施已有。

需要补：

```text
Bid Agent 静态规则
```

只放长期稳定的标书规则。

不能把每个阶段具体任务全部塞进 Preset。

---

## 10.6 当前阶段任务单

**状态：⬜ 未实现**

StageTask 应由：

```text
Orchestrator + Stage Policy
```

动态生成。

---

## 10.7 阶段工具与 Guard

**状态：⬜ Bid 业务约束未实现**

DSH Tool 系统已有。

Bid 只需要定义不同 Stage：

```text
允许哪些已有工具
禁止哪些工具
```

不要重新实现工具系统。

---

## 10.8 Harness Agent Loop

**状态：✅ DSH 已有**

直接复用。

禁止修改。

---

## 10.9 Model

**状态：✅ DSH 已有**

直接复用模型 Provider。

---

## 10.10 Document Pipeline

**状态：🟡 部分完成**

已完成：

```text
BidWorkspace.import
PDF
DOCX
DOC
XLS/XLSX
TXT/MD
document.md
structure.json
metadata.json
```

还缺：

```text
document_chunk
chunks/index.json
```

所以 S1 仍未完整完成。

---

## 10.11 Workspace Knowledge

**状态：🟡 基础完成**

已有：

```text
input/
corpus/
manifest
```

后续逐步增加：

```text
chunks/
analysis/
outline/
drafts/
review/
output/
```

无需重新设计新的 Workspace 系统。

---

## 10.12 Retrieval

**状态：✅ DSH 已有基础能力**

正确链路：

```text
LLM 生成检索词
 ↓
DSH grep
 ↓
DSH read
```

禁止新建：

```text
bid_search
bid_read_context
search_chunks
read_chunk
```

总体架构文档中现有 `bid_read_context` 描述需要修正。

---

## 10.13 Session Event Log

**状态：🟡 DSH 已有基础，Bid 业务事件未实现**

无需重新开发 Event Log。

需要补 Bid Stage 事件。

---

## 10.14 Stage Artifacts

**状态：🟡 只有文件语料 Artifact**

已有：

```text
manifest
document
structure
metadata
```

还未定义：

```text
analysis artifacts
evidence artifact
outline artifact
confirmation artifact
draft artifact
review artifact
```

---

# 11. 按总体架构拆开发任务

下面的任务不再按“想到一个功能就开一个 PR”。

全部挂到总体架构模块。

---

# 12. 第一批：必须先确定公共合同

## T1 Control Plane Contract

内容：

```text
BidStage
StageRunStatus
BidStagePolicy
BidStageTask
StageArtifact
StageValidationResult
Bid stage events
```

负责总体架构里的：

```text
Bid Orchestrator
Stage Policy
Stage Validator
Session Event Log
Stage Artifact
```

这一 PR 只确定公共接口与状态模型。

不要在这里写具体招标分析 Prompt。

**优先级：最高**

---

# 13. T1 合并后可以并行的开发线

```text
                         T1
             Control Plane Contract
                         │
         ┌───────────────┼────────────────┐
         │               │                │
         ▼               ▼                ▼
   Lane A            Lane B           Lane C
 Document Pipeline  Orchestrator     Agent Execution
         │               │                │
         └──────┬────────┴───────┬────────┘
                │                │
                ▼                ▼
         Tender Analysis     Web Client
                │
                ▼
         Evidence Mapping
                │
                ▼
         Outline + Plan
```

---

# 14. Lane A：Document Pipeline

**可与 Lane B / C 并行。**

任务：

```text
document_chunk
```

属于总体架构：

```text
Document Pipeline
```

实现：

```text
document.md
 ↓
chunks/
 ↓
index.json
```

完成后 S1 的数据面才完整。

---

# 15. Lane B：Bid Orchestrator

**T1 后可以独立开发。**

属于总体架构：

```text
Control Plane
```

实现：

```text
读取 Stage State
 ↓
读取 Stage Policy
 ↓
创建 StageTask
 ↓
调用 executor
 ↓
调用 Validator
 ↓
写 Session Event
 ↓
阶段转换
```

先使用 fake executor / fixture 测试流程即可。

因此不必等待真正 Tender Agent。

---

# 16. Lane C：Agent Execution

**T1 后可以与 Orchestrator 并行。**

属于总体架构：

```text
Execution Plane
```

包括：

```text
Bid Agent Preset
StageTask 注入
阶段工具 Guard
```

只复用 DSH：

```text
Agent Loop
Skill
Tool
grep
read
write
web_search
```

不建立新 Agent Loop。

---

# 17. Lane D：Artifact + Validator

可以在 T1 后并行。

先实现 S1/S2 Artifact contract。

例如：

```text
S1:
corpus manifest
chunk index

S2:
project
requirements
scoring
compliance
```

并实现对应 Validator。

这条线直接为 Orchestrator 提供完成判断。

---

# 18. Lane E：Web Client

Web Client 不应该自己判断阶段。

依赖：

```text
Control Plane Contract
```

之后可以开始：

```text
文件上传
Stage progress 展示
WAITING_USER 展示
目录确认
```

前端永远只展示 Host 状态。

---

# 19. 真正的第一轮并行关系

现在不应该马上开四个互相定义接口的 Codex。

正确顺序：

```text
第一步：

T1 Control Plane Contract
+
Lane A Document Chunk

这两个可以立即并行。
```

原因：

```text
Document Chunk
```

属于数据面，与 Control Plane contract 耦合很低。

等 T1 合并以后：

```text
Lane B Bid Orchestrator
Lane C Agent Execution
Lane D Artifact + Validator
Lane E Web Client
```

四条线可以并行。

这才符合总体架构。

---

# 20. 第二阶段：Tender Analysis

等以下完成：

```text
Document Chunk
Control Plane
Agent Execution
S2 Artifact Contract
```

开始：

```text
S2 提取招标要求和原子评分项
```

这一阶段 Agent 接收：

```text
StageTask
```

然后：

```text
grep
 ↓
read
 ↓
LLM 判断
 ↓
write analysis artifacts
```

Validator 校验：

```text
project.json
requirements.json
scoring.json
compliance.json
```

通过后：

```text
Orchestrator:
tender_analysis completed
→ evidence_mapping pending
```

---

# 21. 第三阶段：Evidence Mapping

直接复用同一套：

```text
Orchestrator
Stage Policy
StageTask
Agent
Validator
```

只换：

```text
Stage Policy
Artifact
Prompt/Skill
```

不开发第二条流程。

---

# 22. 第四阶段：Outline

同样：

```text
Stage = outline_generation
```

StageTask 要求 Agent：

```text
读取：
project
requirements
scoring
compliance
evidence-map

生成：
L2/L3 目录
每章详细提纲
```

Validator 校验：

```text
评分点全部映射
技术要求全部映射
强制项全部响应
每个 L3 有 purpose / must_answer / refs
```

成功后进入：

```text
outline_confirmation
```

---

# 23. 第五阶段：用户确认

执行者：

```text
user
```

这里 Agent 不工作。

Orchestrator：

```text
status = waiting_user
```

Web Client：

```text
显示目录
接受确认 / 修改
```

确认事件写：

```text
Session Event Log
```

Validator / Orchestrator 决定是否进入正文阶段。

MVP 到这里完成。

---

# 24. 当前总体进度

| 总体架构模块 | 状态 |
|---|---|
| Web Client Bid UI | ⬜ |
| Bid Orchestrator | ✅ 控制面 runtime |
| Stage Policy | ✅ 八个固定阶段策略 |
| Stage Validator | 🟡 Port 已完成，真实业务 Validator 未实现 |
| Bid Client Projection | ✅ `bid.runtime` |
| Bid Prompt Admission | ✅ 后端 guard |
| Bid Agent Preset | ⬜ |
| StageTask 构建 | ✅ 后端确定性构建 |
| StageTask 注入 | ⬜ |
| Stage Tools / Guard | ⬜ |
| Harness Agent Loop | ✅ DSH 已有 |
| Model Provider | ✅ DSH 已有 |
| Document Pipeline - intake | ✅ |
| Document Pipeline - extract | ✅ |
| Document Pipeline - chunk | ✅ |
| Workspace 基础 | ✅ |
| DSH grep/read | ✅ |
| Bid Control Plane Contract | ✅ |
| Bid Session Events | ✅ |
| S1 Artifact | ✅ |
| S2 Artifact | ⬜ |
| S3 Artifact | ⬜ |
| S4 Artifact | ⬜ |
| DOCX primitive | 🟡 |

---

# 25. 当前可并行开发项

以下共享基础已经完成：

```text
Document Chunk
Control Plane Contract
Bid Session Events
Bid Orchestrator Runtime
Stage Policy
Bid Client Projection
```

以下开发线可以继续并行：

```text
Agent Execution
Artifact + Validator
Web Client
```

---

# 26. 以后所有提示词必须遵守

每个 Codex 开发提示词开头都必须声明：

```text
本任务属于总体架构的哪个模块？
本任务属于哪个固定 Stage？
依赖哪些已完成模块？
复用哪些 DSH 原生能力？
输出哪个 Stage Artifact？
由哪个 Validator 验收？
是否影响 Bid Orchestrator 状态转换？
```

如果这七个问题回答不出来：

```text
不应该开始编码。
```

这样后续所有开发都沿着同一张总体架构走，不再每轮聊天重新发明架构。

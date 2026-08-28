# Bid Harness Overall Architecture

English | [中文](bid-overall-architecture.zh.md)

> **Guiding principle: the program selects the current step, the agent decides how to perform it, the validator decides whether it is complete, and the user confirms key business decisions.**

![Bid Harness overall architecture](./assets/bid-overall-architecture.svg)

## Responsibility boundaries

| Role | Responsible for | Not responsible for |
|---|---|---|
| Web Client | Uploads, progress display, outline confirmation, content viewing, artifact downloads | Stage decisions and generation orchestration |
| Bid Orchestrator | Stage state, task injection, tool restrictions, retries, chapter iteration, user waits | Content interpretation and prose generation |
| Agent | Stage-local search, reading, reasoning, outline design, and writing | Skipping stages or modifying business state |
| Validator | Checking that stage artifacts are complete, valid, and cover requirements | Generating content for the agent |
| Document Pipeline | Document parsing, structured chunking, indexing, and context lookup | LLM-based summarization or compression |
| Session Event Log | Business facts such as stage, failure, confirmation, and progress | Large document bodies |
| Workspace | Source materials, document chunks, stage artifacts, and final files | Workflow state decisions |

## Fixed major stages

```text
文件接入与拆块
→ 提取招标要求和原子评分项
→ 搜索资料并建立评分证据映射
→ 生成详细目录和每章提纲
→ 用户确认目录
→ 按章节编写正文
→ 整书评分覆盖与事实审核
→ 确定性导出 DOCX
```

The `Bid Orchestrator` enforces the major stages and does not permit skipping them. Within a stage, the agent selects search terms, reading order, follow-up searches, and content organization.

## Key invariants

1. **An agent response is not completion evidence.** The Orchestrator advances only after the stage artifact passes validation.
2. **The agent cannot modify the stage.** Only the Orchestrator performs stage transitions.
3. **A search hit is not evidence.** `rg` locates candidate chunks; the agent reads parent headings, surrounding chunks, and complete tables through `bid_read_context`.
4. **Scoring requirements govern the full workflow.** Scoring items guide retrieval, outline coverage, chapter writing, and the final audit.
5. **State and content remain separate.** The Session Event Log stores business state; the Workspace stores materials and artifacts.
6. **Document processing is deterministic.** Upload, parsing, chunking, indexing, and DOCX export are program operations rather than model decisions.
7. **The frontend contains no business logic.** It submits user intent and displays authoritative Host state.
8. **The product has one writing pipeline.** New modes, search capabilities, and reuse of historical bids extend existing stages or tools instead of creating a parallel generation path.

## Stage execution model

```text
Orchestrator 读取当前阶段
        ↓
注入本阶段任务单与工具限制
        ↓
Agent 自主搜索、阅读、推理和写作
        ↓
Agent 提交结构化阶段产物
        ↓
Validator 校验
   ┌────┴────┐
   │         │
 失败        通过
   │         │
留在本阶段   进入下一阶段
并注入错误   或等待用户确认
```

## Extension principles

Public search, historical-bid reuse, chapter rewriting, template export, and enterprise knowledge bases should extend:

- Stage-local tools
- Bid Agent Preset
- Stage Policy
- Validator
- Document Pipeline
- Artifact types

Do not modify the Harness Agent Loop or create a parallel bid-generation pipeline unless the existing extension points cannot implement the requirement.

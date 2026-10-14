---
name: bid-writing-workflow
description: 当用户提出写标书类需求时使用，包括编写、续写或修改标书及投标文件；每阶段生成 HTML 成果页面，供用户审阅、修改和确认后继续。
---

# 标书编制

在用户选定的工作目录中运行本技能。用当前 Agent 可用的文档工具读取 PDF、Word、图片和表格；用本技能自带的 Python 3 标准库脚本保存项目状态、校验结构、记录确认并生成基本 DOCX。技能目录可以复制到任意位置，不读取或调用其他项目。

## 开始或继续

- 新项目：`python <技能目录>/scripts/workflow.py init <工作目录> --tender <招标文件>`；`--tender` 可重复，可按需添加 `--framework`、`--prior-bid`、`--reference`。脚本复制原件并生成 `artifacts/01-intake.json` 待检查稿。
- 已有项目：`python <技能目录>/scripts/workflow.py status <工作目录>`，从首个未确认阶段继续。新增资料用 `add-source <工作目录> --role tender|framework|prior_bid|reference --file <文件>`，会退回文件接入阶段。
- 阶段 JSON 格式和命令见 [产物与命令](references/artifacts.md)。脚本退出码非零时修正产物后重试；不得把失败当作阶段完成。

## 六个阶段

1. **文件接入**：核实每份资料角色和可读性，按用户要写的标书范围检查招标正文、评分表及附件；更新 `01-intake.json` 的检查结果并提交。关键内容无法读取时停在本阶段。读取 [招标分析规则](references/tender-analysis.md)。
2. **招标分析**：只从招标文件提取项目事实、相关要求、评分原文和合规项，逐项写明文件及位置，形成 `02-analysis.json`。此阶段保留完整评分原文，不拆原子响应点。读取 [招标分析规则](references/tender-analysis.md)。
3. **初版目录**：逐项拆解评分响应点，以要求和评分为主生成章节及每章必答问题，形成 `03-initial-outline.json`。脚本核对结构、强制要求及评分覆盖。读取 [目录与证据规则](references/outline-evidence.md)。
4. **证据映射与终版目录**：按初版目录逐章回读资料，记录来源位置、支持用途、缺口和回答计划，形成 `04-final-outline.json`。不得因为资料缺失而删掉招标要求。读取 [目录与证据规则](references/outline-evidence.md)。
5. **章节写作与整书审核**：按终版目录写全部可写章节，逐章复核后再查全书覆盖、事实、合规与一致性，形成 `05-manuscript.json`。资料不足的企业事实保留为待解决问题，不编造客户正文。读取 [写作与导出规则](references/writing-export.md)。
6. **DOCX 导出与验收**：执行 `export <工作目录>`，从已确认正文生成 DOCX；实际打开检查版面，交给用户验收。基本导出支持标题、段落和简单表格；复杂模板、图片与页码要求须用可用的文档工具处理，再以 `submit-docx` 提交最终文件。读取 [写作与导出规则](references/writing-export.md)。

每阶段先用 `submit <工作目录> <阶段名> <JSON文件>` 校验并保存最新产物。脚本随即生成独立的 `previews/<序号>-<阶段名>.html`，并返回完整路径；用当前 Agent 的预览能力或浏览器打开页面给用户看，再询问确认或修改。导出阶段的 `export` 和 `submit-docx` 也会生成 HTML 页面，并同时打开 DOCX 检查版面。只有收到用户对当前页面展示的成果的明确确认原话，才能运行 `confirm <工作目录> <阶段名> --user-confirmation <原话>`。确认后页面会更新为已确认状态；修改已确认的上游产物后，下游确认和旧预览页自动失效。阶段名和完整命令见 [产物与命令](references/artifacts.md)。Agent 不得自行填写或推定用户的确认。

检索命中只用于定位，结论须回读原文及上下文。旧标、模板和公开资料不授权招标要求；事实与引用要能回到具体来源。脚本只验证确定性结构和确认顺序，语义质量仍需 Agent 审阅与用户决定。

# 阶段产物与命令

此页给执行 Agent 使用。`<技能目录>` 是本 `SKILL.md` 所在目录；`<工作目录>` 是用户为当前标书指定的空目录。Windows 用 `python`，其他环境可用 `python3`。所有脚本仅依赖 Python 3 标准库。

## 命令

```text
python <技能目录>/scripts/workflow.py init <工作目录> --tender <文件> [--tender <文件>] [--framework <文件>] [--prior-bid <文件>] [--reference <文件>]
python <技能目录>/scripts/workflow.py status <工作目录>
python <技能目录>/scripts/workflow.py add-source <工作目录> --role tender|framework|prior_bid|reference --file <文件>
python <技能目录>/scripts/workflow.py submit <工作目录> <阶段名> <JSON文件>
python <技能目录>/scripts/workflow.py confirm <工作目录> <阶段名> --user-confirmation <用户原话>
python <技能目录>/scripts/workflow.py export <工作目录> [--title <标题>]
python <技能目录>/scripts/workflow.py submit-docx <工作目录> <最终DOCX>
```

阶段名按顺序为 `file_intake`、`tender_analysis`、`initial_outline`、`evidence_mapping`、`chapter_writing`、`docx_export`。只有前阶段确认后才能提交后阶段。重新提交较早阶段会撤销该阶段和后续确认；原文件保留，但不能当成当前有效成果。每次 `submit`、`export` 或 `submit-docx` 成功后，命令返回 `preview` 字段，指向该阶段独立的 HTML 页面。先打开页面给用户审阅，接受修改或明确确认，再运行 `confirm`。确认会更新页面状态；上游修改会删除失效的下游页面。DOCX 阶段还须打开实际 Word 文件检查版面。

## JSON 结构

`init` 会生成 `artifacts/01-intake.json`。逐份更新 `readable` 和不可读原因，保留 `path`、`role` 与资料清单一致：

```json
{"files":[{"path":"inputs/001-招标文件.txt","role":"tender","readable":true}],"inspection":"已核对正文、评分和附件；未发现缺页。"}
```

`02-analysis.json` 中来源必须指向已入库的招标文件；`location` 使用页码、条款或表格位置。评分保留原文，响应点在下一阶段拆解：

```json
{"project":{"title":"示例投标文件","summary":"采购实施服务"},"requirements":[{"text":"提供实施计划","mandatory":true,"source":{"file":"inputs/001-招标文件.txt","location":"第2条"}}],"scoring":[{"title":"实施方案","original_text":"步骤和进度完整得分","source":{"file":"inputs/001-招标文件.txt","location":"评分表第1行"}}],"compliance":[]}
```

`03-initial-outline.json` 中 `response_points` 与评分项顺序对应。章节使用从 1 开始的位置引用；评分响应点按评分项及其子项顺序连续编号。`parent_position` 为父章节位置，顶级章节用 `null`：

```json
{"response_points":[["实施步骤","进度安排"]],"sections":[{"title":"实施方案","parent_position":null,"writable":true,"must_answer":["如何实施并安排进度"],"requirement_positions":[1],"scoring_positions":[1],"response_point_positions":[1,2],"compliance_positions":[]}],"global_compliance_positions":[]}
```

`04-final-outline.json` 保留同样的 `response_points`、`sections`、`global_compliance_positions`，并为每个可写章节加入 `research`。本地证据写 `file`，公开证据写 `url` 和 `accessed_at`；两种都需 `location` 与 `use`。资料不足时说明 `missing_topics`，不能伪造证据：

```json
{"response_points":[["实施步骤","进度安排"]],"sections":[{"title":"实施方案","parent_position":null,"writable":true,"must_answer":["如何实施并安排进度"],"requirement_positions":[1],"scoring_positions":[1],"response_point_positions":[1,2],"compliance_positions":[]}],"global_compliance_positions":[],"research":[{"section_position":1,"evidence":[{"file":"inputs/001-招标文件.txt","location":"第2条","use":"约束实施范围"}],"missing_topics":["企业实际交付人员待核实"],"answer_plan":"说明步骤、进度与核验方式，不写未证实人员信息。"}]}
```

`05-manuscript.json` 的每个可写章节必须有正文、实际审查结论及回答位置。正文可以使用段落、以 `#` 或 `##` 开头的小标题、简单 Markdown 表格。整书审核须无未解决问题：

```json
{"chapters":[{"section_position":1,"body":"我方拟分三个步骤完成实施，并在每阶段提交验收记录。","answered_requirement_positions":[1],"answered_response_point_positions":[1,2],"review":"passed"}],"whole_book_review":{"result":"passed","issues":[]}}
```

结构校验只能发现缺字段、错误位置、遗漏映射和未通过的复核标记；来源真实性、评分响应质量、内容一致性与最终版面必须由 Agent 与用户审阅。

# AGENTS.md — 中文文档站

遵循[根目录规则](../AGENTS.md)、[文档标准](../docs/AGENTS.md)和[文档站同步流程](../.agents/skills/dsh-doc-site-sync/SKILL.md)。

`website/` 只存放 VitePress 配置、展示资源与发布清单；正文和生成参考留在所属的 `docs/` 目录，再由 [docs.ts](docs.ts) 选择中文页面发布。不要在此目录维护文档副本或英文路由树。

投影器写入可丢弃的 `website/.generated/`。不要编辑或提交 `.generated/`、`.cache/` 或 `.dist/`。构建会为每个页面生成原始 Markdown 地址，并在根目录生成 `llms.txt`；这些产物由发布清单生成。

修改本目录后运行定向的文档站检查。

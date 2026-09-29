---
name: dsh-doc-site-sync
description: 修改 DeepSeek Harness 中文文档站的页面清单、投影、导航或构建时使用。
---

# 中文文档站同步

仓库 Markdown 是唯一可编辑正文。文档站由 [website/docs.ts](../../../website/docs.ts) 选择中文页面，[scripts/project-doc-site.ts](../../../scripts/project-doc-site.ts) 投影到可丢弃的 `website/.generated/`，VitePress 再构建页面与原始 Markdown 地址。英文 Markdown 暂留仓库，但不发布，也不要求配对。

## 修改页面

- 阅读 [docs/AGENTS.md](../../../docs/AGENTS.md) 和 [dsh-doc-standards](../dsh-doc-standards/SKILL.md)。
- 修改已发布页面时，编辑 `source` 指向的中文正文；只有路由或导航元数据变化才改清单。
- 新增页面时，在所属 `docs/` 目录创建中文 Markdown，并在清单加入一条明确映射。
- 移动或删除页面时，同步更新清单与入站链接。
- 生成参考页应修改生成器或其源数据，再发布生成的中文正文。
- `sourceAliases` 可把既有仓库路径映射到中文页面，不创建额外发布路由。
- 不编辑或提交 `website/.generated/`、`website/.cache/`、`website/.dist/`。

## 链接与验证

仓库相对链接若命中发布清单，会转为站内链接；其他现存目标转为 GitHub 源码链接；缺失目标使投影失败。图片必须是仓库内普通文件，由投影器复制。片段应能在站点中解析，必要时在正文或生成器加入明确锚点。

变更清单时运行定向的 `scripts/project-doc-site.spec.ts` 与 `docs:check`。用户要求完整文档检查时再运行 `doc-sync`。提交前检查 `git diff --check`。网站发布到公网属于独立操作。

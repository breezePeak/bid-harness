/** 中文文档站的发布清单。英文 Markdown 保留在仓库中，不参与发布。 */

export type DocsLocale = 'root'
export type DocsSidebar = 'zh-guide' | 'zh-develop' | 'zh-reference'

/** 文档站页面及其仓库正文来源。 */
export interface DocsPage {
  locale: DocsLocale
  contentLocale: 'zh-CN'
  source: string
  route: string
  label: string
  sidebar: DocsSidebar | null
  section: string
  order: number
  outline?: number | readonly [number, number] | 'deep' | false
  sourceAliases?: string[]
}

/** 侧栏分组的显示属性。 */
export interface DocsSection {
  label: string
  collapsed?: boolean
}

export const localeCollections = {
  root: ['zh-guide', 'zh-develop', 'zh-reference'],
} as const satisfies Record<DocsLocale, readonly DocsSidebar[]>

const sections: readonly DocsSection[] = [
  { label: '入门' }, { label: 'SDK' },
  { label: '基础' }, { label: '框架能力' }, { label: '实战' }, { label: 'Cordis 框架教程' },
  { label: '概念' }, { label: '生成参考' }, { label: 'Cordis API' }, { label: '开发手册' },
  { label: '总览' },
  { label: '内核与作用域', collapsed: true },
  { label: '会话与持久化', collapsed: true },
  { label: '模型与上下文', collapsed: true },
  { label: '执行与工具', collapsed: true },
  { label: '策略与交互', collapsed: true },
  { label: '平台与接入', collapsed: true },
]

/** 取得侧栏分组及其排序位置。 */
export function sectionSpec(_locale: DocsLocale, label: string): DocsSection & { index: number } {
  const section = sections.find(candidate => candidate.label === label)
  if (section === undefined) throw new Error(`Sidebar section "${label}" has no placement.`)
  return { ...section, index: sections.indexOf(section) }
}

/** 文档站发布的全部中文页面。 */
export const docsPages: DocsPage[] = [
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/index.zh.md','route':'index.md','label':'DeepSeek Harness','sidebar':null,'section':'首页','order':0,'sourceAliases':['docs/user/index.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/guide/index.zh.md','route':'guide/quickstart.md','label':'使用 Web UI','sidebar':'zh-guide','section':'入门','order':1,'sourceAliases':['docs/user/guide','docs/user/guide/index.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/guide/providers.zh.md','route':'guide/providers.md','label':'配置模型','sidebar':'zh-guide','section':'入门','order':2,'sourceAliases':['docs/user/guide/providers.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/guide/python-sdk.zh.md','route':'guide/python-sdk.md','label':'Python','sidebar':'zh-guide','section':'SDK','order':1,'sourceAliases':['docs/user/guide/python-sdk.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/develop/basic/index.zh.md','route':'develop/basic/index.md','label':'第一个 Harness 插件','sidebar':'zh-develop','section':'基础','order':1,'sourceAliases':['docs/user/develop/basic','docs/user/develop/basic/index.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/develop/basic/tool.zh.md','route':'develop/basic/tool.md','label':'开发一个 Tool','sidebar':'zh-develop','section':'基础','order':2,'sourceAliases':['docs/user/develop/basic/tool.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/develop/basic/config.zh.md','route':'develop/basic/config.md','label':'插件配置','sidebar':'zh-develop','section':'基础','order':3,'sourceAliases':['docs/user/develop/basic/config.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/develop/basic/publish.zh.md','route':'develop/basic/publish.md','label':'打包与安装插件','sidebar':'zh-develop','section':'基础','order':4,'sourceAliases':['docs/user/develop/basic/publish.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/develop/framework/index.zh.md','route':'develop/framework/index.md','label':'插件与生命周期','sidebar':'zh-develop','section':'框架能力','order':1,'sourceAliases':['docs/user/develop/framework','docs/user/develop/framework/index.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/develop/framework/service.zh.md','route':'develop/framework/service.md','label':'服务与依赖','sidebar':'zh-develop','section':'框架能力','order':2,'sourceAliases':['docs/user/develop/framework/service.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/develop/framework/events.zh.md','route':'develop/framework/events.md','label':'事件系统','sidebar':'zh-develop','section':'框架能力','order':3,'sourceAliases':['docs/user/develop/framework/events.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/develop/practice/index.zh.md','route':'develop/practice/index.md','label':'能力的三层拆分','sidebar':'zh-develop','section':'实战','order':1,'sourceAliases':['docs/user/develop/practice','docs/user/develop/practice/index.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/user/develop/practice/llm-adapter.zh.md','route':'develop/practice/llm-adapter.md','label':'LLM 适配器','sidebar':'zh-develop','section':'实战','order':2,'sourceAliases':['docs/user/develop/practice/llm-adapter.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-tutorial/index.zh.md','route':'develop/cordis-tutorial/index.md','label':'总览','sidebar':'zh-develop','section':'Cordis 框架教程','order':0,'sourceAliases':['docs/cordis-tutorial','docs/cordis-tutorial/index.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-tutorial/01-first-plugin.zh.md','route':'develop/cordis-tutorial/01-first-plugin.md','label':'1. 第一个插件','sidebar':'zh-develop','section':'Cordis 框架教程','order':1,'sourceAliases':['docs/cordis-tutorial/01-first-plugin.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-tutorial/02-lifecycle-and-effects.zh.md','route':'develop/cordis-tutorial/02-lifecycle-and-effects.md','label':'2. 生命周期与副作用','sidebar':'zh-develop','section':'Cordis 框架教程','order':2,'sourceAliases':['docs/cordis-tutorial/02-lifecycle-and-effects.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-tutorial/03-services.zh.md','route':'develop/cordis-tutorial/03-services.md','label':'3. 服务','sidebar':'zh-develop','section':'Cordis 框架教程','order':3,'sourceAliases':['docs/cordis-tutorial/03-services.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-tutorial/04-events.zh.md','route':'develop/cordis-tutorial/04-events.md','label':'4. 事件','sidebar':'zh-develop','section':'Cordis 框架教程','order':4,'sourceAliases':['docs/cordis-tutorial/04-events.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-tutorial/05-config.zh.md','route':'develop/cordis-tutorial/05-config.md','label':'5. 配置','sidebar':'zh-develop','section':'Cordis 框架教程','order':5,'sourceAliases':['docs/cordis-tutorial/05-config.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-tutorial/06-composition-and-hmr.zh.md','route':'develop/cordis-tutorial/06-composition-and-hmr.md','label':'6. 组合与热重载','sidebar':'zh-develop','section':'Cordis 框架教程','order':6,'sourceAliases':['docs/cordis-tutorial/06-composition-and-hmr.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-tutorial/07-into-the-harness.zh.md','route':'develop/cordis-tutorial/07-into-the-harness.md','label':'7. 进入 Harness','sidebar':'zh-develop','section':'Cordis 框架教程','order':7,'sourceAliases':['docs/cordis-tutorial/07-into-the-harness.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-primer.zh.md','route':'reference/cordis-primer.md','label':'Cordis 入门','sidebar':'zh-reference','section':'概念','order':1,'sourceAliases':['docs/cordis-primer.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/README.zh.md','route':'reference/subsystems/index.md','label':'子系统','sidebar':'zh-reference','section':'总览','order':0,'outline':[2,3],'sourceAliases':['docs/subsystems','docs/subsystems/README.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/core.zh.md','route':'reference/subsystems/core.md','label':'核心','sidebar':'zh-reference','section':'内核与作用域','order':0,'outline':[2,3],'sourceAliases':['docs/subsystems/core.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/scope.zh.md','route':'reference/subsystems/scope.md','label':'作用域','sidebar':'zh-reference','section':'内核与作用域','order':1,'outline':[2,3],'sourceAliases':['docs/subsystems/scope.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/invariants.zh.md','route':'reference/subsystems/invariants.md','label':'运行时不变式','sidebar':'zh-reference','section':'内核与作用域','order':2,'outline':[2,3],'sourceAliases':['docs/subsystems/invariants.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/session.zh.md','route':'reference/subsystems/session.md','label':'会话','sidebar':'zh-reference','section':'会话与持久化','order':0,'outline':[2,3],'sourceAliases':['docs/subsystems/session.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/session-query.zh.md','route':'reference/subsystems/session-query.md','label':'会话查询','sidebar':'zh-reference','section':'会话与持久化','order':1,'outline':[2,3],'sourceAliases':['docs/subsystems/session-query.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/session-reference.zh.md','route':'reference/subsystems/session-reference.md','label':'会话引用','sidebar':'zh-reference','section':'会话与持久化','order':2,'outline':[2,3],'sourceAliases':['docs/subsystems/session-reference.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/session-title.zh.md','route':'reference/subsystems/session-title.md','label':'会话标题','sidebar':'zh-reference','section':'会话与持久化','order':3,'outline':[2,3],'sourceAliases':['docs/subsystems/session-title.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/session-projection.zh.md','route':'reference/subsystems/session-projection.md','label':'会话投影','sidebar':'zh-reference','section':'会话与持久化','order':4,'outline':[2,3],'sourceAliases':['docs/subsystems/session-projection.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/persistence.zh.md','route':'reference/subsystems/persistence.md','label':'会话持久化','sidebar':'zh-reference','section':'会话与持久化','order':5,'outline':[2,3],'sourceAliases':['docs/subsystems/persistence.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/spill.zh.md','route':'reference/subsystems/spill.md','label':'Spill 存储','sidebar':'zh-reference','section':'会话与持久化','order':6,'outline':[2,3],'sourceAliases':['docs/subsystems/spill.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/session-telemetry.zh.md','route':'reference/subsystems/session-telemetry.md','label':'遥测','sidebar':'zh-reference','section':'会话与持久化','order':7,'outline':[2,3],'sourceAliases':['docs/subsystems/session-telemetry.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/llm-streaming.zh.md','route':'reference/subsystems/llm-streaming.md','label':'LLM 流式响应','sidebar':'zh-reference','section':'模型与上下文','order':0,'outline':[2,3],'sourceAliases':['docs/subsystems/llm-streaming.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/token-meter.zh.md','route':'reference/subsystems/token-meter.md','label':'Token 计量','sidebar':'zh-reference','section':'模型与上下文','order':1,'outline':[2,3],'sourceAliases':['docs/subsystems/token-meter.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/system-prompt.zh.md','route':'reference/subsystems/system-prompt.md','label':'系统提示词','sidebar':'zh-reference','section':'模型与上下文','order':2,'outline':[2,3],'sourceAliases':['docs/subsystems/system-prompt.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/compaction.zh.md','route':'reference/subsystems/compaction.md','label':'上下文压缩','sidebar':'zh-reference','section':'模型与上下文','order':3,'outline':[2,3],'sourceAliases':['docs/subsystems/compaction.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/tools.zh.md','route':'reference/subsystems/tools.md','label':'工具','sidebar':'zh-reference','section':'执行与工具','order':0,'outline':[2,3],'sourceAliases':['docs/subsystems/tools.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/shell.zh.md','route':'reference/subsystems/shell.md','label':'Bash 执行','sidebar':'zh-reference','section':'执行与工具','order':1,'outline':[2,3],'sourceAliases':['docs/subsystems/shell.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/subprocess.zh.md','route':'reference/subsystems/subprocess.md','label':'子进程','sidebar':'zh-reference','section':'执行与工具','order':2,'outline':[2,3],'sourceAliases':['docs/subsystems/subprocess.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/terminal.zh.md','route':'reference/subsystems/terminal.md','label':'PTY 会话','sidebar':'zh-reference','section':'执行与工具','order':3,'outline':[2,3],'sourceAliases':['docs/subsystems/terminal.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/jobs.zh.md','route':'reference/subsystems/jobs.md','label':'后台任务','sidebar':'zh-reference','section':'执行与工具','order':4,'outline':[2,3],'sourceAliases':['docs/subsystems/jobs.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/filesystem.zh.md','route':'reference/subsystems/filesystem.md','label':'文件系统','sidebar':'zh-reference','section':'执行与工具','order':5,'outline':[2,3],'sourceAliases':['docs/subsystems/filesystem.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/lsp.zh.md','route':'reference/subsystems/lsp.md','label':'LSP 导航','sidebar':'zh-reference','section':'执行与工具','order':6,'outline':[2,3],'sourceAliases':['docs/subsystems/lsp.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/code-runtime.zh.md','route':'reference/subsystems/code-runtime.md','label':'代码运行时','sidebar':'zh-reference','section':'执行与工具','order':7,'outline':[2,3],'sourceAliases':['docs/subsystems/code-runtime.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/web.zh.md','route':'reference/subsystems/web.md','label':'Web 访问','sidebar':'zh-reference','section':'执行与工具','order':8,'outline':[2,3],'sourceAliases':['docs/subsystems/web.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/skills.zh.md','route':'reference/subsystems/skills.md','label':'技能','sidebar':'zh-reference','section':'执行与工具','order':9,'outline':[2,3],'sourceAliases':['docs/subsystems/skills.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/workflow.zh.md','route':'reference/subsystems/workflow.md','label':'工作流','sidebar':'zh-reference','section':'执行与工具','order':10,'outline':[2,3],'sourceAliases':['docs/subsystems/workflow.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/subagent.zh.md','route':'reference/subsystems/subagent.md','label':'子代理','sidebar':'zh-reference','section':'执行与工具','order':11,'outline':[2,3],'sourceAliases':['docs/subsystems/subagent.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/approval.zh.md','route':'reference/subsystems/approval.md','label':'审批','sidebar':'zh-reference','section':'策略与交互','order':0,'outline':[2,3],'sourceAliases':['docs/subsystems/approval.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/permission-presets.zh.md','route':'reference/subsystems/permission-presets.md','label':'权限预设','sidebar':'zh-reference','section':'策略与交互','order':1,'outline':[2,3],'sourceAliases':['docs/subsystems/permission-presets.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/sandbox.zh.md','route':'reference/subsystems/sandbox.md','label':'沙箱','sidebar':'zh-reference','section':'策略与交互','order':2,'outline':[2,3],'sourceAliases':['docs/subsystems/sandbox.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/plan.zh.md','route':'reference/subsystems/plan.md','label':'计划模式','sidebar':'zh-reference','section':'策略与交互','order':3,'outline':[2,3],'sourceAliases':['docs/subsystems/plan.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/user-questions.zh.md','route':'reference/subsystems/user-questions.md','label':'用户交互','sidebar':'zh-reference','section':'策略与交互','order':4,'outline':[2,3],'sourceAliases':['docs/subsystems/user-questions.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/commands.zh.md','route':'reference/subsystems/commands.md','label':'命令','sidebar':'zh-reference','section':'策略与交互','order':5,'outline':[2,3],'sourceAliases':['docs/subsystems/commands.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/goal.zh.md','route':'reference/subsystems/goal.md','label':'目标','sidebar':'zh-reference','section':'策略与交互','order':6,'outline':[2,3],'sourceAliases':['docs/subsystems/goal.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/schedule.zh.md','route':'reference/subsystems/schedule.md','label':'定时提醒','sidebar':'zh-reference','section':'策略与交互','order':7,'outline':[2,3],'sourceAliases':['docs/subsystems/schedule.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/web-server.zh.md','route':'reference/subsystems/web-server.md','label':'HTTP 服务器','sidebar':'zh-reference','section':'平台与接入','order':0,'outline':[2,3],'sourceAliases':['docs/subsystems/web-server.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/typert.zh.md','route':'reference/subsystems/typert.md','label':'Typert','sidebar':'zh-reference','section':'平台与接入','order':1,'outline':[2,3],'sourceAliases':['docs/subsystems/typert.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/client-modules.zh.md','route':'reference/subsystems/client-modules.md','label':'客户端模块','sidebar':'zh-reference','section':'平台与接入','order':2,'outline':[2,3],'sourceAliases':['docs/subsystems/client-modules.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/storage.zh.md','route':'reference/subsystems/storage.md','label':'存储','sidebar':'zh-reference','section':'平台与接入','order':3,'outline':[2,3],'sourceAliases':['docs/subsystems/storage.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/workspace.zh.md','route':'reference/subsystems/workspace.md','label':'工作区','sidebar':'zh-reference','section':'平台与接入','order':4,'outline':[2,3],'sourceAliases':['docs/subsystems/workspace.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/settings.zh.md','route':'reference/subsystems/settings.md','label':'用户设置','sidebar':'zh-reference','section':'平台与接入','order':5,'outline':[2,3],'sourceAliases':['docs/subsystems/settings.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/subsystems/credentials.zh.md','route':'reference/subsystems/credentials.md','label':'用户凭据','sidebar':'zh-reference','section':'平台与接入','order':6,'outline':[2,3],'sourceAliases':['docs/subsystems/credentials.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/architecture.zh.md','route':'reference/index.md','label':'架构','sidebar':'zh-reference','section':'概念','order':0,'sourceAliases':['docs/architecture.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/capability-seams.zh.md','route':'reference/capability-seams.md','label':'能力服务','sidebar':'zh-reference','section':'概念','order':2,'sourceAliases':['docs/capability-seams.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/agent-lifecycle.zh.md','route':'reference/agent-lifecycle.md','label':'Agent 生命周期','sidebar':'zh-reference','section':'概念','order':3,'sourceAliases':['docs/agent-lifecycle.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/tool-execution-pipeline.zh.md','route':'reference/tool-execution-pipeline.md','label':'Tool 执行','sidebar':'zh-reference','section':'概念','order':4,'sourceAliases':['docs/tool-execution-pipeline.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/config-catalog.zh.md','route':'reference/config-catalog.md','label':'插件配置','sidebar':'zh-reference','section':'生成参考','order':0,'sourceAliases':['docs/config-catalog.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/tool-catalog.zh.md','route':'reference/tool-catalog.md','label':'Tool Schema','sidebar':'zh-reference','section':'生成参考','order':1,'sourceAliases':['docs/tool-catalog.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/persistence-catalog.zh.md','route':'reference/persistence-catalog.md','label':'持久化事件','sidebar':'zh-reference','section':'生成参考','order':2,'outline':'deep','sourceAliases':['docs/persistence-catalog.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-api/context.zh.md','route':'reference/cordis-api/context.md','label':'Context','sidebar':'zh-reference','section':'Cordis API','order':0,'sourceAliases':['docs/cordis-api/context.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-api/events.zh.md','route':'reference/cordis-api/events.md','label':'Events','sidebar':'zh-reference','section':'Cordis API','order':1,'sourceAliases':['docs/cordis-api/events.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-api/fiber.zh.md','route':'reference/cordis-api/fiber.md','label':'Fiber','sidebar':'zh-reference','section':'Cordis API','order':2,'sourceAliases':['docs/cordis-api/fiber.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-api/registry.zh.md','route':'reference/cordis-api/registry.md','label':'Plugin Registry','sidebar':'zh-reference','section':'Cordis API','order':3,'sourceAliases':['docs/cordis-api/registry.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cordis-api/service.zh.md','route':'reference/cordis-api/service.md','label':'Service','sidebar':'zh-reference','section':'Cordis API','order':4,'sourceAliases':['docs/cordis-api/service.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cookbook/adding-a-package.zh.md','route':'reference/cookbook/adding-a-package.md','label':'新增 Package','sidebar':'zh-reference','section':'开发手册','order':0,'sourceAliases':['docs/cookbook/adding-a-package.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cookbook/adding-a-tool.zh.md','route':'reference/cookbook/adding-a-tool.md','label':'新增 Tool','sidebar':'zh-reference','section':'开发手册','order':1,'sourceAliases':['docs/cookbook/adding-a-tool.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cookbook/adding-an-llm-adapter.zh.md','route':'reference/cookbook/adding-an-llm-adapter.md','label':'新增 LLM Adapter','sidebar':'zh-reference','section':'开发手册','order':2,'sourceAliases':['docs/cookbook/adding-an-llm-adapter.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cookbook/adding-a-settings-card.zh.md','route':'reference/cookbook/adding-a-settings-card.md','label':'新增设置卡片','sidebar':'zh-reference','section':'开发手册','order':3,'sourceAliases':['docs/cookbook/adding-a-settings-card.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cookbook/extension-cookbook.zh.md','route':'reference/cookbook/extension-cookbook.md','label':'扩展模式','sidebar':'zh-reference','section':'开发手册','order':4,'sourceAliases':['docs/cookbook/extension-cookbook.md'] },
  { 'locale':'root','contentLocale':'zh-CN','source':'docs/cookbook/adding-a-conversation-node.zh.md','route':'reference/cookbook/adding-a-conversation-node.md','label':'新增 Conversation Node','sidebar':'zh-reference','section':'开发手册','order':5,'sourceAliases':['docs/cookbook/adding-a-conversation-node.md'] },
]

/** 按分组与声明顺序返回侧栏页面。 */
export function orderedPages(locale: DocsLocale, collection: DocsSidebar): DocsPage[] {
  return docsPages
    .filter(page => page.locale === locale && page.sidebar === collection)
    .sort((left, right) => sectionSpec(locale, left.section).index - sectionSpec(locale, right.section).index || left.order - right.order)
}

/** 返回 VitePress 发布的页面地址。 */
export function routeLink(route: string): string {
  return `/${route.replace(/(?:index)?\.md$/, '')}`
}

/** 返回导航栏对应分组的首个页面地址。 */
export function landingLink(locale: DocsLocale, collection: DocsSidebar): string {
  const first = orderedPages(locale, collection)[0]
  if (first === undefined) throw new Error(`Sidebar collection "${collection}" publishes no page.`)
  return routeLink(first.route)
}

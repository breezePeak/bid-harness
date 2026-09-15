# Agent Note: S4 只接受当前 Web Fetch 工具统计

Status: implemented

## Problem

S4 的正式模型工具名已经统一为 `web_fetch`，但执行日志读取仍保留旧工具名迁移路径，源码、产物和磁盘格式因此继续携带已删除的工具契约。开发运行时若加载陈旧 `lib`，Subagent 的 toolFilter 会允许不存在的工具并在 `tools.restrict()` 处失败。

## Decision

S4 的 Subagent toolFilter、Host 注册、研究历史、统计 schema、执行日志和 README 只使用 `web_search` 与 `web_fetch`。`parseEvidenceMappingExecutionLog()` 直接校验当前 schema，不再迁移旧日志字段；首次发布前的磁盘格式不提供兼容垫片，旧 S4 日志需要按当前流程重置。Bid 的源码、Host `lib`、CLI bundle 和生成文件由 `verify-bid-web-tool-name.ts` 扫描，发现已删除工具名或错误的 `MAPPING_AGENT_TOOLS` 就失败。

## Alternatives considered

**保留旧日志迁移并隐藏旧字段名。** 不采用。兼容路径会让已删除契约继续存在于源码和持久化边界，也会延长首发前不需要承担的格式兼容范围。

**只修改源码而依赖开发者手动构建。** 不采用。`package.json` 默认入口指向 `lib/index.js`，手动构建遗漏时会让源码与运行时静默分叉。

**让 reset S4 重新加载插件。** 不采用。插件已经在进程启动时导入；reset 只改变业务阶段和产物状态，修改 Host 源码后必须重启进程。

## Consequences

`pnpm dsh` 与 `pnpm run bid:s4-replay` 在启动源码入口前先执行 `build:lib:host` 和工具名检查，因此 Host 源码修改不会静默运行旧 `lib`。源码启动通过 tsx paths 使用当前源码，构建后的包入口仍通过 `exports` 使用新生成的 `lib`；两条路径都不接受旧工具名。完整 Web 运行仍需完整 `pnpm run build` 生成前端与 Client 产物。

## Verification

Bid executor 测试断言 S4 Subagent 的最终 `toolFilter.allow` 恰为 `['web_search', 'web_fetch']`；`verify:bid-web-tool-name` 检查源码、构建产物和 CLI bundle 不含已删除工具名。

# Provider 统一改造核实与交付报告

本次以本地代码为准复用现有 LLM、settings、credentials、Agent Loop 与工具系统，保留 DeepSeek 默认值，新增 GPT Responses Provider，并让网页搜索通过 Provider 能力执行。附件中的“S1–S8”与当前实现不一致：实际是六个阶段，本次未扩造阶段或修改标书业务规则。功能定向验证和后端构建通过；下文单独列出未完成的远端验证及仓库原有文档检查问题。

## 1. 修改前实际模型调用架构

模型抽象已经存在：`LlmRuntime` 注册 `LlmAdapter`，按 provider/model 分派请求；`DeepSeekAdapter` 负责聊天，`PiAiAdapter` 已有多协议支持。不存在需要重新创建的业务层 DeepSeekClient。主要缺口是搜索自己保存 DeepSeek 连接、模型页缺少直接编辑全局默认的入口，以及子 Agent 从过时创建选项继承模型。

| 核实入口 | 实际文件与调用关系 |
|---|---|
| 设置 → 模型 | `ui-settings-models/src/client/ModelsSection.tsx` → `ProviderEditor.tsx` / `store.ts` → API settings、credentials、llm |
| 设置 → 插件 → 网页搜索 | `ui-settings-plugins/src/client/WebSearchCard.tsx` → `web-search-card-controller.ts` → 现有 SettingsScope/CardForm |
| DeepSeek 配置 | `llm-deepseek` settings namespace；凭据由 `credentials-local` 按引用解析 |
| 普通对话 | `host/apiproxy/src/api-proxy.ts` → agents / agent-loop → request/header → `llm.prepareCall` / stream → adapter |
| 标书阶段 | `bid/bid/src/*executor.ts` 通过父 Agent followup 或 subagents 服务运行 |
| 工具注入 | tools 注册表 → Agent 请求组装 → `GenerateOptions.tools` → Provider 协议转换 → tool-call → 原工具执行 → tool-result |
| 搜索请求 | 原 `web-search-deepseek/src/provider.ts` 直接请求 Anthropic-compatible `/messages` |
| 配置写入 | 前端暂存编辑 → API `settings.mutate` / `credentials.set` → 后端 provider → 文件持久化与订阅更新 |

## 2. 修改后 Provider 架构

全局默认仍由 `agent-default-model` 管理；任务确定 provider/model 后经过现有 LLM 注册表调用。DeepSeek 的聊天与 hosted search 归于 `llm-deepseek`；GPT 由 `llm-pi-ai/gpt` 注册，复用 pi-ai 的 Responses 转换。WebSearch Plugin 只负责选择路由与控制搜索预算。CPA 是 GPT 的 Base URL，不是第三种 Provider。

```text
Models 页面 → settings / credentials
                       ↓
agent-default-model → 任务已确定的 provider/model → LlmRuntime
                                                    ├─ DeepSeekAdapter + DeepSeek hosted search
                                                    └─ GPTProvider（Responses）
Agent 的 web_search 工具 → 搜索策略 → LlmRuntime.webSearch → 同一 Provider
```

## 3. Provider 顶级接口定义

沿用 `LlmAdapter`、`GenerateOptions`、`StreamChunk`、消息与 replay 类型。连接地址和凭据在 Provider 内部解析；公开目录不返回 API Key。核心入口如下。

| 操作 | 实际接口 |
|---|---|
| 默认选择 | `ctx.agentDefaultModel.currentSelection()` |
| 已安装路由与目录 | `ctx.llm.listProviders()`、`listModels(provider)`、`listConfigurableProviders()` |
| 指定模型解析 | `ctx.llm.resolveModelInfo(provider, model)`、`prepareCall(...)` |
| 能力查询 | `ctx.llm.supports(provider, capability)`，能力为 `chat`、`tools`、`web_search` |
| 流式调用 | `ctx.llm.stream(options)` |
| 普通调用 | 新增 `ctx.llm.generate(options)`，复用 stream/BlockAssembler，返回 message、finish、可选 usage |
| hosted search | 新增 `registerWebSearch(provider, implementation)`、`webSearch(provider, request, options)` |

搜索注册随插件卸载释放。能力查询反映已安装实现，不进行远端付费探测。不支持的路由明确失败，没有新增跨 Provider fallback、评分、负载均衡或多模型编排。

## 4. DeepSeekProvider 复用了哪些原代码

保留 `DeepSeekAdapter` 的请求序列化、SSE、reasoning、函数工具、usage、请求准备、文件处理、重试和取消实现。原搜索 transport 与 Anthropic 类型移入 `llm-deepseek/src/search.ts`、`search-types.ts`；旧包出口转发到新所有者。搜索仍发送 `web_search_20250305`，继续解析结构化结果、citation snippet 与 URL 去重。

另外补充 HTTP 错误及损坏 JSON/SSE 诊断的实际密钥脱敏，保留可路由错误码。默认搜索复用聊天凭据，旧搜索专用 endpoint/model/key 可作为 Provider 内部兼容覆盖保留。

## 5. GPTProvider 调用链

基础组合安装 `@deepseek-ai/dsh-llm-pi-ai/gpt`，注册 `gpt` 路由与 `llm-gpt` 配置。`GPTProvider` 继承 `PiAiAdapter`，固定 `openai-responses` 和 SSE，复用 input、历史消息、function tools、工具回传、reasoning/replay、usage 与取消转换。

官方或兼容地址规范化后请求 `{baseURL}/responses`：例如 `https://gateway.example/proxy` 变为 `https://gateway.example/proxy/v1/responses`；已有 `/v1` 不重复添加。默认模型为可编辑的 `gpt-5.2`，最终型号必须由所用服务提供。404/405/501 明确报 `UNSUPPORTED_RESPONSES_API`；不会退回 DeepSeek。模型发现仍用现有 `/models` 流程，不支持发现的服务可以手工配置目录。

协议依据为 OpenAI 官方 [Web search](https://developers.openai.com/api/docs/guides/tools-web-search) 与 [Function calling](https://developers.openai.com/api/docs/guides/function-calling) 文档。真实 CPA 部署、账号权限、模型可用性和返回结果未用外部账号验证。

## 6. 默认 Provider 保存在哪里

继续使用 `$DSH_HOME/settings.yaml` 中的 `agent-default-model` namespace，字段为 `provider`、`model`、可选 `reasoningEffort`。基础组合默认 `deepseek-official` / `deepseek-v4-flash`。模型页一次 mutation 保存 provider/model 并清除上一模型的 reasoningEffort，使用 expectedRevision 防止覆盖并发修改。

Provider 设置分别属于 `llm-deepseek`、`llm-gpt`，搜索策略仍在历史 `web-search-deepseek` namespace。API Key 通过现有 credentials API 保存到 `$DSH_HOME/.credentials.yaml`；环境变量的既有优先级保持。GPT 默认凭据引用 `OPENAI_API_KEY`，DeepSeek 默认 `DEEPSEEK_API_KEY`。留空保存保留原 key，前端读取的是 configured/source/writable 等状态，不是明文。

已有运行记录的任务继续从 request/header 取得模型；新任务及未开始执行的空白会话使用新的全局默认。模型连接由每次请求准备过程捕获，正在发送的请求不会把旧凭据与新 endpoint 拼接使用。该保证不等于整段多轮会话永久冻结全部连接设置。

## 7. 前端 Provider 设置对应哪些文件

模型页在 `ModelsSection.tsx` 中接入 `DefaultProviderEditor.tsx`，复用原布局与保存 API；`ProviderEditor.tsx` 将 `llm-gpt` 映射到现有 Provider 编辑器，保留 Base URL、凭据引用、密码框和模型目录编辑。

插件页改动 `WebSearchCard.tsx`、`web-search-card-controller.ts`、`index.ts`、`locales.ts`，只展示搜索 Provider 与 maxUses。默认跟随本次任务；显式选项仅来自 active 且声明 web_search 的 Provider。已保存但当前不可用的选项以“不可用”展示，避免静默丢失配置。能力列表在连接重置或 adapter 更新后刷新。前端使用组件回归和 Client 类型检查验证，遵照指令未执行前端 build。

## 8. Web Search 原来如何绑定 DeepSeek

原搜索插件在自己的配置中持有 apiKey/apiKeyEnv/baseURL/model/apiVersion/maxTokens/maxUses，注册 `deepseek-official` 搜索后端，直接请求 DeepSeek Anthropic Messages。插件卡因此独立展示搜索密钥与地址，无法表达“主 Agent 已切换 GPT，搜索也跟随 GPT”。

## 9. Web Search 改造后的调用链

`web_search` → `ctx.web.search` → 历史包中的通用策略桥接 → 捕获父任务日志中的 Provider/model，或在 Agent 外读取全局默认 → `ctx.llm.webSearch` → Provider 自有 hosted-search transport → 统一 `WebSearchResult`。

用户显式选择另一个搜索 Provider 时，采用它模型目录的首项；连接仍来自该 Provider。保留历史包名、namespace 和 web 注册 ID，使旧组合仍能定位插件；实际请求路由由策略决定。缺少搜索能力或模型时明确失败。

## 10. 实际阶段中有哪些模型调用入口被统一

`packages/bid/bid/src/control-plane-contract.ts` 定义六阶段，没有 S7/S8。业务文件没有新增 Provider 判断，也未修改目录、章节、评分或 Evidence 的业务规则。

| 实际阶段 | 模型取得方式 |
|---|---|
| file_intake | 既有父 Agent / 文件工具流程，模型请求经过共同 Agent Loop |
| tender_analysis | 父 Agent followup；评分点提取、分析和修复使用同一任务模型 |
| outline_generation | 父 Agent followup；响应点、目录及蓝图审查使用同一任务模型 |
| evidence_mapping | 父级规划 + `subagents.startContinuable`；子任务继承父级已记录模型 |
| chapter_writing | 父级规划 + `subagents.start('spawn', ...)`；章节生成与 reviewer 共同继承 |
| docx_export | 既有导出流程，不新增独立模型入口；涉及的模型请求仍走父 Agent |

标题生成等后台请求原本已通过 LLM 注册表，并默认采用请求路由。已有显式部署覆盖继续有效。

## 11. SubAgent 如何继承 Provider

`subagent/src/child-agent.ts` 优先读取父会话最后的 request/header.config，缺少请求记录时才使用 parent.options；一次性 spawn/fork 共用此解析。`continuation.ts` 在异步创建前捕获选择，并把同一值写入可继续子 Agent 描述符，后续恢复不重新读取全局默认。

`subagent-dsh-sdk` 的独立进程也默认继承上述 Provider/model，并通过现有 JSON-RPC initialize 发送；显式 provider/model 覆盖必须成对配置。它仍是独立运行时：子组合须安装对应 Provider、配置自身凭据；不会自动转发父进程秘密。缺失 GPT 时明确失败。外部 Codex、Claude Code、ACP 产品后端保持各自协议与配置，不被伪装为本项目 GPTProvider。

## 12. hosted web_search 如何进入 search → fetch → evidence

GPT 辅助请求使用 `tools: [{type: 'web_search'}]`、`tool_choice: 'required'`、`include: ['web_search_call.action.sources']` 和搜索次数预算。适配器只从 search call sources 与 URL citation annotations 提取 HTTP(S) URL/title；拒绝没有 hosted search 调用、明确失败或未完成的返回，不把模型生成正文放入 content。

DeepSeek 继续使用原结构化 result blocks 和 citation 摘要。两者通过原 web 服务限制来源数，Agent 再调用 `web_fetch`。`evidence-mapping-executor.ts` 仍按实际 search/fetch 工具调用、抓取正文与本地 snapshot 建立可追溯来源；未放宽 `EVIDENCE_MAPPING_PARTIAL_WEB_EVIDENCE_INVALID` 的校验。真实 Loader/Agent 工具循环快照覆盖两种 Provider 的搜索→读取；既有 Evidence Mapping Agent Loop 回归通过。

## 13. 是否还存在绕过 Provider 的 DeepSeek 业务调用

核实的普通聊天及六阶段业务代码未发现直接请求 DeepSeek HTTP/SDK 的模型调用；它们使用既有 Agent/LLM 服务。DeepSeek transport 自身仍需知道 DeepSeek 协议，SDK 独立客户端保留向后兼容的初始化默认值和服务端显式 DeepSeek 启动路径；这些也通过 LLM 注册表调用，不是标书阶段的旁路。独立 SDK 子 Agent 已改为显式发送父任务选择，因此不会因 SDK 客户端默认值暗中切回 DeepSeek。

## 14. 是否还存在 Web Search 自己保存 Key 的重复配置

新搜索卡不读写 key、Base URL 或 model。首次搜索把旧 namespace 中的连接字段迁入 `llm-deepseek.search`，先写目标，再清除旧 user 层；Provider 已存在的值优先。旧的独立搜索账户允许保留，不要求重新输入 key，secret 字段在配置描述 API 中脱敏。

旧字段仍作为兼容迁移输入接受；静态组合文件不由程序自动改写，因此其中的旧 literal key 需部署方移除。迁移需要已注册 DeepSeek 配置和可写 settings；只读旧组合需手动移动字段。两个 namespace 之间没有事务，按可重试的先写后删处理。这些限制不能解释成已将所有历史磁盘文件清理完毕。

## 15. 测试、typecheck、build 结果

相关测试分批运行，最终覆盖 **17 个文件、468 项用例**；失败断言修正后只复测受影响文件或用例。包含 DeepSeek 原适配器、GPT Responses 解析、真实 Loader/HTTP 工具循环、Provider 独立配置与重启、一次性/可继续/SDK 子 Agent、停止任务、上游错误和损坏响应的 key 脱敏、Models/Plugins UI、API 能力目录及既有 Evidence Mapping。没有运行全仓单元测试或真实账号 e2e。

实际执行的主要验证命令如下；后续针对最后两处改动进行了同命令定向复测。

```sh
node node_modules/vitest/vitest.mjs run packages/llm/llm-deepseek/tests/adapter.spec.ts packages/llm/llm-pi-ai/tests/gpt.spec.ts packages/web/web-search-deepseek/tests packages/client/ui-settings-models/tests/default-provider.client.spec.tsx packages/client/ui-settings-models/tests/components.client.spec.tsx packages/client/ui-settings-models/tests/store.client.spec.ts packages/client/ui-settings-plugins/tests packages/bid/bid/tests/evidence-mapping-agent-loop.spec.ts packages/host/apiproxy/tests/api-proxy-config.spec.ts
node node_modules/vitest/vitest.mjs run packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts
node node_modules/typescript/bin/tsc -b tsconfig.host.json tsconfig.client.json
node --import tsx/esm scripts/run-oxlint.ts <本次修改的 TS/TSX 文件>
git diff --check
```

Host + Client 类型检查和定向 lint 通过。构建使用已安装 tsdown 的 `build({env:{DSH_BUILD_FACE:'host'}, filter:[...], logLevel:'warn'})`，按包名精确选择 `dsh-llm`、`dsh-llm-deepseek`、`dsh-llm-pi-ai`、`dsh-web`、`dsh-web-search-deepseek`、`dsh-subagent`、`dsh-host-apiproxy`、`dsh-subagent-dsh-sdk` 八个后端包。最后更新的 DeepSeek/Web 已重新构建。普通 Node 直接导入构建产物、加载 DeepSeek/GPT、查询三项能力并解析历史搜索出口的 smoke 通过。未执行前端 bundle/build，也未声称完整项目构建通过。

附加检查中，修改文件的导出 JSDoc 定向检查通过；全库导出检查存在未改动代码的缺项。`verify-cordis-config.ts` 被已有 `client-ui-bid` 缺少 tsconfig 源码映射阻塞。尝试只同步 LLM 页生成目录时，修复了本次类型移动引起的 Web 跨包引用，随后生成器被已有 `SessionPromptAdmissionRejection`、`SessionPromptAdmissionRequest` 未配置类型链接阻塞。因此 LLM 文档正文已更新，自动生成区尚未再生成；没有绕过该检查或运行完整 doc-sync。

`node --import tsx/esm scripts/verify-type-equiv.ts` 通过：394 个类型文档块与源码声明/JSDoc 一致。搜索类型移动后保留原字段文档，并更新 manifest 的源码位置。

依赖清单只增加已有 workspace 引用，最终锁文件没有新增第三方版本。验证早期一次 `pnpm exec` 意外触发依赖解析/安装流程；发现后，后续验证全部通过 `node` 直接调用已安装工具，没有继续运行依赖安装命令。

OpenAI/CPA 请求通过本地兼容 HTTP 服务验证协议与路由；未使用真实外部账号验证联网搜索、计费、权限或全标书真实模型运行。

## 16. 所有本次修改文件列表

下列清单包含代码、配置、测试、快照、文档和本报告；临时校验脚本已清理，忽略的编译输出不列入源码交付清单。

共 64 个文件。

- [.agents/notes/implemented/architecture/2026-09-03-unified-model-providers.md](D:/my_project/bid-harness/.agents/notes/implemented/architecture/2026-09-03-unified-model-providers.md)
- [.agents/notes/implemented/feature/2026-07-31-web-default-search.md](D:/my_project/bid-harness/.agents/notes/implemented/feature/2026-07-31-web-default-search.md)
- [.agents/notes/implemented/feature/2026-08-10-web-plugin-configuration.md](D:/my_project/bid-harness/.agents/notes/implemented/feature/2026-08-10-web-plugin-configuration.md)
- [docs/subsystems/llm-streaming.md](D:/my_project/bid-harness/docs/subsystems/llm-streaming.md)
- [docs/subsystems/web.md](D:/my_project/bid-harness/docs/subsystems/web.md)
- [examples/headless-agent/tests/fixtures/web/web-search-deepseek/cordis.yml](D:/my_project/bid-harness/examples/headless-agent/tests/fixtures/web/web-search-deepseek/cordis.yml)
- [examples/package.json](D:/my_project/bid-harness/examples/package.json)
- [packages/bundle/base/cordis.patch.yml](D:/my_project/bid-harness/packages/bundle/base/cordis.patch.yml)
- [packages/client/ui-settings-models/README.md](D:/my_project/bid-harness/packages/client/ui-settings-models/README.md)
- [packages/client/ui-settings-models/src/client/DefaultProviderEditor.tsx](D:/my_project/bid-harness/packages/client/ui-settings-models/src/client/DefaultProviderEditor.tsx)
- [packages/client/ui-settings-models/src/client/ModelsSection.tsx](D:/my_project/bid-harness/packages/client/ui-settings-models/src/client/ModelsSection.tsx)
- [packages/client/ui-settings-models/src/client/ProviderEditor.tsx](D:/my_project/bid-harness/packages/client/ui-settings-models/src/client/ProviderEditor.tsx)
- [packages/client/ui-settings-models/tests/default-provider.client.spec.tsx](D:/my_project/bid-harness/packages/client/ui-settings-models/tests/default-provider.client.spec.tsx)
- [packages/client/ui-settings-plugins/README.md](D:/my_project/bid-harness/packages/client/ui-settings-plugins/README.md)
- [packages/client/ui-settings-plugins/src/client/WebSearchCard.tsx](D:/my_project/bid-harness/packages/client/ui-settings-plugins/src/client/WebSearchCard.tsx)
- [packages/client/ui-settings-plugins/src/client/index.ts](D:/my_project/bid-harness/packages/client/ui-settings-plugins/src/client/index.ts)
- [packages/client/ui-settings-plugins/src/client/locales.ts](D:/my_project/bid-harness/packages/client/ui-settings-plugins/src/client/locales.ts)
- [packages/client/ui-settings-plugins/src/client/web-search-card-controller.ts](D:/my_project/bid-harness/packages/client/ui-settings-plugins/src/client/web-search-card-controller.ts)
- [packages/client/ui-settings-plugins/tests/apply.client.spec.ts](D:/my_project/bid-harness/packages/client/ui-settings-plugins/tests/apply.client.spec.ts)
- [packages/client/ui-settings-plugins/tests/section.client.spec.tsx](D:/my_project/bid-harness/packages/client/ui-settings-plugins/tests/section.client.spec.tsx)
- [packages/client/ui-settings-plugins/tests/stores.client.spec.ts](D:/my_project/bid-harness/packages/client/ui-settings-plugins/tests/stores.client.spec.ts)
- [packages/host/apiproxy/README.md](D:/my_project/bid-harness/packages/host/apiproxy/README.md)
- [packages/host/apiproxy/src/api-proxy.ts](D:/my_project/bid-harness/packages/host/apiproxy/src/api-proxy.ts)
- [packages/host/apiproxy/src/api/llm.schema.ts](D:/my_project/bid-harness/packages/host/apiproxy/src/api/llm.schema.ts)
- [packages/host/apiproxy/src/api/llm.ts](D:/my_project/bid-harness/packages/host/apiproxy/src/api/llm.ts)
- [packages/host/apiproxy/tests/api-proxy-config.spec.ts](D:/my_project/bid-harness/packages/host/apiproxy/tests/api-proxy-config.spec.ts)
- [packages/llm/llm-deepseek/README.md](D:/my_project/bid-harness/packages/llm/llm-deepseek/README.md)
- [packages/llm/llm-deepseek/src/adapter.ts](D:/my_project/bid-harness/packages/llm/llm-deepseek/src/adapter.ts)
- [packages/llm/llm-deepseek/src/index.ts](D:/my_project/bid-harness/packages/llm/llm-deepseek/src/index.ts)
- [packages/llm/llm-deepseek/src/search-types.ts](D:/my_project/bid-harness/packages/llm/llm-deepseek/src/search-types.ts)
- [packages/llm/llm-deepseek/src/search.ts](D:/my_project/bid-harness/packages/llm/llm-deepseek/src/search.ts)
- [packages/llm/llm-deepseek/tests/adapter.spec.ts](D:/my_project/bid-harness/packages/llm/llm-deepseek/tests/adapter.spec.ts)
- [packages/llm/llm-pi-ai/README.md](D:/my_project/bid-harness/packages/llm/llm-pi-ai/README.md)
- [packages/llm/llm-pi-ai/package.json](D:/my_project/bid-harness/packages/llm/llm-pi-ai/package.json)
- [packages/llm/llm-pi-ai/src/config.ts](D:/my_project/bid-harness/packages/llm/llm-pi-ai/src/config.ts)
- [packages/llm/llm-pi-ai/src/gpt.ts](D:/my_project/bid-harness/packages/llm/llm-pi-ai/src/gpt.ts)
- [packages/llm/llm-pi-ai/tests/gpt.spec.ts](D:/my_project/bid-harness/packages/llm/llm-pi-ai/tests/gpt.spec.ts)
- [packages/llm/llm-pi-ai/tsdown.config.ts](D:/my_project/bid-harness/packages/llm/llm-pi-ai/tsdown.config.ts)
- [packages/llm/llm/README.md](D:/my_project/bid-harness/packages/llm/llm/README.md)
- [packages/llm/llm/src/index.ts](D:/my_project/bid-harness/packages/llm/llm/src/index.ts)
- [packages/llm/llm/src/search.ts](D:/my_project/bid-harness/packages/llm/llm/src/search.ts)
- [packages/llm/llm/src/types.ts](D:/my_project/bid-harness/packages/llm/llm/src/types.ts)
- [packages/subagent/subagent-dsh-sdk/README.md](D:/my_project/bid-harness/packages/subagent/subagent-dsh-sdk/README.md)
- [packages/subagent/subagent-dsh-sdk/src/index.ts](D:/my_project/bid-harness/packages/subagent/subagent-dsh-sdk/src/index.ts)
- [packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts](D:/my_project/bid-harness/packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts)
- [packages/subagent/subagent/README.md](D:/my_project/bid-harness/packages/subagent/subagent/README.md)
- [packages/subagent/subagent/src/child-agent.ts](D:/my_project/bid-harness/packages/subagent/subagent/src/child-agent.ts)
- [packages/subagent/subagent/src/continuation.ts](D:/my_project/bid-harness/packages/subagent/subagent/src/continuation.ts)
- [packages/web/web-search-deepseek/README.md](D:/my_project/bid-harness/packages/web/web-search-deepseek/README.md)
- [packages/web/web-search-deepseek/package.json](D:/my_project/bid-harness/packages/web/web-search-deepseek/package.json)
- [packages/web/web-search-deepseek/src/index.ts](D:/my_project/bid-harness/packages/web/web-search-deepseek/src/index.ts)
- [packages/web/web-search-deepseek/src/provider.ts](D:/my_project/bid-harness/packages/web/web-search-deepseek/src/provider.ts)
- [packages/web/web-search-deepseek/src/types.ts](D:/my_project/bid-harness/packages/web/web-search-deepseek/src/types.ts)
- [packages/web/web-search-deepseek/tests/__snapshots__/provider-routing.spec.ts.snap](D:/my_project/bid-harness/packages/web/web-search-deepseek/tests/__snapshots__/provider-routing.spec.ts.snap)
- [packages/web/web-search-deepseek/tests/deepseek.spec.ts](D:/my_project/bid-harness/packages/web/web-search-deepseek/tests/deepseek.spec.ts)
- [packages/web/web-search-deepseek/tests/provider-routing.spec.ts](D:/my_project/bid-harness/packages/web/web-search-deepseek/tests/provider-routing.spec.ts)
- [packages/web/web-search-deepseek/tests/settings.spec.ts](D:/my_project/bid-harness/packages/web/web-search-deepseek/tests/settings.spec.ts)
- [packages/web/web-search-deepseek/tsconfig.json](D:/my_project/bid-harness/packages/web/web-search-deepseek/tsconfig.json)
- [packages/web/web/src/index.ts](D:/my_project/bid-harness/packages/web/web/src/index.ts)
- [packages/web/web/src/types.ts](D:/my_project/bid-harness/packages/web/web/src/types.ts)
- [pnpm-lock.yaml](D:/my_project/bid-harness/pnpm-lock.yaml)
- [provider-refactor-report.md](D:/my_project/bid-harness/provider-refactor-report.md)
- [scripts/type-equiv.manifest.json](D:/my_project/bid-harness/scripts/type-equiv.manifest.json)
- [tsconfig.base.json](D:/my_project/bid-harness/tsconfig.base.json)

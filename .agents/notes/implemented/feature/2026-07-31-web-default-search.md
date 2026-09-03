# Agent Note: Default Web search in shipped compositions

Status: implemented

English | [中文](2026-07-31-web-default-search.zh.md)

搜索连接与凭据由模型 Provider 管理，搜索卡只编辑 Provider 选择与预算；详见 [统一模型 Provider](../architecture/2026-09-03-unified-model-providers.md)。本文的默认工具启用、分层配置与显式保存决策继续适用。

## Problem

The harness had a complete Web capability family—provider registry, DeepSeek/Exa/Perplexity search providers, local fetch, stable model tools, and structured result presentation—but the shipped `dsh web` composition mounted none of it. The model could not discover current information unless a deployment supplied a custom overlay. Merely mounting the existing DeepSeek provider would not complete the WebUI path: the Models page stores `DEEPSEEK_API_KEY` through `ctx.credentials`, while the search provider froze only the process environment at plugin load, so a key entered or rotated in the running UI would not reach search.

## Decision

`packages/bundle/base/cordis.patch.yml` explicitly mounts `dsh-web` with `searchProvider: deepseek-official`, `dsh-web-search-deepseek`, and `dsh-tool-web` with `fetch: false` and `searchTimeoutMs: 60000`. It does not mount `dsh-web-fetch-http` or select a fetch provider. The shared base makes only `web_search` a default for TUI, browser, and headless sessions. The explicit search provider id keeps selection independent of registration order and leaves personal or `--config` overlays able to replace or disable the rows. The one-minute shipped budget covers an auxiliary DeepSeek Messages request plus server-side retrieval while leaving `dsh-tool-web`'s provider-neutral 30-second default unchanged for custom compositions.

DeepSeek Provider 的搜索默认复用聊天凭据引用，并在每次请求解析当前密钥；旧搜索专用覆盖归入 Provider。搜索工具的稳定注册不依赖异步凭据是否可用，缺少凭据时在操作中明确失败。

搜索采用 Provider 私有的 hosted-search 协议，DeepSeek 使用 Anthropic Messages。通用搜索桥接记录 `web/provider-search-llm-request`，包含端点、协议版本和实际请求体，不包含认证信息；旧 DeepSeek 搜索日志类型继续可读。

The default mount does not create a Web-specific permission policy. `web_search` executes outside the shell/filesystem sandbox and approval presets, following `dsh-tool-web`'s existing contract. It does not mount `web_fetch` or a local fetch provider, so the default does not grant model-selected arbitrary URL retrieval. The shipped `workspace-write` default governs file mutations only; a restricted-network product stance requires a `tools/pre-execute` policy or capability-specific network confinement rather than implying that filesystem access mode governs Web calls.

## Alternatives considered

**Mount only `dsh-tool-web`.** Rejected because stable schemas without registered providers would make every default call fail; enablement and backend availability are deliberately separate, but a shipped default must supply its intended implementations.

**Read `$DSH_HOME/.env` from `cordis.yml` or hoist it into `process.env`.** Rejected because the credential provider owns that document, environment values are read-only overrides, and hoisting would make stored keys unrotatable while bypassing the audited secret boundary.

**Freeze `process.env.DEEPSEEK_API_KEY` at provider load.** Rejected because the Web Models page writes through `ctx.credentials`; the product's documented first-run path must make the next operation work without a restart.

**Keep Web tools in `web.cordis.yml`.** Rejected because it preserves an unexplained tool-roster difference between TUI and Web/headless. The rows are not surface-specific, so `base.cordis.yml` is their one home; the [tool-roster decision](2026-07-31-even-out-shipped-tool-rosters.md) records the shared composition.

**Raise `dsh-tool-web`'s provider-neutral timeout.** Rejected because custom providers and deployments own different latency expectations; the shipped DeepSeek composition owns this deployment budget.

**Enable search and fetch together.** Rejected because default `web_fetch` would allow model-selected anonymous outbound HTTP(S) retrieval to arbitrary URLs. Search covers discovery; deployments that accept broader retrieval can opt into `dsh-web-fetch-http` and set `dsh-tool-web`'s `fetch` option to `true` in their overlay.

## Consequences

Native model requests on every shipped surface carry only the `web_search` schema and search-only prompt guidance; Web/headless Code Mode exposes the same search capability beneath `run_code`. The prompt tells the model to use returned snippets and never advertises the disabled `web_fetch` tool. Search adds a complete auxiliary model call and may use the native server tool multiple times; its exact secret-free request remains reconstructable from the initiating session log. The default offers search-result snippets and source metadata but no arbitrary page retrieval; deployments that need full-page fetch must opt in. The Web snapshot lane boots the shipped tree, drives a replayed `web_search` call through the real DeepSeek provider against a local Messages fixture, asserts the durable auxiliary request and structured result, and pins the settled browser presentation. The TUI/Web composition smokes pin the shared `web_search` roster and absence of `web_fetch`; the built composition dump pins the one-minute shipped search budget; provider tests pin missing, stored, and rotated credential behavior plus literal and ambient compatibility.

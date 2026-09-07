# AGENTS.md

DeepSeek Harness 基于仓库内固定版本的 Cordis，所有能力通过插件组合。修改 `packages/` 前阅读[架构说明](docs/architecture.md)及 [packages/AGENTS.md](packages/AGENTS.md)；生命周期、并发、子进程和清理工作先阅读[防御模式](docs/defensive-patterns.md)。

## 工作范围与沟通

- 项目检查、流程说明和交付信息统一使用中文，不创建或维护英文对照、翻译记录或双语配对。
- 非机械、非局部的小改动须在同一 PR 中附带 [Agent Note](.agents/notes/README.md#when-to-write-one)。归档记录冻结，不修改，也不作为当前规则依据。
- 修改说明文件时编辑真正的 `AGENTS.md`；根目录、`packages/` 和 `examples/` 的 `CLAUDE.md` 在 Git 中是指向它的符号链接。

<a id="pre-release-stance-foundation-over-blast-radius"></a>

## 首次发布前的兼容策略

首个正式标签发布时删除本节。当前无外部消费者，优先修正基础设计，不增加兼容垫片；重命名或重组时同步更新全部引用。后端拒绝旧磁盘格式；SQLite 的 `SCHEMA_VERSION` 单调递增，`dsh-session` 的 `SESSION_FORMAT_VERSION` 保持 `0`，不承诺兼容。

## 仓库入口

| 目录 | 用途与规则 |
|---|---|
| `packages/` | 插件工作区，分组与职责见 [packages/README.md](packages/README.md) |
| `examples/` | 可运行配置，遵守 [examples/AGENTS.md](examples/AGENTS.md) |
| `docs/`、`website/` | 文档及 VitePress 投影，遵守 [docs/AGENTS.md](docs/AGENTS.md) |
| `.agents/` | 工作流技能与 [Agent Notes](.agents/notes/README.md) |
| `scripts/` | 检查器与生成器；命令定义见 [package.json](package.json) |
| `python/`、`native/` | [Python SDK 与运行时](python/README.md)、[原生插件源码](native/README.md) |
| `vendor/` | 固定版本的 Cordis 源码；更新按 [vendor/README.md](vendor/README.md) 同步，重施或移除已记录的本地补丁，并运行 `pnpm run test` 和 `pnpm run build` |

<a id="commands"></a>

## 命令与依赖

使用 pnpm 工作区，Node 版本遵循 [package.json](package.json) 的 `engines`。常用命令如下；按改动选择，完整列表以脚本定义为准。

| 命令 | 用途 |
|---|---|
| `pnpm exec vitest run <测试文件>` | 定向单元与集成测试 |
| `pnpm run test:coverage` | 覆盖率报告；普通 `test` 不产生报告 |
| `pnpm run test:e2e` | 真实 API 测试，缺少密钥时跳过 |
| `pnpm run test:snapshot -- -t <名称>` | 无密钥 ACP/headless 回放 |
| `pnpm run typecheck`、`lint`、`duplication` | 类型、代码规范与重复代码检查 |
| `pnpm run build`、`hygiene` | 构建与包发布检查 |
| `pnpm run docs:build` | 文档站构建与链接检查 |
| `pnpm dsh --profile headless "任务"` | 从源码执行任务，需要 API 密钥 |

- 除非用户明确要求安装、升级或修复依赖，不得运行 `pnpm install`、重建 `node_modules` 或隐式安装。新增现有 workspace package 的直接引用时，只改必要的 manifest 和锁文件记录；本地依赖缺失或损坏时报告阻塞。
- 真实 API 测试与演示读取根 `.env` 中的 `DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`。不得提交凭证；密钥与回放录制规则见[测试说明](docs/testing.md)。
- 必需命令因 Agent 沙箱限制凭证、网络、IPC、文件监听或嵌套 `sandbox-exec` 而失败时，先凭失败证据以最小宿主权限原样重试，再判断项目或认证故障。不得借此绕过真实测试失败或被测产品沙箱。

<a id="run-relevant-checks-locally"></a>

## 验证与提交

- 推送前按 [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md) 选择检查，只报告实际运行的命令与结果。`gh stack sync` 发布后立即验证，通过前不得合并。
- 行为改动运行定向测试；模型或用户输出运行快照；文档运行对应检查；发布路径运行 build、hygiene 与构建产物 smoke；Provider 行为运行真实 API e2e。能力、生命周期及输出改动须同时规划单元、e2e 和快照覆盖，补齐所需测试支持。
- 不默认运行全仓检查，不因提交或推送重复已通过的检查。完整覆盖与平台矩阵由 CI 负责；仅在用户要求、诊断 CI 或无法拆分的全仓改动时完整复验。`check:windows-wine` 仅用于诊断已知 Windows 故障。
- `pnpm run doc-sync` 仅在用户明确要求完整文档检查时运行，不作为普通提交或推送前置步骤。
- 非平凡的模型或产品可见行为改动，在同一 PR 中通过真实可运行示例更新无密钥快照。包测试、仅 e2e 断言或纯 mock 不能替代应用会话回放；fixture 须可在 macOS/Linux 重放，修 fixture，不靠 normalizer 掩盖差异。
- 修改 agent-loop、会话生命周期或 `SessionEventMap` 时，同步更新 TypeScript 与 Python SDK 的预期输出；普通 `pnpm run test` 不覆盖这些验证。详见[快照触发条件](docs/testing.md#when-a-snapshot-test-is-required)。
- 测试描述实际行为；行为过时时同步更新测试，并在 PR 中说明原因。可机械验证的不变量须接入会执行的顶层检查，并证明改变的接受路径会拒绝非法输入；不全局关闭规则。
- 拆分独立改动，先修引入问题的 PR 再向后传播。可采用 merge-forward 或 rebase；重写仅使用 `--force-with-lease`，远端变化时停止；进行中的 merge-forward 先保留检查点再更新基线。见 [PR 历史规则](.agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.md)。
- PR 使用一个 `kind/*`、所有实质相关的 `area/*`；Issue 使用原生 Issue Type，遵守[分类规则](.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md)。

<a id="conventions"></a>

## 插件与运行时

- 新行为使用已有插件扩展点；修改 `agent-loop` 必须同步更新[架构说明](docs/architecture.md)。能力由服务定义、服务提供者、消费者共同构成，仅在各角色独立演进时拆包，见[能力定义](docs/glossary.md#capability-seam)。
- 所有注册通过 `ctx.effect()` 或 `ctx.on()` 管理，注册 API 返回 disposer。waterfall 监听器须调用 `next()` 委托后续处理；不调用即截断，见[waterfall 语义](docs/cordis-primer.md#cordis-waterfall-semantics)。
- 运行时不变量检查自己拥有的可变数据或权威事件关系，不检查服务或方法是否存在、插件元数据或固定纯函数示例。没有合理关系时，保留说明原因的空伴随模块，见 [packages/AGENTS.md](packages/AGENTS.md)。
- 模型可见内容必须能从会话日志重建，新增模型输入须有会话事件。事件使用声明合并与可扩展映射，JSDoc 记录 `@mode` 和 payload `@param`；作用域键不在 payload 中时声明 `@dshScopeScan unsupported`。
- `SessionEventMap` 的未知事件默认导致日志拒读，只有信封显式设置 `ignorable: true` 才可忽略；仅结构格式变化提升 `SESSION_FORMAT_VERSION`，见[会话版本机制](.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md)。
- 按判别标签处理联合类型：封闭联合以 `assertNever` 收尾，可合并扩展的联合使用说明原因的 default。
- 随部署变化的参数放入可由 `cordis.yml` 修改且经过验证的 `Config`；`DEFAULT_*` 或测试钩子不等于可配置。协议常量、外部规范和安全不变量保持固定。
- 默认值由所属实现的显式 `resolve(request): Spec` 步骤处理，不隐藏在 `run()` 内。自包含的配置错误在加载时失败，依赖其他资源的错误在最早可解析时失败，不静默跳过缺失引用。
- `cordis.yml` 仅插件 `config` 与条目 `disabled` 支持 `!!js`，不使用 `!js`；其他元数据保持字面值，条件组合使用 overlay。详见[配置说明](docs/cordis-primer.md#loader-configuration)。
- 工具设计同时确定 UI 呈现意图（`generic`、`terminal`、`diff` 和 `locations`）；呈现方法是 `args` 的纯函数，见[新增工具](docs/cookbook/adding-a-tool.md)。

## 包、类型与实现

- npm 包使用 `@deepseek-ai/dsh-<name>`；vendored 包按[映射](docs/rescope.md)重命名并设为 `private: true`。每个 harness 包声明 `@deepseek-ai/cordis` 为 peerDependency 和开发依赖。
- 全仓 ESM，跨包使用包名，包内相对导入使用 `.ts`。配置子进程由普通 Node 运行构建后的 `lib/`；源码回归使用声明的 launcher。`dsh` 源码入口使用 `node --import tsx/esm`，其可达模块不得只有 CJS 导出，不依赖未覆盖整个 engines 范围的 Node 原生 TypeScript 模式。见[启动规则](docs/testing.md#test-subprocess-launch-modes)。
- Raw/Web `cordis.yml` 的裸插件名必须出现在对应 resolver manifest 的 `dependencies` 中，由 `verify-cordis-config` 检查。
- 静态检查与源码测试通过 tsconfig `paths` 解析到 `src`，须可在干净源码树运行；依赖构建后 `lib/` 的检查显式声明构建依赖。除 `api/remotes` 外，每包使用一个聚合配置；全仓编译程序从对应 face 配置开始，不使用根 solution，见 [TypeScript 布局](docs/development.md#typescript-project-layout)。
- 保持 `strict: true` 和 `noImplicitAny`；残留 `any` 必须解释为何无法收窄。跨边界的不透明 ID 使用 `dsh-brand` 的 `Branded<B>`。
- 信任同进程静态类型，不为接口已保证的值添加防御校验、回退或恶意输入测试；在配置、解析、队列、模型工具 JSON、文件、持久化、worker、进程和网络输入处验证。
- 空 `catch` 说明吞掉哪种失败及为何没有其他错误可达，`try` 限于一个语句。并列值保持对称，避免无解释的分支差异。
- 维护良好的依赖若能实质删除自有代码与测试，优先于手写替代，见[依赖选择规则](.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md)；安装仍须遵守用户授权。
- 文件恰好保留一个末尾换行，提交前检查 `git diff --cached --check`。按[开发说明](docs/development.md)使用 `FIXME`、`TODO`、`XXX` 标记紧急程度。

## 文档与注释

- 代码改动同步更新受影响的 README 和 JSDoc。每个模块、导出的非显然约定应有简洁说明；函数型导出记录参数与非 void 返回值。继承成员、插件协议槽位和构造器的公共说明保留在声明它们的服务定义、协议或类，由 `verify-export-jsdoc` 检查。
- 描述当前行为、失败、时序、所有权和使用限制，不复述代码、控制流、测试步骤、评审历史或推理过程。术语使用具体对象名称；确需表示调用义务或真实进程、安全、事务、生命周期边界时才使用相应抽象词，详见 [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md)。
- 一项事实只有一个主要归属，每个段落占一个物理行；根规则保持简短，细节链接到所属文档。结构与字数预算遵守 [docs/AGENTS.md](docs/AGENTS.md)，只有必要内容确实需要空间时才说明理由并调整预算。

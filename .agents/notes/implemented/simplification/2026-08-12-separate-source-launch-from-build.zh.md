# Agent Note: 将源码启动与仓库构建分离

Status: implemented

[English](2026-08-12-separate-source-launch-from-build.md) | 中文

## 问题

TypeScript 源码启动器无需在每次调用前完成整个仓库的构建。Web 界面则需要已构建的前端与 Client plugin 产物。由同一个包脚本同时负责这两项操作，会让重复启动 TUI、无头模式和 Web 时都承担全仓库构建延迟，也会掩盖浏览器产物何时刷新。

经由 tsx 加载的源码模块与经由已构建组合包加载的浏览器模块具有不同的新鲜度表现。将两条命令分离后，需要明确产物生成的责任，并准确说明产物缺失与过期时的失败模式。

## 决策

根目录的 `dsh` 与 `bid:s4-replay` 脚本先运行 `build:lib:host`，再通过 `node --import tsx/esm` 启动源码入口。启动前的 Bid 工具名检查扫描 `packages/bid/bid/src`、`packages/bid/bid/lib` 和 `apps/cli/lib`，旧工具名或错误的 S4 工具过滤器会阻止进程启动。完整的 `pnpm run build` 仍负责前端与 Client 产物。

Typert Host 产物缺失时，profile 启动会因不含构建指引的模块解析错误而失败。这些 Host 产物存在后，如果前端或 Client plugin 产物缺失，启动会失败，诊断信息会指示用户运行 `pnpm run build`。启动器不会验证产物是否为最新：已有的陈旧前端或 Client plugin 组合包仍会被接受，并可能继续运行旧版浏览器代码，直至下次构建。各包的 Node 半侧至少构建过一次后，`pnpm run dev:web` 只重建声明了 `dsh.client` 的包；它会保持 Client plugin 组合包为最新状态并启用其热重载路径，但不会重建前端 shell。

本决策仅规定 Host 构建调度与 Bid 产物检查。[tsx ESM 源码启动决策](../architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md)规定 TypeScript 转换与 workspace 解析，[源码运行决策](2026-08-10-source-run-without-managed-installer.zh.md)规定以仓库脚本作为受支持的检出入口，[个人配置决策](../feature/2026-07-20-dsh-cli-personal-config.zh.md)规定机器级配置层。

## 考虑过的备选方案

**保持构建与启动完全分离。**这样可以减少重复启动的延迟，但修改 Host 源码后会把旧 `lib` 静默带入运行时，且恢复 S4 业务阶段不能重新加载已导入的插件。

**仅检查源码与产物的时间戳或提交哈希。**这样可以避免重复构建，但检查值必须覆盖全部 Host 依赖、生成文件和 bundle，容易与增量构建状态脱节；当前启动入口直接构建 Host，规则更短且失败更早。

**由 `pnpm dsh` 启动 Web 产物 watcher。**这样可保持 Client plugin 组合包为最新状态，却会让一次性启动器负责另一个长时间运行的进程。显式的 `pnpm run dev:web` 命令继续负责这套开发生命周期。

## 影响

- 每次 Bid Host 源码启动都会先完成 Host build；Host build 或 Bid 工具名检查失败时不会创建运行进程。
- `pnpm dsh` 的源码 CLI 与工作区包源码由 tsx paths 统一解析；需要消费发布视图的已构建入口仍按包 `exports` 加载 `lib`，两条路径都不能绕过启动前的 Host build。
- 已经运行的进程不会因 reset S4 而重新导入插件；修改 Host 源码后必须重启进程，reset 只重置业务阶段状态。
- TUI、Web 与无头模式选择、参数转发、环境继承，以及 tsx ESM 启动方式保持不变。
- Bid package README 与 CLI 参考记录当前工具名和 Host build 前置条件。

## 验证

`scripts/verify-bid-web-tool-name.ts` 拒绝 Bid src、lib、CLI bundle 中的已删除工具名，并固定 S4 Subagent 过滤器为 `web_search` 与 `web_fetch`。`apps/cli/tests/source-launch.compat.spec.ts` 固定源码启动方式；Bid executor 测试固定实际 `toolFilter.allow`。`packages/bundle/web-app/tests/web-app.spec.ts` 与 `packages/client/modules/tests/node-half.client.spec.ts` 继续固定产物缺失诊断。

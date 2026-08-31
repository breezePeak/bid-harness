# Agent Note: dev-web 构建浏览器外壳运行时包

Status: implemented

## Problem

`dev-web` 只监听客户端插件和客户端静态链接包，没有构建浏览器外壳直接导入的 Cordis 与 Loader。首次启动或产物不完整时，Vite 通过包的 `exports` 解析不到 `vendor/cordis/lib/index.js`，产生入口解析警告。

## Decision

`discoverLibraryDirs()` 将仓库中存在的 `vendor/cordis` 与 `vendor/loader` 纳入客户端监听列表。它们与客户端包一起由 tsdown 首次构建并在 `lib/types` 更新后重建，保证 Vite 启动前两个外壳运行时入口可解析。

## Alternatives considered

**要求开发者先运行完整构建。** 这仍会让删除或缺失产物的开发目录触发警告，也不能让 `dev-web` 自己覆盖外壳运行时包，因此未采用。

**在 Vite 中把 Cordis 别名到源码。** 这绕过了包的发布入口并使开发路径与产物路径不同，因此未采用。

## Consequences

`dev-web` 会额外维护两个小型运行时包的监听和构建，冷启动不再依赖它们已有 `lib/index.js`。其他 vendored 包仍由完整仓库构建负责，因为浏览器外壳不直接导入它们。

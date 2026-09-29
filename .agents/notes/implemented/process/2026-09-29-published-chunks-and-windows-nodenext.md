# Agent Note: 发布块闭包与 Windows NodeNext 链接

Status: implemented

## Problem

`dsh-llm-pi-ai` 的主入口与 `./gpt` 入口共享构建块；如果 `package.json#files` 只收录入口文件，发布包会缺少入口实际导入的 `gpt-*.js`。NodeNext 消费方检查为工作区包创建临时目录链接，在未启用符号链接权限的 Windows 主机上会于类型检查前因 `EPERM` 退出。

## Decision

`dsh-llm-pi-ai` 的发布清单同时收录两个入口及 `lib/gpt-*.js`，工作区约束检查要求同一文件集合。NodeNext 消费方检查在 Windows 使用目录 junction，在其他平台使用目录符号链接；两者都指向原工作区包，不复制声明文件。

## Alternatives considered

**只发布入口文件。** 共享块仍由入口相对导入，缺失时发布包无法加载。

**跳过 Windows 的 NodeNext 检查。** 这样会失去该平台对全部公开声明入口的消费方验证，且不会修复创建链接时的权限失败。

## Consequences

Publint 的发布闭包检查覆盖共享块，NodeNext 检查无需 Windows 符号链接权限即可编译工作区公开声明。新增独立构建块时，发布清单与工作区约束仍须同步更新。

# Agent Note: S5 补搜依据先研究后审核

Status: implemented

## Problem

Writer 在正文中实际使用的新资料如果在 Reviewer 完成后才进入 Evidence Map，Reviewer 审核的是旧 Evidence 和旧 Answer Plan。Writer 与 Reviewer attempt 共用可变输入身份时，完成提交还会把已经结束的 Reviewer 摘要改写成新值，使日志错误地声明审核曾使用新依据。

## Decision

Host 只接受 Writer 候选中实际使用且验证通过的资料身份，并与当前章节正式 mapping 去重。新增资料先写入当前章节 Evidence，清除旧 `answer_plan`，再以 `supplement`、单节范围和固定目录执行 `executeSectionResearch()`。Research 完成后从正式 Evidence Map 与 Web Ledger 重建 ChapterContext，Reviewer 才读取最终 Evidence、Answer Plan 和输入摘要。全节研究结果仍为真实 gap 时进入待输入状态。`finishChapter()` 只提交正文、metadata、审核和执行记录。

Writer attempt 保存启动时的依据摘要，Reviewer attempt 保存重研后的依据摘要；两者不共享可变对象。Validator 对最终 Reviewer 摘要与当前 Evidence 保持严格相等检查，Writer 的计划版本、章节 epoch 和强依赖身份仍须有效。Writer 的历史依据摘要不能与后续合法更新的 Evidence 强行比较；Reviewer 的当前摘要承担审核失效判断。

## Alternatives considered

**仅复制 attempt 输入对象。** 复制可防止日志被事后改写，但 Reviewer 仍会审核旧 Evidence，且最终摘要与正式材料不一致。

**由程序把 gap 改为 supported。** 新资料的真实支持范围需要研究判断；资料身份验证不能证明其语义内容。

## Consequences

Writer 补搜会增加一次单节 Research，Reviewer 的会话输入与最终 Evidence 对齐。同一资料已经进入正式 mapping 时不再触发 Research。若 Research 失败，Evidence 保留待研究状态，章节不会提交旧审核；真实 Loader 回放覆盖研究、审核顺序及最终产物。

# Agent Note: 流程图 Office 导出布局与嵌入收口

Status: implemented

## Problem

结构化流程图的 TB 同层布局使用节点高度计算横向位置，分支节点可能重叠；Visio 导出会新增空白页并固定 Letter 页面；Word OLE 替换没有保留返回的 InlineShape，也没有按正文版心缩放，导致正式导出无法稳定满足可编辑流程图的显示和位置要求。

## Decision

`layoutFlowchart()` 按方向分别使用 TB 的节点宽度和 LR 的节点高度计算同层间距，并按各层实际主方向尺寸累积层间距；`boxesOverlap()` 提供统一的正面积边界检查。Writer schema 要求流程图提供语义 `key`，Writer prompt 要求每张图在正文原位置插入唯一 `{{flowchart:<key>}}`，引用使用 `{{flow_ref:<key>}}`。

Windows Visio COM 使用新建文档已有的 `Page-1`，页面尺寸按布局边界加边距计算，不强制 Letter 尺寸；Word COM 在找到 marker 后折叠原位置，保存 `AddOLEObject()` 返回的 InlineShape，按当前 section 的可用正文宽度等比例缩小，并保持 `LinkToFile=false`。Windows 集成测试核验单页 VSDX、原生 Shape 与 Connector、OLE 顺序和版心宽度、删除外部 VSDX 后的嵌入独立性，以及激活后修改节点和移动节点时 Connector 的跟随行为。

## Alternatives considered

**在 S5 或 S6 退回 SVG/PNG。** 未采用，因为正式交付要求双击进入 Visio 并独立编辑节点和连接线，缺少 Office runtime 时必须明确失败。

**为每层保留固定的 150/240 像素主方向步长。** 未采用，因为长中文节点会超过固定步长；按实际边界累积间距只增加必要尺寸。

**继续新增 Visio 页面或把 OLE 插入到文档末尾。** 未采用，因为正文 marker 已提供唯一定位，且额外页面会使 Word 激活时显示空白页。

## Consequences

S5 仍只使用确定性 SVG 预览，不启动 Office；只有包含流程图的 S6 导出才需要 Word 和 Visio COM。流程图页面更紧凑，分支和长文本不会发生节点边界重叠，Word 中的 Visio 对象保持正文顺序并在删除外部 VSDX 后继续可编辑。没有 Word/Visio 的环境只能完成无流程图导出或 S5 预览，不能成功生成包含流程图的正式 DOCX。

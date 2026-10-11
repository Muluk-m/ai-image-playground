# ADR 0022：节点画布换成 React Flow，Konva 只留给图片编辑

状态：已接受（2026-10-11）。依据：[`video-platform-benchmark-2026-10-10.md`](../research/video-platform-benchmark-2026-10-10.md)。

## 背景

画布要升级为节点画布：图片、视频、文本、素材、分镜表、时间线都是节点，节点之间的有向连线就是引用，选中节点时生成输入框出现在节点正下方，图片与视频工作流共用这一块画布。现有画布是 Konva 一整块 `<canvas>`，与这个形态有三处根本错位：

- 箭头只存两端坐标，不绑定对象，拖动图片时不跟随；
- 工具条等 DOM 叠层靠手算坐标，拖动期间不跟随，doc 要到 dragEnd 才更新；
- 文字是 `Konva.Text` + textarea，不能承载富文本、分镜表这类结构化内容。

## 决定

- 节点画布用 [`@xyflow/react`](https://reactflow.dev)（React Flow v12）：节点是真实 DOM，自带有向边、端口、拖拽跟随、框选、点阵背景与小地图；视口默认无限平移缩放，不改变「无限画布」形态。
- 像素级编辑（局部重绘蒙版、手绘、在图上圈画改图）继续用 Konva，作为选中图片节点后进入的编辑层，不再是画布本身。
- 数据层不换：项目文档、云端同步、项目修订与乐观锁保留；节点、连线、分组作为新类型，前端模型与云端 `project-protocol` 一起扩展。

## 考虑过的方案

- **在 Konva 上扩展**：连线绑定、叠层跟随、富文本与表格都要自建，叠层同步正是现有薄弱点。否决。
- **两套画布并存**：图片与视频会被重新分到两个工作面，与「共用一块画布」冲突。否决。

## 竞品核实（2026-10-10，只读检查各家加载的前端代码，未登录、未生成）

| 平台 | 节点画布 | 像素编辑 | 证据 |
| --- | --- | --- | --- |
| 即梦 | React Flow v12 + Yjs | Konva（智能编辑、视频编辑的涂抹） | 画布子应用 `canvas-view.*.js` 含完整 `@xyflow` 与 `react-flow__*` 类名 |
| LibTV | React Flow v12 | — | CSS 自定义节点 `react-flow__node-image / -video / -audio / -video-clip` |
| TapNow | React Flow + 自研画布包 | Fabric.js | `vendor-pkg-canvas-*.js` 命中 `react-flow__node / __edge / __pane`，`vendor-libs-*.js` 含 React Flow 署名链接 `reactflow.dev?utm_source=attribution` |
| 可灵 | 自研 PixiJS + pixi-viewport（Vue 3） | — | 全部 chunk 无 React Flow |

四家中三家用 React Flow 做节点画布，即梦与 TapNow 也把像素编辑交给另一个库，与本决定的分层一致。

## 后果

- 画布渲染层重写：现有 `KonvaCanvas` 的对象渲染、选择、吸附、叠层改由 React Flow 承担；`rasterizeSelection` 把标注烧进参考图的行为移入图片编辑层。

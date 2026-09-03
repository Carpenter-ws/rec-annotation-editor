# REC Annotation Editor 设计规格

- 日期：2026-09-03
- 状态：设计已在对话中确认并完成自检，待用户书面规格确认
- 项目目录：`/mnt/data4T-Path/wangsen/drone/rec-annotation-editor`

## 1. 目标与优先级

本项目提供一个可实际用于低空场景 REC（Referring Expression Comprehension）数据检查和人工修正的本地 Web 标注编辑器。用户加载一张图片和一个逐行 TXT 标注文件后，可以查看、选择、新增、删除、移动、缩放和数值编辑 bounding box，也可以直接编辑每个框对应的任意文本 referring expression，并将结果导出为兼容 TXT 或结构化 JSON。

实现优先级固定为：

1. 原始图片坐标正确性；
2. annotation 数据完整性；
3. 编辑与历史功能；
4. 长时间使用时的界面清晰度。

标签不是类别枚举。任何非空字符串都是合法 label，两个 label 完全相同的 annotation 仍是两个独立目标。

## 2. 范围

### 2.1 必须实现

- 点击选择或拖放加载常见浏览器图片格式；
- 加载 `.txt` 标注并显示逐行解析错误；
- 以原图像素坐标保存 annotation，以同一个变换绘制图片和 SVG 标注层；
- Fit、缩放、以指针为锚点的滚轮缩放、拖拽平移；
- bbox 与右侧 annotation card 双向选择和定位；
- 任意文本 expression 编辑；
- bbox 四个坐标的数值编辑；
- 画框新增 annotation，并在确认对话框中填写 expression；
- bbox 拖动和八方向 resize；
- 删除、Undo、Redo 和规定的键盘快捷键；
- 搜索 expression，显示图片尺寸、标注数量、选中状态和 zoom；
- TXT 保存/另存为，以及 TXT、JSON 导出；
- 清晰处理越界框、无效框、空 label、坏文件和浏览器能力差异；
- 附带合成测试图片及含重复标签、空格表达式和大量框的 TXT fixture；
- 一条命令 `./start.sh` 启动。

### 2.2 本版本不实现

- 固定类别、类别下拉框、基于 label 的去重或配色逻辑；
- 服务器数据库、用户账号、多人协作或云端同步；
- 多图片目录批处理、数据集级任务分配；
- polygon、mask、keypoint 等非矩形标注；
- 多选与批量编辑。多选属于后续可扩展项，不进入首版验收。

## 3. 技术方案选择

采用 React、TypeScript、Vite 和 SVG overlay，样式使用项目内普通 CSS。应用完全运行在浏览器端，不上传用户图片或标注。

对比过的方案：

- **SVG overlay（采用）**：框、标签、命中区域和八个 handle 都是可测试的 DOM 节点，选中与无障碍状态直观；几十到数百个矩形具有足够性能；坐标变换可集中处理。
- Canvas/Konva：适合数千到数万图元，但命中测试、文本、handle 和组件测试更复杂，并引入不必要的运行时依赖。
- 原生 JavaScript 单文件：依赖最少，但双向状态、Undo/Redo 和复杂 pointer 事务难以维护。

不引入后端，也不创建 Conda 环境。所有 npm 依赖安装在本项目的 `node_modules`，npm cache 固定在本项目 `.npm-cache`，不修改 base 环境或全局 npm 包。

## 4. 模块边界

```text
src/
├── app/                 应用壳、快捷键、文件会话和整体布局
├── components/
│   ├── toolbar/         打开、保存、导出、历史和模式按钮
│   ├── viewport/        图片、SVG overlay、pointer 交互、zoom/pan
│   ├── annotations/     搜索、列表、卡片和字段编辑
│   ├── dialogs/         新建 annotation 与错误报告
│   └── statusbar/       图片尺寸、数量、选中项和缩放信息
├── domain/
│   ├── annotations.ts   数据类型、bbox 校验/clamp、ID 生成
│   ├── coordinates.ts   fit、正向/逆向坐标变换、zoom anchor
│   ├── parser.ts        TXT 解析与错误模型
│   ├── serializer.ts    TXT/JSON 序列化
│   └── history.ts       可撤销文档事务
├── state/               reducer、action 和 selector
├── styles/              设计 token 与响应式样式
└── test/                测试辅助工具
```

领域函数保持无 UI 依赖，以便单元测试精确验证。Viewport 只通过 action 修改 annotation，不自行保存第二份 bbox 状态。右栏输入框也调用相同 action，因此画布、全局 state 和数值输入不存在多份事实来源。

## 5. 数据模型

```ts
interface BBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Annotation {
  id: string;
  bbox: BBox;
  label: string;
  reservedField: "0" | null;
}

interface ImageInfo {
  name: string;
  width: number;
  height: number;
  url: string;
}

interface AnnotationDocument {
  image: ImageInfo | null;
  labelFileName: string | null;
  annotations: Annotation[];
}
```

`id` 由编辑会话生成，不根据 label 或 bbox 推导；导入顺序稳定生成 `ann_001`、`ann_002` 等可读 ID，新建项使用下一个未占用序号。JSON 导出保留 ID。TXT 本身没有 ID，因此重新导入 TXT 会基于文件顺序生成新的会话 ID。

`reservedField` 明确保留当前格式的尾部 `0`；无保留字段的输入为 `null`，新建项默认为 `"0"`。编辑状态保存全精度 JavaScript number；UI 和 TXT 输出采用两位小数，避免浮点噪声并兼容当前数据格式。

## 6. TXT 解析与导出规则

解析逐行、原子执行：只忽略纯空行；若任何非空行失败，则整个新文件不替换当前文档，并展示所有可定位的错误。

每行的解析规则为：

1. 使用严格数值语法读取开头四个有限数值 `x1 y1 x2 y2`；
2. 剩余文本去除首尾空白，但保留 label 内部文字和空格；
3. 若剩余文本以独立 token `0` 结尾，且其前面仍有非空文本，则该 `0` 记为保留字段，之前的完整文本记为 label；
4. 否则全部剩余文本记为 label，`reservedField` 为 `null`；
5. label 为空、坐标非有限数值或 `x2 <= x1` / `y2 <= y1` 都报告带行号的错误；
6. 图片已加载时，导入 bbox 会 clamp 到图片边界；clamp 后无效则报告错误。图片尚未加载时暂存合法 bbox，图片加载后再做一次原子边界校验。

TXT 的“无保留字段 label 恰好以独立 `0` 结尾”与“带保留字段”在语法上不可区分。本编辑器遵循现有格式约定，把最后的独立 `0` 当作保留字段；需要无歧义表达此类 label 时使用 JSON。

TXT 导出格式为：

```text
x1 y1 x2 y2 label 0
```

所有坐标输出两位小数。即使输入行没有保留字段，导出也补齐规范保留字段 `0`。JSON 导出包含图片文件名、原始尺寸以及每项的 `id`、`bbox`、`label` 和 `reservedField`。

## 7. 坐标系统与 Viewport

Annotation state 永远存原始图片像素坐标。Viewport 只维护：

```ts
interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}
```

正向和逆向变换为：

```text
viewportX = imageX * scale + offsetX
viewportY = imageY * scale + offsetY

imageX = (viewportX - offsetX) / scale
imageY = (viewportY - offsetY) / scale
```

浏览器 pointer 坐标先减去 viewport 的 `getBoundingClientRect()` 左上角，再应用逆变换。图片与 bbox 放在同一个 SVG transform group 中，确保缩放、平移或窗口变化时不会彼此漂移。描边使用 non-scaling stroke，handle 尺寸按 `1 / scale` 补偿，从而在不同 zoom 下保持可操作大小。

`Fit` 使用可用 viewport 尺寸计算 `min(viewportWidth / imageWidth, viewportHeight / imageHeight)` 并居中。ResizeObserver 监听工作区尺寸；只有处于 Fit 模式时窗口变化才重新 fit，自定义 zoom/pan 不会被意外重置。滚轮缩放以光标下的原图点为锚，缩放范围为 5%–3200%。空格+左键或中键拖动执行 pan，普通左键保留给选择、画框和编辑。

## 8. 编辑交互

### 8.1 加载与选择

图片和 TXT 可分别打开，也可拖放到 workspace。图片显示文件名和原始尺寸。单击 bbox 选中它、高亮框和 card，并将 card 滚入视图；单击 card 选中 bbox，并在 bbox 不完全可见时平滑居中。相同 label 不影响映射，每次映射只依赖 annotation ID。

### 8.2 模式

编辑器具有 Select/Pan 与 Add Box 两种显式主模式。`+ Add Box` 进入画框状态；pointer down、move、up 产生原图坐标 bbox。小于 3 个屏幕像素的拖动视为误操作。合法新框弹出 modal，expression 非空后提交；Cancel 或 Esc 丢弃草稿。

### 8.3 移动与 resize

选中框显示四角与四边共八个 handle。拖动框体移动，拖动 handle resize。每次 pointer move 都将逆变换后的 bbox clamp 到图像边界，并保证最小原图尺寸 1×1 px。交互使用 pointer capture，防止鼠标移出框后丢失事务。

### 8.4 文本与数值编辑

Expression 输入在键入时立即更新画面标签，但从 focus 到 blur/Enter 合并为一个历史事务；空值不提交并显示行内错误。四个数值输入允许临时文本状态，blur/Enter 时一次性解析、clamp 和验证，合法值写回统一 state，非法值恢复最近合法值并提示原因。画布拖动时输入框实时显示当前坐标。

### 8.5 删除与快捷键

- `Delete` / `Backspace`：输入框之外删除当前 annotation；
- `Ctrl/Cmd + Z`：Undo；
- `Ctrl/Cmd + Shift + Z` 和 `Ctrl/Cmd + Y`：Redo；
- `Ctrl/Cmd + S`：保存 TXT，并阻止浏览器默认保存网页；
- `Esc`：取消画框、拖动草稿或 modal。

快捷键检测输入焦点，避免用户编辑文字时误删 annotation。

## 9. 历史与脏状态

历史记录保存文档中可编辑 annotation 的快照，最大 100 个事务。新增、删除、一次完整拖动、一次完整 resize、一次 expression 编辑和一次 bbox 数值提交各占一个事务。选择、搜索、zoom、pan 和 panel 滚动不进入历史。

载入新标注文件会重置历史。成功保存后记录当前文档指纹为 clean；后续内容变化显示未保存标记。关闭或重新加载带未保存修改的页面时使用浏览器 `beforeunload` 提示。

## 10. 文件保存语义

- **Save**：若通过支持 File System Access API 的浏览器取得了 TXT 文件句柄，则请求权限并写回该文件；否则下载 `<原文件名>-edited.txt`。
- **Save As**：支持 `showSaveFilePicker` 时由用户选择目标；其他浏览器走下载 fallback。
- **Export**：菜单显式提供 TXT 和 JSON，两者都可下载。

所有写文件动作都由明确的用户点击或快捷键触发。取消系统文件选择器不是错误，不改变文档或 clean 状态。对象 URL 在替换图片和卸载应用时释放。

## 11. 页面设计

页面占满浏览器可用高度，使用深石墨色工作区、浅色固定右栏和低饱和青色主强调色。布局包括：

1. 顶部工具栏：品牌、文件名、未保存状态、Open Image、Open Label、Save、Save As、Export、Undo、Redo、Add Box；
2. 中央工作区：图片/SVG、空状态、拖放反馈、缩放控件；
3. 右侧 380 px annotation panel：搜索、统计和独立滚动 card 列表；
4. 底部状态栏：图片尺寸、annotation 总数、当前 ID、zoom 和操作提示。

选中 bbox 使用高对比实线、半透明填充和可见 handle；未选框使用稳定但较弱的颜色。标签以 annotation 序号加 expression 显示，长文本截断但 hover/选中可查看完整内容。窄屏保留主要画布，右栏变成可展开抽屉；首版以桌面浏览器和鼠标/触控板标注为主要目标。

## 12. 错误处理

- TXT 错误对话框显示总数以及 `Line N: 原因`，不以部分成功替换当前数据；
- 图片解码失败显示明确文件名和原因；
- bbox 越界自动 clamp，并以非阻塞通知告知调整数量；
- clamp 后无效、非有限数字、空 label 均禁止提交；
- 浏览器不支持文件句柄 API 时无声切换到标准下载，并在按钮提示中说明行为；
- 未加载图片时可解析并列出 annotation，但禁用画框与可视 bbox 编辑；
- 意外组件错误由顶层 error boundary 显示恢复界面，不显示空白页。

## 13. 性能与可用性

面向几十到数百个 annotation：annotation card 使用 memoized component，搜索和派生统计使用 selector/memo，pointer move 只更新当前 bbox。SVG 元素用稳定 ID 作为 key。大规模压力 fixture 至少包含 500 个 bbox，用于确认选择、缩放和列表搜索仍可交互；首版不引入虚拟列表，只有实际测得卡顿时再增加。

交互按钮有文字或 `aria-label`，焦点轮廓清晰。错误不只依赖颜色表示。表单 label 与控件显式关联，modal 支持焦点锁定和 Escape。

## 14. 隔离安装与启动

项目提交 `package-lock.json` 和可执行 `start.sh`。启动脚本：

1. 定位到脚本所在项目目录，不依赖调用时的当前目录；
2. 将 npm cache 设置为项目内 `.npm-cache`；
3. 若依赖缺失或 lockfile 指纹变化，运行 `npm ci`；
4. 启动 Vite，默认监听 `0.0.0.0:5173`；
5. 将实际访问地址打印到终端。

用户只需运行：

```bash
cd /mnt/data4T-Path/wangsen/drone/rec-annotation-editor
./start.sh
```

`node_modules`、`.npm-cache`、构建产物和测试产物加入 `.gitignore`。脚本不调用 `sudo`，不安装全局包，不读取或修改 Conda/base 环境。

## 15. 测试策略

### 15.1 单元测试

- TXT：单 token label、含空格 label、有/无保留字段、重复 label、长 expression、空行、坏数字、无效 bbox、聚合行号错误；
- 序列化：两位小数、尾部 `0`、特殊空格、JSON 元数据和 TXT round trip；
- 坐标：原图↔viewport 往返、Fit、cursor-anchor zoom、pan、不同 DPR 与容器偏移；
- bbox：clamp、move、八方向 resize 和最小尺寸；
- history：新增、删除、文本、数值、拖动事务以及 redo 分支失效；
- reducer：重复 label 保持独立 ID，选择不会修改文档。

### 15.2 组件与浏览器测试

- 加载 1920×1080 fixture 图片和 TXT 后数量、ID、文本、bbox 一致；
- 点击 bbox/card 双向定位；
- 修改 expression 和坐标后画布/输入双向同步；
- 新增、删除、移动、resize 后 Undo/Redo；
- 在 Fit、自定义 zoom/pan 和窗口 resize 前后，读取到的原图 bbox 不漂移；
- TXT/JSON 导出内容与当前 state 一致；
- 500 框 fixture 的选择、搜索和 zoom smoke test；
- production build 成功，`start.sh` 从干净依赖状态可启动并返回页面。

测试工具采用 Vitest、React Testing Library 和 Playwright。浏览器二进制仅安装到项目本地配置的缓存目录；若环境已有兼容 Chromium，则优先复用，避免系统级安装。

## 16. 验收标准

1. `./start.sh` 可一条命令启动，且不污染 base/Conda 或全局 npm；
2. 示例 TXT 的所有行正确解析，相同 label 不合并；
3. 任意 zoom、pan 和窗口尺寸下，内部 bbox 始终是原图坐标；
4. bbox 与 card 选择、expression 和数值输入均双向同步；
5. 新增、删除、移动和八方向 resize 可用且边界安全；
6. 所有规定编辑操作均可 Undo/Redo；
7. Save/Save As/Export 在支持与不支持 File System Access API 的浏览器中都有可用路径；
8. 空 label、无效 bbox 和坏 TXT 不会破坏当前文档；
9. TXT 可重新导入，JSON 保留 ID 和完整元数据；
10. 单元测试、交互测试和 production build 全部通过。

## 17. 已知权衡

- TXT 末尾独立 `0` 的含义存在格式固有歧义，使用明确兼容约定并以 JSON 提供无歧义格式；
- 浏览器只有在 File System Access API 可用且获得授权时才能直接覆盖原文件，否则 Save 必须表现为下载；
- SVG 优先可维护性与交互正确性，若未来单图达到数万框，再评估 Canvas 或分层渲染；
- 首版不做数据集目录管理，以确保单图片编辑链路的坐标与数据正确性先达到可用标准。

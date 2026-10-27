# 文石（Onyx BOOX）Android 墨水屏设备原生阅读 App 设计规范

> \\\*\\\*Design Specification for Native Android E-Ink Reader on Onyx BOOX Devices\\\*\\\*
>
> \\\*基于对开源项目 \\\[Pagewise (知页阅读器)](https://github.com/shawnshi/Pagewise) 的架构解构与墨水屏特异性重构\\\*

## 目录

1. [项目背景与 Pagewise 架构解构分析](#1-项目背景与-pagewise-架构解构分析)

   * 1.1 Pagewise 的定位与核心创新亮点
   * 1.2 混合架构在墨水屏上的物理瓶颈与妥协
   * 1.3 从“混合架构”走向“纯原生”的必然演进路线
2. [设计哲学与墨水屏人机工学原则](#2-设计哲学与墨水屏人机工学原则)

   * 2.1 零功能冗余动效（Zero Non-Functional Motion）
   * 2.2 瞬态交互与确定性反馈（Deterministic Response）
   * 2.3 物理按键优先与盲操友好（Hardware-First Navigation）
   * 2.4 静态感知与低刺激界面（Low-Stimulus Aesthetics）
3. [视觉表现与排版标定系统](#3-视觉表现与排版标定系统)

   * 3.1 16 级墨水屏灰阶语义色板（E-Ink Monochromatic Palette）
   * 3.2 物理尺度标定体系（Physical Metric Calibration）
   * 3.3 中英混排正文字体与微观版式规范
   * 3.4 图像与混排图表的动态抖动（Dithering）处理
4. [文石 EPD 刷新引擎与硬件调度规范](#4-文石-epd-刷新引擎与硬件调度规范)

   * 4.1 BOOX 刷新模式矩阵与场景映射
   * 4.2 脏矩形（Dirty Rect）局部刷新调度器
   * 4.3 全局刷新（Full Refresh / Regal Flush）节流机制
   * 4.4 双色温前光与待机状态机管理
5. [低延迟手写与双层批注引擎规范](#5-低延迟手写与双层批注引擎规范)

   * 5.1 BOOX 原生硬件笔迹层与 Android 向量层双轨架构
   * 5.2 笔刷模型、压感曲线与防误触（Palm Rejection）
   * 5.3 翻页/缩放时的笔迹光栅化（Bake）与坐标矩阵映射
   * 5.4 批注持久化与跨格式导出（PDF Annotation / EPUB CFI）
6. [原生排版引擎与渲染管线架构](#6-原生排版引擎与渲染管线架构)

   * 6.1 原生排版管线选型与分层
   * 6.2 EPUB/MOBI/TXT 重排版与原生 CFI 锚定机制
   * 6.3 PDF 瓦片化渲染（Tile-based Rendering）与内存池设计
7. [AI 伴读与语音朗读交互适配规范](#7-ai-伴读与语音朗读交互适配规范)

   * 7.1 流式生成内容（Token Streaming）的墨水屏聚合缓冲
   * 7.2 伴读卡片分屏与画中画布局
   * 7.3 TTS 语音朗读与视觉跳行高亮同步
8. [性能基准、兼容性与工程实施指导](#8-性能基准兼容性与工程实施指导)

   * 8.1 核心性能与功耗红线（SLA）
   * 8.2 文石全系设备分级适配策略（从 6 英寸到 13.3 英寸）
   * 8.3 项目工程模块依赖与 SDK 集成蓝图

## 1\. 项目背景与 Pagewise 架构解构分析

### 1.1 Pagewise 的定位与核心创新亮点

[Pagewise (知页阅读器)](https://github.com/shawnshi/Pagewise) 是专门面向文石（Onyx BOOX）等 Android 电子纸设备的本地阅读应用。在其架构迭代（如 v1.5.0）中，展现了多项极具行业价值的探索：

1. **物理尺寸标定排版理念（Physical Scale Calibration）：** 突破传统 App 粗放的 CSS 像素（`px`）或系统 `sp`，通过屏幕实际物理点距测量换算出毫米（mm）与印刷磅值（pt），实现了真实纸书级的阅读版心与行距设定。
2. **多源 AI 伴读与结构化知识切片：** 深度集成了 DeepSeek、OpenAI、Gemini 等大模型，支持章节摘要、即时问答、速读跳读与结构化大纲生成，为沉浸式深度阅读注入了现代认知工具。
3. **从 Web 走向原生的探索实践：** 开发者在 v1.5.0 中深刻意识到 WebView 在复杂交互列表中的迟滞，果断将书架、书籍详情、全部笔记、阅读统计、设置等 7 个关键管理页面重构为 **Android 原生 Kotlin Views**，大幅改善了墨水屏上的界面加载与触控跟手性。

### 1.2 混合架构在墨水屏上的物理瓶颈与妥协

尽管 Pagewise 作出了开创性努力，但其“**Vue 3 + Tauri 2 (Rust) + Kotlin 原生 + SQLite**”的四层跨平台混合架构，在墨水屏物理特性约束下依然面临着不可调和的底层矛盾：

|架构维度|Pagewise 混合架构现状|墨水屏物理特性的真实冲突|
|-|-|-|
|**渲染管线**|核心阅读仍依赖 WebView（基于 `foliate-js` 与 MuPDF Wasm）|Chromium 渲染管线强制进行 60fps 帧调度、分层合成与平滑滚动插值，与双稳态墨水屏（低刷新率、微秒级电泳响应）天然相悖，极易触发非预期的细微脏区域重绘，产生严重残影与频闪。|
|**手写批注**|通过 `OnyxInkLayer.vue` 与 Native 桥接模拟手写|墨水屏书写要求笔尖延迟低于 25ms。WebView 内部无法直接将笔迹打入硬件 FrameBuffer，跨进程 IPC 与 DOM 事件分发导致笔尖严重滞后，缩放/重排后手写坐标极易漂移。|
|**内存与功耗**|WebView 运行环境 + Rust Tauri 容器 + JVM 原生运行时|运行时基线内存常驻 220MB\~380MB。文石中低端设备（如 2GB/3GB RAM 的 Poke 或 Leaf 系列）在处理数百兆大 PDF 或多章节 EPUB 时，频繁触发 GC 乃至系统杀后台。|
|**硬件调度**|通过反射机制（Reflection Bridge）调用部分 BOOX API|缺乏对 BOOX 专有硬件刷新周期（`EpdController.waitForUpdateFinished`）的精准状态机闭环控制，易发生高品质 Regal 刷新与快速渲染帧冲突的丢帧现象。|

### 1.3 从“混合架构”走向“纯原生”的必然演进路线

在墨水屏设备上，**原生即体验，原生即续航**。 本规范以 Pagewise 的排版哲学、AI 伴读与本地隐私优先原则为灵魂，彻底摈弃 WebView 渲染外壳，构建一套**基于纯 Kotlin + Jetpack/Native Canvas/NDK + 文石 EPD 官方 SDK** 的原生阅读 App 架构与设计规范。

## 2\. 设计哲学与墨水屏人机工学原则

### 2.1 零功能冗余动效（Zero Non-Functional Motion）

* **禁用所有连续平滑过渡：** 严格剔除一切与信息传递无关的贝塞尔曲线动画、展开折叠动效、淡入淡出（Crossfade）以及列表惯性平滑滚动。
* **瞬时页面裁切（Hard Instant Cut）：** 界面切换必须采用“即点即呈”的硬切换逻辑，视图状态变换耗时应压缩在 0ms 逻辑帧，将所有时间留给墨水屏电泳颗粒的物理偏转。
* **严禁骨架屏闪烁：** 不得使用 Web 端常见的 Skeleton 骨架屏流光扫描动画；数据加载期间仅展示静态高对比度轮廓占位符。

### 2.2 瞬态交互与确定性反馈（Deterministic Response）

* **即时轻触反馈：** 用户点击按钮时，立即局部反相（黑白颠倒）或绘制单像素边框予以确认，严禁采用半透明涟漪（Material Ripple）效果，避免在黑白屏上形成灰度脏斑。
* **确定性状态驻留：** 墨水屏没有液晶屏的“悬停（Hover）”或微动状态，交互控件必须非黑即白，具备明确的不可逆触发语义。

### 2.3 物理按键优先与盲操友好（Hardware-First Navigation）

* 文石全系设备普遍配备实体翻页按键（如 Page 系列侧边实体按键、磁吸保护套按键、手柄配件）。
* 系统全局核心路径（上一页/下一页/章节跳转/书签标记）必须实现 **100% 硬件键映射**，确保用户单手握持时无需将手指移动至屏幕遮挡阅读视线。

### 2.4 静态感知与低刺激界面（Low-Stimulus Aesthetics）

* 墨水屏的本质是模拟纸张。UI 设计应退居幕后，非阅读元素（顶部状态栏、底部页码、控制菜单）在阅读状态下应彻底隐匿，唤醒时采用悬浮单色卡片，点击即走。

## 3\. 视觉表现与排版标定系统

### 3.1 16 级墨水屏灰阶语义色板（E-Ink Monochromatic Palette）

E-ink 屏幕通常具备 16 级物理灰阶。原生 UI 严禁使用彩色或微弱的浅色阴影，必须采用阶梯分明的灰度语义系统：

|语义角色|颜色值 (HEX)|物理对应|使用场景|
|-|-|-|-|
|**Background (画布底色)**|`#FFFFFF`|电子墨水纯白粒子|阅读背景、弹窗底色、卡片背景|
|**Surface Pure (纯色表面)**|`#FAFAFA`|极浅灰|分割卡片、高亮选块背景|
|**Border / Divider (轮廓线)**|`#000000` / `#D4D4D4`|纯黑 1px / 浅灰 1px|弹窗边框、列表分割线（禁用软阴影）|
|**Text Primary (主要文字)**|`#000000`|纯黑粒子全聚集|正文、核心标题、激活状态图标|
|**Text Secondary (次要文字)**|`#4A4A4A`|4 级深灰|作者信息、出版日期、页码、辅助提示|
|**Text Disabled (禁用文字)**|`#8C8C8C`|8 级中灰|禁用按钮、未解锁功能标签|
|**Annotation Highlight**|`#DCDCDC` (浅灰块) 或 下划线/波浪线|特殊纹理/灰度|正文划线批注、搜索命中关键词|

### 3.2 物理尺度标定体系（Physical Metric Calibration）

继承并升华 Pagewise 的物理校准思想，通过屏幕物理尺寸（`DisplayMetrics.xdpi` / `ydpi`）结合用户可选的物理尺标标定，构建统一的排版引擎尺寸单位：

$$
\\text{Scale Ratio} = \\frac{\\text{Physical Screen Width (mm)}}{\\text{Screen Pixel Width}}
$$

$$
\\text{Target Pixel} = \\text{Target Point (pt)} \\times \\frac{1}{72} \\times \\text{DPI}
$$

#### 预设阅读版式档案（Reading Profiles）

1. **中文经典文学档案（Chinese Literature）：**

   * 字体：思源宋体（Source Han Serif / Noto Serif SC）
   * 字号：$12.5,\\text{pt}$（约 $4.4,\\text{mm}$ 高度）
   * 行距：$1.75$ 倍行高（确保视线换行不跳行）
   * 首行缩进：严格 $2.0,\\text{em}$
   * 版心边距：左右各 $14,\\text{mm}$，上下各 $16,\\text{mm}$
   * 两端对齐：启用双向对齐，严格执行避头尾法则（CJC Kashing Rules）
2. **英文及学术论著档案（English \& Academic）：**

   * 字体：Literata / Charis SIL
   * 字号：$11.5,\\text{pt}$
   * 行距：$1.50$ 倍行高
   * 段落间距：$0.5,\\text{em}$，首行缩进 $1.2,\\text{em}$
   * 连字处理：开启自动音节断字（Hyphenation）与西文两端对齐
3. **中英混排技术档案（Mixed Technical）：**

   * 中文思源黑体（Noto Sans SC）+ 英文 JetBrains Mono / Inter
   * 自动在汉字与半角英数之间注入 $0.25,\\text{em}$ 的微盘间隙（Pangu Spacing）

### 3.3 图标与视觉符号规范

* **纯矢量单色描边：** 所有图标均采用 $1.5,\\text{dp}$ 或 $2.0,\\text{dp}$ 的等宽黑色线条，严禁填充复杂渐变色。
* **高对比几何形态：** 图标内封闭图形保持留白，避免细密网格在墨水屏低 PPI 或快速刷新模式下糊成黑块。

### 3.4 图像与混排图表的动态抖动（Dithering）处理

* **Floyd-Steinberg 误差扩散算法：** 针对插图、封面及复杂彩色 PDF，在客户端 native 层通过 C++/NDK 执行实时 Floyd-Steinberg 抖动，将 24-bit 真彩色映射为 16 级灰阶，消除大面积渐变导致的等高线伪影（Color Banding）。
* **对比度动态拉伸：** 文本内嵌图表自动执行灰度直方图均衡化（Histogram Equalization），确保图表背景变纯白、文字与数据线深度黑化。

## 4\. 文石 EPD 刷新引擎与硬件调度规范

### 4.1 BOOX 刷新模式矩阵与场景映射

文石提供专有的 EPD 刷新模式。原生阅读 App 必须根据用户交互场景，精准调用 `EpdController` 调度不同的波形模式：

```
                ┌───────────────────────────────────────────────┐
                │          App 场景化刷新状态机分派器           │
                └──────┬───────────────┬───────────────┬────────┘
                       │               │               │
        \\\[静态正文翻页] │  \\\[快速滑动列表]│  \\\[低延迟手写] │ \\\[输入法打字/AI流式]
                       ▼               ▼               ▼        ▼
                   【Regal】         【Speed】      【Direct】   【A2】
                极致清晰无残影     流畅无卡顿      笔尖零延迟  高频局部响应

```

|场景分类|推荐 EPD 模式|官方 SDK 常量对应|视觉效果|适用交互界面|
|-|-|-|-|-|
|**标准正文翻页**|**Regal Mode**|`EINK\\\_MODE\\\_REGAL`|极高锐度、抑制残影、翻页无全屏黑闪|书籍正文翻页、章节切换、图文混排阅读|
|**长列表快速滚动**|**Speed Mode**|`EINK\\\_MODE\\\_EPD\\\_SPEED`|灰阶降低至 4\~8 级，刷新率提升至 15\~20fps|藏书书架快速选书、长笔记列表滚屏|
|**手写批注书写中**|**Direct Raw**|`TouchHelper.setRawDrawingRenderEnabled`|笔迹硬件直通，<25ms 延迟，无系统抗锯齿|页面空白处随手写、手写圈注|
|**文本输入 / 搜索**|**A2 Mode**|`EINK\\\_MODE\\\_EPD\\\_A2`|仅保留黑白双色，响应速度 <30ms|软键盘打字、搜索框实时输入、目录过滤|
|**极速动画 / 拖拽**|**X-Mode**|`EINK\\\_MODE\\\_EPD\\\_X`|极限刷新率，有轻度噪点|复杂图表缩放、PDF 视窗连续拖动|

### 4.2 脏矩形（Dirty Rect）局部刷新调度器

墨水屏的全局刷新代价昂贵。App 必须实现专属的 **`DirtyRectCoordinator`**，拦截并精细化局部重绘：

1. **变动边界提取：** 捕获发生变动的最小 View 或 Canvas 局部外接矩形（如顶栏电量变化、页脚页码跳动、进度条拖拽游标）。
2. **区域合并与节流：** 将 $50,\\text{ms}$ 内相邻或重叠的脏矩形合并（Union Rect），调用：

```
   EpdController.applyEntity(view, EpdController.EINK\\\_MODE\\\_EPD\\\_PARTIAL, dirtyRect)
   
   ```

3. **隔离阅读主区域：** 菜单栏弹出或收起时，仅对菜单浮层自身区域分发 Partial 刷新，严禁让底部承载正文的画布触发全区域重绘。

### 4.3 全局刷新（Full Refresh / Regal Flush）节流机制

* **翻页计数器触发：** 默认每翻动 **15\~20 页**（用户可调：10\~50 页）在后台线程触发一次全局 Regal 清屏，彻底清除历史微量残影。
* **章节切换静默触发：** 在用户跨章节跳转、重新打开书籍等自然停顿点，自动执行一次静默全屏刷新（GC 波形）。
* **防频闪看门狗（Watchdog）：** 在执行高质量刷新后，必须等待 `EpdController.waitForUpdateFinished()` 信号，并设定 $300,\\text{ms}$ 超时熔断保护，防止连续指令插队导致面板死锁或剧烈频闪。

### 4.4 双色温前光与待机状态机管理

* **冷暖光精细分离：** 接入 `FrontLightController`，提供“日间通透（冷光为主）”与“夜间护眼（暖光为主）”的独立通道控制。
* **息屏画面（Power-off Cover）直通：** 支持在应用退至后台或系统休眠时，将当前正在阅读书籍的高清封面与阅读进度，直接渲染为系统锁屏待机画，发挥电子纸零功耗常显优势。

## 5\. 低延迟手写与双层批注引擎规范

### 5.1 BOOX 原生硬件笔迹层与 Android 向量层双轨架构

Pagewise 在 Web 端使用 Vue 组件承载手写存在延迟物理极限。原生架构必须采用文石官方推荐的 **“双层解耦双轨驱动架构”**：

```
┌────────────────────────────────────────────────────────┐
│  Layer 1: BOOX Direct Raw Drawing Layer (TouchHelper)   │
│  - 笔尖接触屏幕瞬间激活，绕过 Android WindowManager     │
│  - 直接将压感与轨迹送入 EPD 硬件显存，实现 <25ms 跟手感 │
└──────────────────────────┬─────────────────────────────┘
                           │ 笔尖抬起 (ACTION\\\_UP)
┌──────────────────────────▼─────────────────────────────┐
│  Layer 2: Android Native Vector Path Layer (Native)    │
│  - 接收原始笔迹轨迹点 (X, Y, Pressure, Timestamp)      │
│  - 贝塞尔曲线平滑，存入 SQLite / 矢量持久化池          │
│  - 触发一次局部高品质 Regal 刷新，完成正式渲染替代     │
└────────────────────────────────────────────────────────┘

```

### 5.2 笔刷模型、压感曲线与防误触

* **笔刷类型与调教：**

  * **钢笔（Fountain Pen）：** 启用指数级压感曲线（Pressure-to-Stroke Width），线宽范围 $1.0,\\text{px} \\sim 8.0,\\text{px}$。
  * **圆珠笔（Ballpoint）：** 固定线宽（例如 $2.0,\\text{px}$），不响应压感，适合小字高密度批注。
  * **荧光笔（Marker / Highlighter）：** 采用 $16,\\text{px}$ 半透明灰度笔刷，混合模式设为 `PorterDuff.Mode.MULTIPLY`（正片叠底），确保划线不遮盖底层印刷字迹。
* **手掌防误触（Palm Rejection）：**

  * 严格识别 `MotionEvent.TOOL\\\_TYPE\\\_STYLUS` 与 `TOOL\\\_TYPE\\\_FINGER`。
  * 当手写模式开启时，屏幕仅响应电磁笔尖轨迹与笔尾物理橡皮擦；手指触控仅允许用于单指边缘轻点翻页或双指缩放操作。

### 5.3 翻页/缩放时的笔迹光栅化（Bake）与坐标矩阵映射

* **动态重排版锚定（EPUB/TXT）：**

  * 手写笔迹严禁采用全局绝对物理坐标。
  * 笔画生成时，系统自动计算其外接几何包围盒相交的正文文字 DOM/TextRange，将笔迹转换为**基于字符偏移量（CFI Offset）的相对浮动锚点**。
  * 字体缩放或行距微调时，锚定笔迹随文字块一同位移，保持批注语义上下文永不丢失。
* **静态版式直存（PDF）：**

  * 笔迹直接挂载至 PDF 页面的变换矩阵（CTM），页面缩放平移时仅对 Canvas 执行硬件矩阵变换。
  * 导出时直接注入符合 Adobe PDF 标准的 Annotations 注释流。

## 6\. 原生排版引擎与渲染管线架构

### 6.1 原生排版管线选型与分层

彻底替换 WebView 排版（`foliate-js`），构建三层原生渲染架构：

```
┌────────────────────────────────────────────────────────┐
│            Native Typography Engine (Kotlin)           │
├──────────────────────────┬─────────────────────────────┤
│ 1. 文本重排版引擎       │ 基于 Android StaticLayout   │
│    (EPUB / MOBI / TXT)   │ + HarfBuzz + ICU 高性能排版  │
├──────────────────────────┼─────────────────────────────┤
│ 2. 固定版面渲染引擎     │ 基于 MuPDF C++ NDK /        │
│    (PDF / DJVU / CBZ)    │ PdfRenderer 原生硬件加速    │
├──────────────────────────┴─────────────────────────────┤
│ 3. 统一视图控制器 (Pure Native SurfaceView / CustomView)│
└────────────────────────────────────────────────────────┘

```

### 6.2 EPUB/MOBI/TXT 重排版与原生 CFI 锚定机制

* **高性能分页算法：**

  * 弃用 CSS 多列布局计算。直接使用 `StaticLayout.Builder` 在后台子线程按页面几何高度测量文字断行。
  * 利用二分法快速定位分页截断点，首屏分页计算延迟由 WebView 的 1.2s 缩短至原生 **80ms** 以内。
* **原生 EPUB Canonical Fragment Identifier (CFI) 引擎：**

  * 独立构建原生 CFI 解析器，在 Kotlin 内存树中维护与原书 XML 节点一一对应的虚拟 DOM。
  * 保证阅读进度、跨平台书签、笔记位置与标准 EPUB 阅读器（如 Foliate、Apple Books）100% 互通。

### 6.3 PDF 瓦片化渲染（Tile-based Rendering）与内存池设计

* **视口切片渲染（Tiling）：**

  * 针对大尺寸高分辨率扫描版 PDF（例如 100MB+ 的学术专著），禁止整页全分辨率解码进内存。
  * 按照当前屏幕分辨率将其划分为 $512 \\times 512,\\text{px}$ 的渲染瓦片（Tiles），仅解码视口内可见瓦片。
* **Bitmap 内存复用池：**

  * 启用 `BitmapPool` 复用机制，限制最大常驻图片内存不超过 $64,\\text{MB}$，彻底杜绝在 2GB 内存设备上的 OOM 崩溃。

## 7\. AI 伴读与语音朗读交互适配规范

### 7.1 流式生成内容（Token Streaming）的墨水屏聚合缓冲

在普通彩色屏上，AI 问答通常以 30\~50 Token/s 的速度逐字吐出打字机效果。但在墨水屏上，逐字刷新会导致屏幕产生剧烈的高频高斯频闪，毁掉阅读体验。

#### 墨水屏流式刷新聚合调度算法：

```
class EinkStreamAggregator(
    private val minTokenCount: Int = 18,    // 每次缓冲最小 Token 阈值
    private val flushIntervalMs: Long = 650L // 最小刷新时间间隔
) {
    // 算法逻辑：
    // 1. 接收底层 SSE / WebSocket 传输的单个 Token
    // 2. 存入内存文本缓冲区 Buffer
    // 3. 当满足 (Buffer 字符数 >= 18) 或 (距上次刷新时间 >= 650ms) 时：
    //    a. 批量更新 UI 文本 TextView
    //    b. 发起局部 A2 快速增量刷新 (Dirty Rect)
    // 4. 当 LLM 输出完毕 (onComplete) 时：
    //    执行一次局部的 Regal 优质刷新，消除 A2 模式遗留的微弱文字残影
}

```

### 7.2 伴读卡片分屏与画中画布局

* **大屏设备（**$\\ge 10.3$ **英寸，如 Note / Tab 系列）：**

  * 默认启用**左右双栏并排**架构（左侧 65% 为正文阅读区，右侧 35% 为 AI 伴读分析面板）。
  * 两侧独立拥有独立的刷新上下文，AI 面板的滚动不干扰正文区域的静态画面。
* **小屏设备（**$6.0 \\sim 7.8$ **英寸，如 Poke / Page 系列）：**

  * 采用**底部静态抽屉（Bottom Drawer）**。
  * 展开高度固定为屏幕的 $45%$ 或 $85%$，禁止无级悬停拖动，轻触即可整屏切换。

### 7.3 TTS 语音朗读与视觉跳行高亮同步

* **音频管线：** 沿用 Pagewise 的 Edge TTS 与本地离线神经语音（Kokoro），确保完全无网环境下仍可朗读。
* **视觉跟读高亮规范：**

  * 正在朗读的句子采用**单像素外框矩形标记**，或将该句背景色反转（白底黑字变黑底白字），严禁使用彩色荧光黄色块。
  * 视线跟读高亮框移动时，调度系统局部 `A2` 快速刷新；整页朗读完毕翻至下一页时，再执行一次全局 `Regal` 翻页刷新。

## 8\. 性能基准、兼容性与工程实施指导

### 8.1 核心性能与功耗红线（SLA）

在文石典型硬件平台（如高通 662 / 680，3GB RAM，Android 11/12）上，必须达成如下性能指标：

|性能指标|纯原生架构红线目标|Pagewise 混合架构基线|提升幅度|
|-|-|-|-|
|**冷启动进入书架**|$\\le 750,\\text{ms}$|$\\sim 2.4,\\text{s}$|**加快 68%**|
|**打开 50MB EPUB 首屏**|$\\le 600,\\text{ms}$|$\\sim 1.8,\\text{s}$|**加快 66%**|
|**页面翻转响应延迟**|$\\le 45,\\text{ms}$ **(逻辑) + EPD**|$\\sim 160,\\text{ms}$|**跟手度提升 3.5 倍**|
|**电磁笔书写延迟**|$\\le 22,\\text{ms}$|$\\ge 85,\\text{ms}$|**实现真纸级跟手**|
|**空闲阅读常驻内存 (RAM)**|$\\le 85,\\text{MB}$|$\\sim 290,\\text{MB}$|**节省 70% 内存**|
|**连续翻页每小时耗电**|$\\le 2.2%$|$\\sim 5.8%$|**续航翻倍以上**|

### 8.2 文石全系设备分级适配策略

```
文石硬件生态全景矩阵适配
├── 掌上便携组 (6.0" - 7.0")  \\\[Poke 系列 / Palma 系列 / Page 系列]
│   └── 焦点：紧凑版心、单手按键翻页映射、全屏无边框沉浸模式
├── 专业阅读组 (7.8" - 10.3") \\\[Nova 系列 / Go 系列 / Note 系列]
│   └── 焦点：手写笔双层架构、分屏 AI 伴读、PDF 双列切边重排
└── 桌面工作组 (13.3")        \\\[Tab Ultra 系列 / Max Lumi 系列]
    └── 焦点：原尺寸 A4 论文双页并列批注、多任务分栏浮窗

```

### 8.3 项目工程模块依赖与 SDK 集成蓝图

```
Pagewise-Native/
├── app/                                 # 核心宿主模块
├── core-boox/                           # 文石硬件抽象适配库
│   ├── com.onyx.android.sdk:api:1.4.0   # 官方 EPD 与前光 SDK
│   ├── EpdControllerBridge.kt           # 脏矩形与刷新模式调度器
│   └── TouchHelperManager.kt            # 硬件级 Direct-to-FrameBuffer 手写控制器
├── core-typography/                     # 原生排版核心引擎
│   ├── HarfBuzzShaper.kt                # 复杂文本字形整形
│   ├── PhysicalScaleCalibrator.kt       # 毫米/磅值物理尺度校准
│   └── StaticLayoutPaginator.kt         # 原生二分法分页引擎
├── core-document/                       # 文档解码管线
│   ├── epub/ (Native CFI \\\& Zip parser)  # 原生 EPUB 流式解析器
│   └── pdf/ (MuPDF NDK + TilePool)      # C++ 瓦片化渲染器
├── core-ai/                             # AI 伴读与流式调度
│   ├── EinkStreamAggregator.kt          # Token 聚合防闪烁调度器
│   └── MultiModelClient.kt              # DeepSeek / Gemini / OpenAI 客户端
└── core-database/                       # 本地存储 (Room / SQLite)
    └── AppDatabase.kt                   # 兼容原 lightread.db 结构的纯原生持久层

```

## 9\. 总结：定义下一代墨水屏阅读标准

从 [Pagewise](https://github.com/shawnshi/Pagewise) 的混合架构探索中，我们看到了对深度阅读、物理排版质感与 AI 智能体辅助的执着追求。通过本规范的“纯原生化改造”：

1. 用 **Android 极速原生渲染** 彻底瓦解了 Chromium 渲染引擎在电子纸上的残影与掉帧沉疴；
2. 借 **文石专有 EPD 与 TouchHelper 硬件直通**，重新找回了墨水屏最核心的物理优势——**极致低延迟的电磁笔真纸书写感** 与 **纤毫毕现的静止纸质印刷感**；
3. 以 **墨水屏专属流式聚合算法**，使现代前沿的生成式 AI 伴读无缝融入无闪烁、不疲倦的深度阅读体验之中。


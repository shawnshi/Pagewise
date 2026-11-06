# Pagewise（知页）页面设计及交互规范（v2.1 Agent-Ready）

- **适用项目**：`github.com/shawnshi/Pagewise`（包名 `io.pagewise.reader`）
- **目标硬件**：Onyx BOOX 等 Android 电子墨水屏（E-Ink Carta 1200/1300）终端
- **规范版本**：v2.1（基于 2026-11 架构演进、S2 阶段基线与 S3 工程化落地深度校准）

## 1. 项目定位、技术架构边界与 E-Ink 核心设计哲学

**Pagewise（知页）**是一款专为 Android 电子墨水屏（E-Ink）设备打造的开源、本地优先（Local-First）深度阅读应用，核心产品主张为**“专注阅读，随页理解”**（Focus on reading, understand page by page）。项目旨在解决传统电子书阅读器在“中英双语平行对照排版”、“学术与长文结构化速览（AI 伴读）”以及“墨水屏低残影高刷协同”三大维度的体验断层，为用户提供兼具私人藏书馆典藏秩序感与深度知识消化能力的数字阅读终端体验。本 v2.1 规范针对前端与 Android 原生双端开发 Agent 提供零歧义的令牌、布局、状态机与硬件刷新契约。

### 1.1 Native + Web 混合双层架构与页面职责边界

依据项目最新的 Android 原生页面架构规范（`android-native-pages.md`）与 E-Ink UI 改造计划（`eink-ui-plan-20261023.md`），Pagewise 摒弃了早期全量依赖重型 WebView 启动的单体模式，确立了**“原生管理层先行渲染 + Web 阅读核心层按需挂载”**的混合架构边界：

- **Android 原生管理层（Kotlin Native Pages）**：涵盖书架（Bookshelf）、在读列表（Reading List）、书籍详情（Book Detail）、全部笔记（All Notes）、阅读统计（Reading Stats）、系统设置（Settings）及用户手册（User Manual）。所有原生页面直接读写底层共享 SQLite 数据库（`lightread.db`）与 Android SAF（Storage Access Framework）授权目录，通过静态 Splash 直达原生列表，消除 WebView 冷启动白屏，显著缩短首帧显示时间（TTID）与完整绘制时间（TTFD）。
- **Web 阅读引擎层（Vue 3 + Tauri 2 + Foliate-js / PDFium / MuPDF）**：仅在打开具体书籍进入 EPUB 流式阅读（`ReadingView.vue`）或 PDF 文献阅读（`PdfReaderView.vue`）时挂载单实例 Web 视图。阅读层通过 Native-Web IPC 桥接器调用 `OnyxInkLayer.vue`，接管文石（Onyx BOOX）底层 EPD 刷新控制与原笔迹手写硬件直通接口。

### 1.2 五大核心设计原则（E-Ink Human Interface Principles）

综合仓库内全局设计规范（`design.md`）与 BOOX 原生阅读器规范（`boox_native_reader_design_specification.md`），所有页面与组件必须严格遵循以下五条不可妥协的墨水屏设计法则：

1. **E-Ink 原生克制美学（Zero-Blur, High-Contrast Monochrome）**：彻底禁止弥散阴影（`box-shadow`）、高斯模糊（`backdrop-filter`）、彩色渐变（`linear-gradient`）与半透明蒙层。视觉层级完全依托 16 级量化灰阶色块、`1px` 实线发丝边框（Hairline Borders）与字体粗细/字号对比建立。
2. **瑞士网格与私人藏书室秩序（Swiss Editorial & Archival Grid）**：界面骨骼参考瑞士国际主义平面网格与纸质图书馆索引卡，强调高密度信息的结构化折叠、严格统一的图书封面画幅比以及等宽数字（Tabular Figures）的垂直对齐。
3. **零动画硬切与脏矩形节流（Zero-Animation Hard Cuts）**：全局禁用一切 CSS 位移/淡入淡出动画（`transition: none`、`animation: none`）与弹性滚动回弹（Overscroll Glow）。页面切换、抽屉展开与弹窗显隐均采用 `0ms` 瞬时硬切，防止电子墨水微胶囊在中间帧产生拖影与闪烁。
4. **瞬态反白按压微反馈（Instant A2 Micro-Feedback，v2.1 新增）**：在消除一切 CSS 过渡动画后，为防止用户在耗时 I/O（如打开大体积 PDF、重链目录或触发 AI 伴读）时产生“设备死机或点击漏触”的错觉，所有可点击按钮、列表项与工具栏图标必须在按下瞬间（`pointerdown` / `ACTION_DOWN`）切入 `A2` 极速二值模式（延迟 `< 30 ms`），立即渲染为**实心反白态（纯黑底 `#000000` + 纯白前景 `#FFFFFF`）**或**`2px` 纯黑内描边态**，并在操作响应或抬起后恢复。
5. **随页伴读而不打断阅读心流（Contextual Companion Without Interruption）**：AI 辅助阅读模块（“伴读 / Pagewise Companion”，见 `companion-20261020.md`）严禁以常驻气泡或自动弹窗干扰正文；必须通过显式入口或划词动作按需唤起，并在墨水屏上实施流式 Token 聚合刷新，做到“呼之即来、挥之即去”。

## 2. 目标设备矩阵、物理尺寸校准与复合视图状态机

依据设备准入规范（`device-admission.md`），Pagewise 面向 ARM64（`aarch64`）架构的 Android 电子墨水屏终端构建，核心基准测试机型为 Onyx BOOX Note X3 Pro、BOOX Palma 2 及同代搭载 Carta 1200 / Carta 1300 墨水屏的阅读器。不同形态终端具有截然不同的握持姿势与视距特征，设计规范按以下三级设备矩阵实施响应式布局与交互映射：

| 设备形态分级 | 代表硬件型号与屏幕参数 | 典型视距与握持方式 | 核心布局策略与交互侧重 |
| :--- | :--- | :--- | :--- |
| **Tier 1：便携单手终端**（5.8"–6.13" 竖屏） | BOOX Palma / Palma 2 · 824×1648 px · 300 PPI · Carta 1200 · BSR 快刷 | 视距 25–32 cm · 单手拇指握持 + 侧边物理翻页键 | 书架采用 2 列紧凑网格或高密度单列列表；阅读页强制单栏流式排版，双语采用**段落上下交替模式**；激活单手下沉触控热区与 TTS 后台听书控制。 |
| **Tier 2：经典阅读终端**（7.0"–7.8" 竖屏） | BOOX Leaf 3 / Page / Nova Air · 1264×1680 px 或 1404×1872 px · 300 PPI | 视距 30–38 cm · 单手侧握边框（带物理按键区）或双手持握 | 书架采用 3 列标准网格；阅读页默认单栏沉浸布局（每行 28–34 汉字），伴读面板采用**底部半屏抽屉（Bottom Sheet，高度 45%–50% vh）**展开，避免挤压正文行宽。 |
| **Tier 3：大屏学术读写平板**（10.3"–13.3" 宽屏） | BOOX Note X3 Pro / Note Air 3 / Tab Ultra · 1860×2480 px (300 PPI) 或 1404×1872 px (227 PPI) + 4096 级压感笔 | 视距 35–48 cm · 桌面平放手写、分屏支架或双手持握 | 书架采用 4 列典藏网格；支持**中英双栏左右并排对照**、PDF 自动裁边与双页拼合、右侧固定分屏伴读面板（`PdfReadingAssistant.vue`）及 Wacom 原笔迹手写批注。 |

### 2.1 跨设备物理字号与触控热区校准模型（Physical Point & Target Calibration）

由于不同 Android 墨水屏厂商对系统 WebView 的 `devicePixelRatio (DPR)` 缩放设定不一，单纯依赖固定 CSS px 会导致同一字号与触控热区在 227 PPI（10.3"）与 300 PPI（6.13"/10.3" Pro）屏幕上呈现显著的物理尺寸偏差。依据《Pagewise 中英文阅读排版方案》，系统通过排版校准组件（`TypographyCalibration.vue`）引入物理毫米转换公式，并同步校准**字体字号**与**交互触控底线**：

- **物理像素系数计算**：设屏幕可视区域物理宽度为 `M (mm)`，CSS 视口宽度为 `C (CSS px)`，则单位 CSS 像素对应的物理毫米数为 `mm_per_css_px = M / C`。
- **目标印刷磅值（pt）转 CSS 像素公式**：`Target CSS px = Target pt × 25.4 / (72 × mm_per_css_px)`。以 300 PPI 标准屏幕（`DPR = 2.0`，物理像素尺寸 `0.08467 mm`，`mm_per_css_px = 0.16933 mm`）为例，`12.5 pt` 标准中文正文字号精确对应 `4.41 mm` 物理字高、`52.08` 物理像素及 `26.04 CSS px`。
- **物理触控热区动态注入（v2.1 新增）**：为消除不同 DPR 设备上的按钮物理尺寸失衡，全局最小触控热区锚定为物理尺寸 **`8.0 mm × 8.0 mm`**（300 PPI / DPR 2.0 下对应 `48 × 48 CSS px`），相邻热区最小物理隔离带锚定为 **`1.35 mm`**（对应 `8 CSS px`）。`TypographyCalibration.vue` 启动时必须向 `:root` 注入动态变量：`--eink-hit-target-min: max(48px, calc(8.0 / var(--mm-per-css-px) * 1px))` 与 `--eink-hit-gap-min: max(8px, calc(1.35 / var(--mm-per-css-px) * 1px))`。

### 2.2 Tier 3 复合分屏与双语并排防挤压自适应状态机（v2.1 新增）

在 Tier 3（10.3"–13.3"）终端上，若用户在**竖屏（Portrait，物理宽度约 157 mm）**下同时开启“中英双栏左右并排对照”与“右侧固定分屏伴读面板（占用 38%–42% 视口宽度）”，正文阅读区剩余物理宽度仅约 `91 mm`；此时若强行维持左右双栏，单栏净宽将跌破 `38 mm`（每行不足 10 个汉字），引发严重断行与视线折返疲劳。前端布局状态机（`stores/layout.ts`）必须执行以下硬性自适应降级规则：

- **单栏安全物理行宽断言**：正文单栏最小可读物理净宽锁死为 `W_col_min = 58 mm`（每行汉字数 `>= 22 字`）；开启中英左右双栏并排所需的正文容器最小净宽阈值为 `W_dual_min = 132 mm`（含左右页边距 `12 mm × 2` 与中缝 `16 mm`）。
- **伴读分屏唤起时的自动降级（Auto-Downgrade）**：当用户处于 `bilingual-side-by-side`（双栏并排）模式并唤起右侧固定伴读面板时，立即计算剩余正文容器物理宽度 `W_remain = C_remain × mm_per_css_px`。若 `W_remain < 132 mm`（如 10.3" 竖屏分屏态），系统立即将双语视图无缝硬切降级为**“段落上下交替模式（`bilingual-stacked`）”**，并记录挂起态 `suspendedDualColumn = true`；若 `W_remain >= 132 mm`（如 10.3" 横屏态或 13.3" 大屏态），则保持双栏并排不变。
- **伴读收起或转屏时的自动恢复（State Restoration）**：当用户关闭右侧伴读面板或将设备旋转至横屏使得 `W_remain >= 132 mm` 时，若 `suspendedDualColumn === true`，自动恢复为中英双栏左右并排对照模式。

## 3. 视觉设计系统：跨端零分叉灰阶令牌、双语排版与图标规范

### 3.1 Carta 1200/1300 16 级灰阶语义色彩体系（EINK-01，v2.1 跨端零分叉对齐）

电子墨水屏仅支持 4-bit（16 级，`Y0` 纯黑至 `Y15` 纯白）物理反射灰阶，且相近灰阶在无前光或冷暖前光环境下极易并阶。针对 v2.0 审计中发现的 Web 阅读层（`reader/src/styles/main.css`）与 Android 原生层（`Color.kt`）色值分叉隐患（原规范中 Android 端使用的 `#FAFAFA` 在 Carta 1200 硬件 LUT 下极易并入 `Y15` 纯白导致容器边界消失），**v2.1 强制废除双端差异色值，将 Web CSS 变量与 Android 原生常量锁死为同一套物理实测 Hex 色值**：

| 语义层级（Token 角色） | 物理灰阶档位 | Web CSS 变量（`main.css`） | 跨端锁死色值（Web & Android） | 对比度与典型适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **Canvas Pure**（画布纯白底） | Y15（纸白） | `--eink-surface-pure` | `#FFFFFF` | 阅读器正文背景、书架主画布、弹窗主底板，最大化墨水屏纸质反射率。 |
| **Surface Subtle**（浅灰容器） | Y14（极浅灰） | `--eink-surface-subtle` | `#EEEEEE`（废除 `#FAFAFA`） | 卡片底色、分组列表背景、顶部/底部工具栏底栏、输入框静态底色（确保无前光下不并入纯白）。 |
| **Surface Container / Highlight** | Y13（次级灰） | `--eink-surface-container` | `#DCDCDC`（统一 `#DDDDDD`） | 正文高亮底纹（强制配合 `1px` 下划线）、选中态标签背景、代码块底纹。 |
| **Border Hairline**（发丝分割线） | Y11（中浅灰） | `--eink-border-hairline` | `#BBBBBB`（废除 `#D4D4D4`） | 列表项 `1px` 分隔线、卡片内嵌边框、双语双栏中缝分隔线（防止高 PPI 下细线断线）。 |
| **Text Muted / Disabled**（弱化态） | Y7（中性灰） | `--eink-text-muted` | `#777777`（废除 `#8C8C8C`） | 禁用按钮文本、搜索框 Placeholder、未激活图标、空状态辅助提示（对比度 `4.48:1`）。 |
| **Text Secondary**（次级元数据） | Y4（深炭灰） | `--eink-text-secondary` | `#444444`（统一 `#4A4A4A`） | 书籍作者/出版社/日期、页眉章节名、页脚进度、批注时间戳（对比度 `9.74:1 > 8.5:1`）。 |
| **Text Primary / Brand Ink**（墨黑） | Y1 / Y0（纯黑） | `--eink-text-primary` / `--eink-solid-black` | `#111111`（正文） / `#000000`（实心块） | 阅读正文、主标题、主操作按钮实心填充、激活态粗边框（对比度 `18.8:1–21:1`）。 |

**夜间暗色模式预留约束（EINK-01-DARK，v2.1 新增）**：当系统扩展支持夜间反色阅读模式（`[data-theme="eink-dark"]`）时，严禁直接将画布反转为 `#000000` 纯黑底（纯黑底在墨水屏局部刷新时微胶囊残影极重）。暗色画布主底色必须锁定为 `Y1` 深炭灰（`#181818`），容器次级底色为 `Y2`（`#262626`），分割线为 `Y5`（`#555555`），正文文本为 `Y14` 柔白（`#EAEAEA`），且翻页全屏 Regal/GC16 刷新间隔必须从白底的 15–20 页收紧至每 **8 页** 触发一次。

### 3.2 中英双语与学术阅读排版规范（Typography Matrix）

依据《Pagewise 中英文阅读排版方案》与字体内嵌规范（`font-embedding.md`），针对中文沉浸阅读、英文原版阅读及中英双语对照三大核心场景，规范内置三套经硬件验证的排版预设参数（**严禁使用 `< 350` 极细字重以防断笔，严禁对正文使用 `> 600` 字重以防微胶囊晕染糊字**）：

| 排版维度 | 预设 A：中文连续阅读（文学/社科） | 预设 B：英文原版与学术阅读 | 预设 C：中英双语对照与知识读物 |
| :--- | :--- | :--- | :--- |
| **正文字体族** | 思源宋体（Source Han Serif SC / Noto Serif SC），字重 `400` | Literata 或 Charis SIL，字重 `400`（开启真斜体与连字 `liga`） | 中文 Noto Serif SC `400` + 英文 Literata `400`；代码 JetBrains Mono |
| **标题与 UI 字体** | Noto Sans SC 字重 `600` | Literata SemiBold (`600`) | Noto Sans SC `600` + Inter `600`；页码等宽 `tabular-nums` |
| **基准物理字号** | `12.5 pt`（约 `4.41 mm`，300 PPI 下为 `26.04 CSS px`） | `11.5 pt – 12.0 pt`（300 PPI 下为 `24.0 – 25.0 CSS px`） | 中文段 `12.5 pt` / 英文段 `12.0 pt`（视觉字高平衡配比） |
| **行高（Line Height）** | `1.70 – 1.75`（给汉字方块字留出纵向呼吸带） | `1.50 – 1.55`（契合拉丁字母 x-height 水平视线扫视） | 中文段 `1.75` / 独立英文段 `1.55` |
| **首行缩进与段间距** | 首行缩进 `2.0 em`；段间距 `0.15 em` | 首行缩进 `1.2 em`（章节标题后首段 `0 em`）；段间距 `0 – 0.5 em` | 取消首行缩进（`0 em`）；段间距扩大至 `0.45 em` 以区分语段 |
| **对齐、断词与中西混排** | 两端对齐（`justify`），单行字数控制在 `28 – 36` 字 | 左对齐或开启自动断词（`hyphens: auto`）两端对齐，单行 `55 – 75` 字符 | 中西文及数字间强制插入 `0.25 em` 盘古留白（Pangu Spacing） |
| **物理页边距（Margins）** | 左右 `12 – 14 mm`；上 `12 mm` / 下 `16 mm` | 左右 `14 mm`；上 `14 mm` / 下 `16 mm` | 单栏左右 `12 mm`；10.3" 双栏并排时外边距 `12 mm`、中缝 `16 mm` |

### 3.3 线性图标系统（EINK-02）与封面误差扩散抖动（EINK-03）

- **单色线性图标规范（`Pagewise_menu_icons`）**：全局 45 枚原生及阅读器工具栏图标统一基于 `24×24 dp` 网格绘制，内部保留 `2 dp` 安全白边；默认态采用 `1.5 dp` 纯黑（`#000000`）描边与圆角端点，激活/选中态加粗至 `2.0 dp` 或切换为实心反白块（纯黑底 `#000000` + 纯白图标 `#FFFFFF`），严禁使用浅灰半透明填充区分选中态。
- **图书封面 Floyd-Steinberg 抖动管线**：彩色图书封面在导入本地数据库时，统一经由 **Floyd-Steinberg 误差扩散抖动算法（Error Diffusion Dithering）** 离线转换为 16 级灰阶无损 WebP 缩略图（`eink-ui-plan-20261023.md`），避免彩色封面直接由系统降采样产生死黑色块；所有封面容器四周强制叠加 `1 dp` 实线内描边（`#BBBBBB` 或 `#000000`），防止白色背景封皮与页面底色融为一体。

## 4. 核心页面信息架构与组件级布局规范

基于 S2 阶段 UI 规范（`eink-ui-s2-20261024.md`）、UI/UX 整改准则（`ui-ux-remediation-20261022.md`）及阅读器控件校验规范（`reader-controls-validation.md`），各核心页面的信息架构、状态机与组件布局定义如下：

### 4.1 书架与在读管理页（Bookshelf & Reading Dashboard）

书架与在读管理页（对应原生 Activity 及 `LibraryView.vue`、`ReadingView.vue`）承担本地 SAF 书库检索与阅读生命周期管理职责：

- **顶部导航与统计内聚（S2 规范）**：主标题右侧尾随展示紧凑型统计摘要（如 `共 128 本 · 累计阅读 46.5 小时`，采用 `#444444` 次级灰与等宽数字）；顶部工具栏仅暴露“搜索”与“视图切换（网格/列表）”，将排序方式、SAF 目录重链（`BookRelinkDialog.vue`）、可用性过滤（`AvailabilityFilter`）及批量管理收拢至单一“更多（More）”下拉菜单中，消除顶栏拥挤。
- **6 态标准阅读生命周期与空分类折叠**：统一使用 6 种标准状态枚举：`unmarked`（未标记，自动迁移旧版 `unread`）、`wanted`（想读）、`reading`（在读）、`paused`（暂停）、`finished`（已读完）、`abandoned`（弃读）。分类筛选栏必须自动隐藏书籍数量为 `0` 的状态标签；若接口返回负数计数，前端须立即拦截并渲染加载异常重试态，严禁展示 `-1` 等错误数字。
- **书籍卡片（`BookCard`）视图感知型热区与元数据去噪（PW-09，v2.1 升级）**：
  - *视图感知型封面防误触策略（View-Aware Cover Hit Strategy）*：针对 v2.0 一刀切取消封面热区在网格视图下造成的点击挫败感，v2.1 区分视图模式绑定热区：在**列表视图（List View）**中，图书封面严格保持静态非点击态（`pointer-events: none` / `clickable = false`），点击优先级收拢至右侧书名主链接与显式操作按钮（“继续阅读”、“详情”）；在**网格视图（Grid View）**中，允许封面响应打开操作，但必须挂载 **E-Ink 严格点击判定拦截器（Strict Tap Gesture Filter）**——仅当触控按下与抬起位移 `Δd < 4 dp`（约 `0.68 mm`）、按压驻留时长 `60 ms <= Δt <= 250 ms` 且当前未处于整屏翻页阶段时才触发打开，彻底兼顾直觉点按与翻页防误触。
  - *双行出版元数据与单节点进度合并*：`libraryPage` 数据传输对象（DTO）包含完整作者、出版社与出版日期，分两行渲染并以清晰中圆点（`·`）分隔；阅读页码进度、累计时长与最近阅读时间合并为单一可自动折行文本节点（如 `第 84/320 页 (26%) · 已读 2h 15m · 昨天`），避免窄屏下多徽章挤压截断。

### 4.2 EPUB 流式阅读页与中英双语视图（ReadingView & Foliate Engine）

阅读页遵循“零常驻干扰、单次点击唤醒控制层”的沉浸式三层画布架构：

- **沉浸画布层（Layer 0）**：顶部页眉（高 `28 dp`）居左显示当前章节标题（`10 pt`，`#444444`），右上角仅在伴读后台任务运行时展示非占位悬浮状态指示器（`PagewiseCompanionStatus.vue`）；底部页脚（高 `28 dp`）居右以等宽数字显示当前章节页码与全书百分比。
- **顶底工具栏控制序列（Layer 1，严格校验顺序）**：单击屏幕中央唤醒顶底控制栏。依据 `reader-controls-validation.md`，阅读器核心功能栏必须严格按以下 **7 项固定序列**排列，禁止随意增删或调换顺序：
  **1. 目录（Contents） → 2. 搜索（Search） → 3. 书签（Bookmarks） → 4. 批注（Annotations） → 5. 阅读助手（伴读 / Companion） → 6. 朗读（TTS） → 7. 排版（Typography）**。
- **排版调节面板规范（`TypographyPanel.vue`，PW-10）**：所有表单控件的文本标签（Label）统一置于输入框或滑块正上方；优先置顶高频设置（中/英/双语预设切换、字号离散步进器、行高档位、页边距档位）。滑块组件（`LevelSlider.vue`）采用离散刻度点点击切换与 `- / +` 按钮微调，避免在墨水屏上进行连续拖拽引发高频闪烁。

### 4.3 PDF 学术阅读器与其余原生详情/统计页面

- **PDF 阅读与分屏伴读（`PdfReaderView.vue`）**：左侧或主画布基于 PDFium / MuPDF 渲染文档并提供自动白边裁切与文本行命中测试（Hit Testing）；在 10.3" 及以上设备开启“伴读（Companion）”时，采用右侧 `38%–42%` 宽度的固定分屏面板（`PdfReadingAssistant.vue`），支持对照原文同步滚动阅读 AI 提炼的章节大纲与术语解析（同时受 2.2 节复合视图防挤压状态机约束）。
- **书籍详情、统计与手册（`android-native-pages.md`）**：
  - *书籍详情（`BookDetailView.vue`）*：顶部展示抖动灰阶封面、6 态状态切换器与 AI 导读入口（`BookIntroductionDialog.vue`），下方内嵌只读目录快照（Read-only TOC Snapshot）与本书精选笔记预览。
  - *阅读统计（`StatsView.vue`）*：严格以单日累计阅读时长 `>= 60 秒`作为“有效阅读日（Active Reading Day）”统计阈值；打卡日历与时长分布图采用高对比度黑白斜线纹理与 4 级灰阶方块填充。
  - *用户手册（`ManualView.vue`）*：内置 Markdown 文档通过原生 CommonMark 控件直接渲染，离线可用。

## 5. 交互架构：触控热区、硬件按键、手写笔与伴读状态机

### 5.1 物理校准触控热区（PW-03）与单手/物理按键翻页映射

- **8.0 mm（48 CSS px）最小触控底线（PW-03）**：全局所有可点击按钮、图标、列表操作项及伴读卡片按钮的触控热区（Hit Target）强制满足 `>= var(--eink-hit-target-min)`（物理尺寸 `>= 8.0 × 8.0 mm`，300 PPI 下 `>= 48 × 48 CSS px`），且相邻热区必须保留至少 `var(--eink-hit-gap-min)`（物理尺寸 `>= 1.35 mm`，`>= 8 px`）物理隔离带，严禁工具栏热区与正文首尾行或状态角标发生空间重叠（`reader-controls-validation.md`）。
- **九宫格触控与物理翻页键接管**：
  - *标准模式*：屏幕左 `30%` 宽度为“上一页”，右 `30%` 宽度为“下一页”，中央 `40%` 区域单击唤醒/收起顶底工具栏。
  - *Palma 单手握持模式*：屏幕左右两侧下方 `2/3` 高度区域均映射为“下一页”，上方 `1/3` 为“上一页”，适配左右手单手拇指自然点击。
  - *物理按键硬映射*：通过 Android 原生 `KeyEvent` 拦截器将音量加减键（`KEYCODE_VOLUME_UP/DOWN`）与 BOOX 侧边翻页键（`KEYCODE_PAGE_UP/DOWN`）直接绑定至阅读器翻页与书架整屏翻页（Page Flip instead of Scroll），彻底静默系统音量条弹窗。

### 5.2 划词菜单定制（PW-04）与“草稿优先”批注状态机（PW-02 & S2）

针对墨水屏上长按划词易与系统菜单冲突、输入法唤醒慢导致灵感丢失的痛点，规范定义以下闭环流程：

1. **定制划词悬浮菜单（PW-04）**：选中文本松手后，彻底抑制 Android WebView 原生系统浮动菜单，立即在选区上方或下方（避开选区文本）硬切渲染 Pagewise 单色实线菜单栏，依次提供：**复制（Copy） | 全选当前分节（Select Current Section） | 高亮（Highlight） | 写想法（Idea Draft） | 伴读解析（Companion）**。
2. **“先编辑草稿，再产生正式批注”状态机（PW-02）**：用户点击“写想法”时，**严禁直接向数据库插入空白或半成品正式批注**。系统首先创建本地想法草稿（Idea Draft）：
   - 若用户在输入中途点击遮罩层关闭、按 `Esc` 键或意外翻页，草稿自动暂存至当前书籍上下文，下次点开同一段落时无缝恢复未完成内容。
   - 仅当用户显式点击“保存批注”按钮时，才将草稿提升（Promote）并持久化为正式批注记录。
   - **控制器代际隔离（Panel Epoch Binding，见 `eink-ui-s2-20261024.md`）**：所有子菜单与想法草稿严格绑定至当前阅读控制器代际（Controller Generation / Panel Epoch），当切换书籍或销毁阅读会话时强制清理旧代际瞬态状态，防止跨书籍状态串扰。

### 5.3 双层低延迟手写批注架构与矢量擦除反馈（OnyxInkLayer 硬件直通）

在 BOOX Note / Tab 等支持电磁笔的设备上，WebView 标准 Canvas 绘制存在 `150–300 ms` 延迟，无法满足纸感书写。依据 `OnyxInkLayer.vue` 与 `boox_native_reader_design_specification.md`，手写交互采用双层协同架构：

- **第一层：硬件 EPD 原笔迹直写层（Direct Raw Layer，延迟 `< 25 ms`）**：当检测到手写笔落笔（`MotionEvent.TOOL_TYPE_STYLUS`）时，立即通过 `onyxScribble` 桥接服务激活文石底层 `TouchHelper.setRawDrawingRenderEnabled(true)`，绕过 Android 视图合成器直接在墨水屏控制器绘制 2-bit 墨迹，并同步锁定手指多点触控以实现精准防手掌误触（Palm Rejection）。
- **第二层：贝塞尔矢量化与局部 Regal 固化层（Vector Persistence Layer）**：抬笔（`ACTION_UP`）瞬间，采集笔迹点序列并通过 `strokeToSvgPath` 拟合为平滑贝塞尔 SVG 路径写入笔记存储；并在抬笔后延时 `200 ms` 触发单次脏矩形局部 `Regal` 刷新，将锯齿状 A2 原笔迹替换为抗锯齿高清矢量线条。
- **矢量相交擦除瞬态视觉反馈（Intersection Erasing Feedback，v2.1 新增）**：当电磁笔尾端橡皮擦或侧边擦除键划过已有矢量笔迹时，相交检测引擎实时标记被命中的 SVG `<path>` 元素，并在抬笔前的滑动窗口内通过 `A2` 极速刷新**将被命中曲线切换为虚线态（`stroke-dasharray: 4, 4`）或瞬时隐藏**，提供零延迟的擦除命中确认；抬笔后延时 `200 ms` 执行合并脏矩形局部 `Regal` 刷新，彻底清除残影。

### 5.4 伴读（Pagewise Companion）交互规范与流式聚合刷新

依据伴读设计规范（`companion-20261020.md`）与命名规范（`companion-naming.md`），模块中文界面统一命名为“伴读”，英文界面为“Companion”，代码命名空间统一为 `PagewiseCompanion`（向下兼容 `settings.pagewiseCompanion`、IndexedDB `lightread-dianjing` 及 `/v1/dianjing` 协议）：

- **三大伴读形态**：章节速览卡片（`PagewiseCompanionSkim.vue`，提炼核心命题与论证脉络）、结构化大纲（`PagewiseCompanionOutline.vue`）及划词/整段随页解析卡片（`PagewiseCompanionCard.vue`）。
- **动态坐标追踪与瞬时请求中断**：伴读浮层卡片基于当前选中文本 `Range`、视口滚动量与 `iframe` 偏移量实时计算锚点坐标（无需依赖高开销的 `ResizeObserver`）。支持显式关闭按钮、`Esc` 键（关闭后自动将键盘焦点归还阅读画布）及点击卡片外部区域关闭；一旦卡片关闭、切换选区或禁用伴读，立即通过 `AbortSignal` 终止未完成的网络/本地模型推理请求。
- **墨水屏流式输出聚合器（`EinkStreamAggregator`）**：大语言模型流式返回文本时，严禁每收到一个 Token 就更新 DOM。必须通过聚合缓冲池拦截输出，仅当满足 **累计缓冲 Token 数 `>= 18` 或 距上次绘制时间 `>= 650 ms`** 时才批量提交一次 DOM 更新并触发 `A2` 极速局部刷新；当流式传输结束（`onComplete`）时，自动追加 1 次局部 `Regal` 刷新清除 A2 噪点，确保文字边缘如印刷品般锐利。

## 6. BOOX EPD 刷新引擎调度矩阵与 Agent 工程整改清单

### 6.1 五档 EPD 硬件刷新模式调度矩阵（Refresh Engine Matrix）

为兼顾阅读静态画质与交互响应速度，系统通过 `onyxEpd` 服务按交互状态动态切换文石 EPD 刷新模式，并配合 **`50 ms` 窗口脏矩形合并（Union Dirty Rect）** 与 **全刷节流看门狗（每 15–20 页或章节切换触发 1 次全屏刷新，配 `300 ms` `waitForUpdateFinished()` 超时保护）**：

| EPD 刷新模式 | 底层 SDK 常量标识 | 灰阶深度与帧率 | 绑定的页面与交互场景 |
| :--- | :--- | :--- | :--- |
| **Regal 高清模式** | `EINK_MODE_REGAL` | 16 级灰阶 · 无黑闪去残影 | EPUB/PDF 正文翻页、章节切换、打开书籍详情、手写抬笔后矢量固化、AI 伴读流式输出完成后的最终重绘。 |
| **Speed 快速模式** | `EINK_MODE_EPD_SPEED` | 4–8 级灰阶 · 15–20 fps | 书架多页快速翻动、长目录（`TocList.vue`）与长笔记列表浏览；停止操作 `400 ms` 后自动切回 Regal 静态重绘。 |
| **A2 极速二值模式** | `EINK_MODE_EPD_A2` | 2 级纯黑白 · 延迟 `< 30 ms` | **按钮/卡片按下瞬态反白微反馈（`pointerdown`）**、搜索框打字输入、写想法草稿文字录入、手写橡皮擦虚线标记、伴读流式生成（每 `650 ms` / `18 Tokens` 批次）过渡渲染。 |
| **Direct Raw 硬件直写** | `setRawDrawingRenderEnabled` | 2 级黑白 · 硬件直通 `< 25 ms` | `OnyxInkLayer.vue` 电磁笔落笔至抬笔期间的实时轨迹绘制。 |
| **X-Mode 极限帧率模式** | `EINK_MODE_EPD_X` | 高噪点抖动 · 最高帧率 | 仅限 `PdfReaderView.vue` 双指连续缩放或大幅拖拽平移视口期间临时启用，松手后立即执行局部 Regal 刷新。 |

### 6.2 现有代码库与设计规范的一致性审计及 Agent 工程整改清单（S3 Remediation Roadmap）

通过对仓库现有设计规范文档与 `reader/src/` 及 Android 原生源码的交叉走查，识别出当前实现与 v2.1 规范基线之间存在 **6 项关键工程偏差（GAP-01 至 GAP-06）**，后续开发 Agent 须按以下优先级闭环修正：

| 审计编号与定位 | 规范要求（Target Spec） | 现有代码偏差（Current Code Gap） | Agent 工程落地整改方案（Actionable Fix） |
| :--- | :--- | :--- | :--- |
| **GAP-01（P0）：全局零动画与瞬态按压反白微反馈** | `design.md` 规定全局零动画（`0ms` 硬切），且交互控件按下瞬间需提供 `< 30ms` A2 反白/描边反馈。 | Web 阅读层部分抽屉与浮动面板仍保留 `transition: transform 0.2s ease`，且去动画后点击缺乏瞬时状态响应。 | 在 `reader/src/styles/main.css` 顶层注入 `*, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }`；为所有可交互元素绑定 `:active` 反白规则（`#000000` 底 + `#FFFFFF` 字）并触发单次 A2 刷新脉冲。 |
| **GAP-02（P0）：Web 端 PDF 伴读流式输出接入节流器** | BOOX 规范要求 AI 流式输出必须经过 `18 Tokens / 650 ms` 聚合缓冲，并以 A2 + 结尾 Regal 模式刷新。 | `PdfReaderView.vue` 与 `PdfReadingAssistant.vue` 在处理流式 Chunk 时仍按原始网络分片直接追加字符串，导致高频闪烁。 | 在 `usePagewiseCompanion.ts` 组合式函数中统一封装 `useEinkStreamBuffer(18, 650)`，拦截所有 SSE 数据流，在每次 Flush 前通知 `onyxEpd` 切入 A2 模式，并在 `finally` 钩子中触发单次局部 Regal 重绘。 |
| **GAP-03（P1）：Web 阅读器物理字号与热区启动校准** | 中文基准字号为 `12.5 pt`（300 PPI 下约 `26 CSS px`），行高 `1.70`，正文字重 `400`、标题 `600`；触控热区 `>= 8.0 mm`。 | 前端状态库（`stores/settings.ts`）初始默认值仍沿用桌面端 `18 CSS px`、行高 `1.8`，部分标题使用了 `700/800` 字重，且热区未接入物理毫米换算。 | 重构默认 Store：启动时读取 `TypographyCalibration.vue` 的物理校准系数计算默认字号（回退值设为 `24–26 CSS px`，行高 `1.70`），在全局样式表中将字重上限锁死在 `600`，并向 `:root` 注入 `--eink-hit-target-min` 与 `--eink-hit-gap-min`。 |
| **GAP-04（P1）：Web 与 Android 原生 7 级灰阶色值对齐** | 3.1 节要求 Web CSS 变量与 Android 原生色值 100% 统一，杜绝 `#FAFAFA` 在墨水屏上并阶为纯白。 | 原生层 `Color.kt` 使用 `#FAFAFA`、`#D4D4D4`、`#8C8C8C`，与 Web 层 `#EEEEEE`、`#BBBBBB`、`#777777` 存在跨端跳变。 | 同步修改 Android 原生 `Color.kt` 与 `colors.xml`，将 `SurfaceSubtle` 统一为 `#EEEEEE`、`SurfaceContainer` 为 `#DCDCDC`、`BorderHairline` 为 `#BBBBBB`、`TextMuted` 为 `#777777`、`TextSecondary` 为 `#444444`。 |
| **GAP-05（P1）：Tier 3 双语双栏与伴读分屏防挤压降级** | 2.2 节规定当正文容器可用物理宽度 `< 132 mm` 时，严禁维持左右双栏并排，须自动降级为上下交替。 | 10.3" 竖屏下同时开启“中英双栏并排”与“右侧 40% 伴读分屏”时，单栏被挤压至不足 12 个汉字。 | 在 `ReadingView.vue` 与 `stores/layout.ts` 中新增响应式计算属性 `effectiveBilingualLayout`：当 `isCompanionSplitOpen && remainingWidthMm < 132` 时自动切换为 `'stacked'`，并在关闭伴读或横屏时自动恢复 `'side-by-side'`。 |
| **GAP-06（P2）：视图感知型封面热区与手写擦除反馈** | 4.1 节与 5.3 节要求网格视图支持严格 Tap 封面打开、列表视图封面静态化；手写擦除需实时显示虚线命中态。 | `BookCard.vue` 在网格视图下封面完全不可点击引发挫败感；`OnyxInkLayer.vue` 橡皮擦划过时无即时视觉反馈。 | 在 `BookCard.vue` 中根据 `viewMode` 差异化挂载热区，网格态绑定 `v-eink-strict-tap`（`Δd < 4 dp`, `60–250 ms`）；在 `OnyxInkLayer.vue` 的相交检测回调中对命中 `<path>` 立即设置 `stroke-dasharray: 4, 4` 并触发 A2 局部刷新。 |

### 6.3 视觉与交互质量门禁（QA Acceptance Checklist，8 项硬性门禁）

任何涉及 UI、排版或阅读交互的 Pull Request 在合并前，必须通过自动化脚本（`scripts/Test-ReaderApk.ps1` 与 `scripts/Test-NoteX3Pro.ps1`，见 `device-admission.md`）及真机走查的 **8 项硬性门禁**：

1. **零光影与瞬态反白反馈**：全界面零阴影、零渐变、零 CSS 过渡动画（`0ms` 硬切），且所有交互控件按下瞬间具备 `< 30 ms` 的 A2 反白或 `2px` 实线内框反馈；
2. **跨端灰阶一致与高对比度**：Web 与 Android 7 级灰阶 Hex 色值 100% 对齐，正文与卡片按钮对比度 `>= 13.87:1`（E-Ink 实测达 `18.8:1–21:1`），全局字重严格限制在 `400–600`；
3. **物理字号与触控热区校准**：正文字号对齐 `12.5 pt`（`4.41 mm`），所有交互控件触控热区 `>= 8.0 × 8.0 mm`（`>= 48 × 48 CSS px`）且相邻热区物理隔离带 `>= 1.35 mm`（`>= 8 CSS px`）；
4. **视图感知封面防误触**：列表视图下封面图片非可点击热区（`pointer-events: none`），网格视图下封面挂载 `Δd < 4 dp` 且 `60–250 ms` 严格 Tap 判定器；
5. **复合视图防挤压重排**：Tier 3 设备在 10.3" 竖屏开启右侧伴读分屏（`W_remain < 132 mm`）时，中英双栏并排必须自动降级为段落上下交替，单栏行宽始终 `>= 22` 汉字；
6. **阅读器工具栏 7 项固定顺序**：阅读控制栏严格保持 `目录 → 搜索 → 书签 → 批注 → 伴读 → 朗读 → 排版` 7 项标准顺序；
7. **草稿优先、代际隔离与流式节流**：批注严格遵循“草稿优先 + Panel Epoch 代际绑定”，且 EPUB/PDF 流式伴读全量启用 `AbortSignal` 与 `18 Tokens / 650 ms` 聚合节流（A2 步进 + Regal 收尾）；
8. **文件解码鲁棒性与手写擦除反馈**：文件解码具备 `UTF-8` 至 `GB18030` 自动回退且未知 EPUB 语言标记归一化为 `und`（PW-12），电磁笔直写延迟 `< 25 ms` 且相交擦除具备实时虚线标记与抬笔 `200 ms` Regal 固化。

### 6.4 面向 Coding Agent 的核心代码实现契约（Reference Code Contracts）

后续开发 Agent 在修改 `reader/src/styles/main.css`、`stores/layout.ts` 与 `usePagewiseCompanion.ts` 时，必须严格对齐以下标准基线契约：

```css
/* 1. reader/src/styles/main.css — 跨端统一 7 级灰阶、物理热区与 0ms 硬切反白微反馈契约 */
:root {
  --eink-surface-pure:      #FFFFFF; /* Y15 纸白：画布主底色（Web & Android 统一） */
  --eink-surface-subtle:    #EEEEEE; /* Y14 极浅灰：卡片/工具栏底色（严禁使用 #FAFAFA） */
  --eink-surface-container: #DCDCDC; /* Y13 次级灰：高亮底纹/选中标签/代码块底纹 */
  --eink-border-hairline:   #BBBBBB; /* Y11 中浅灰：1px 实线分隔线/双栏中缝 */
  --eink-text-muted:        #777777; /* Y7  中性灰：禁用态/Placeholder（对比度 4.48:1） */
  --eink-text-secondary:    #444444; /* Y4  深炭灰：作者/页眉/进度元数据（对比度 9.74:1） */
  --eink-text-primary:      #111111; /* Y1  柔和墨黑：阅读正文 */
  --eink-solid-black:       #000000; /* Y0  纯黑：主标题/实心按钮/激活态描边 */
  --mm-per-css-px:          0.16933; /* 由 TypographyCalibration.vue 启动时按 M / C 覆盖 */
  --eink-hit-target-min:    max(48px, calc(8.0 / var(--mm-per-css-px) * 1px));
  --eink-hit-gap-min:       max(8px,  calc(1.35 / var(--mm-per-css-px) * 1px));
}

*, *::before, *::after {
  transition: none !important;
  animation: none !important;
  scroll-behavior: auto !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
}

.eink-hit-target {
  min-width: var(--eink-hit-target-min);
  min-height: var(--eink-hit-target-min);
}

.eink-hit-target:active,
.eink-hit-target.is-pressed {
  background-color: var(--eink-solid-black) !important;
  color: var(--eink-surface-pure) !important;
  outline: 2px solid var(--eink-solid-black) !important;
}
```

```typescript
// 2. reader/src/stores/layout.ts — Tier 3 复合分屏防挤压降级与物理字号计算契约
export function computeEffectiveBilingualMode(
  userMode: 'side-by-side' | 'stacked',
  isCompanionSplitOpen: boolean,
  viewportCssPx: number,
  mmPerCssPx: number
): 'side-by-side' | 'stacked' {
  if (userMode !== 'side-by-side') return 'stacked';
  const remainingRatio = isCompanionSplitOpen ? 0.58 : 1.0;
  const remainingWidthMm = viewportCssPx * remainingRatio * mmPerCssPx;
  return remainingWidthMm < 132.0 ? 'stacked' : 'side-by-side';
}

export function computePhysicalFontSizePx(targetPt: number, mmPerCssPx: number): number {
  const targetMm = (targetPt * 25.4) / 72.0;
  return Number((targetMm / mmPerCssPx).toFixed(2));
}
```

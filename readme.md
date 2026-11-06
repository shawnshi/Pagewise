<p align="center">
  <img src="reader/public/pagewise-logo.png" width="160" alt="知页阅读器 · Pagewise 项目 Logo">
</p>

# 知页阅读器 · Pagewise

面向文石（Onyx BOOX）Android 墨水屏设备的本地阅读应用。当前版本为 **2.3.0**，Android 版本码为 **2003000**。

项目专为 BOOX Android 设备设计与调优。浏览器仅用于前端组件开发与单元测试，不提供桌面、iOS 或 PWA 发行版。

## 当前状态

2.3.0 已在 **Note X3 Pro（Android API 32, Carta 1200 墨水屏）** 上完成构建与验证：

| 变体 | 桌面显示名称 | 包名 | 下载 |
|---|---|---|---|
| Release | 知页 | `io.pagewise.reader` | [Pagewise-2.3.0-release.apk](https://github.com/shawnshi/Pagewise/releases/download/v2.3.0/Pagewise-2.3.0-release.apk) |
| Debug | 知页 2.3.0 测试版 | `io.pagewise.reader.debug` | [Pagewise-2.3.0-debug.apk](https://github.com/shawnshi/Pagewise/releases/download/v2.3.0/Pagewise-2.3.0-debug.apk) |

### 校验信息 (SHA-256)
- **Release APK (`Pagewise-2.3.0-release.apk`)**:
  `2d1b807d929c24991316f633d22e03bd68b8887858690799e24a7d90001abb00`
- **Debug APK (`Pagewise-2.3.0-debug.apk`)**:
  `9fb019e901077b0b76975afe1ccad82f1b3321f52a6b4a12b8941d129a4db872`

### 2.3.0 核心演进：AI 原生个人阅读管理器、二级著录元数据补全与供应链精简

本版在 2.2.0 双平面视觉统一的基础上，完成了向 AI 原生个人阅读管理器的全链路演进、原生层交互对齐与底层依赖瘦身：

1. **二级渐进著录元数据补全与 CAS 快照校验**：在书籍详情页支持对作者、出版社、出版日期、语种发起“第一级：开放书目并发检索（OpenLibrary / Google Books / 豆瓣读书 API，支持 `AbortSignal` 超时取消）”与“第二级：AI 著录推理补全”；提供「仅补全空白字段」与「覆盖已有字段」双模式、墨水屏黑白反色差异徽章预览及 IndexedDB / SQLite 原子快照一致性（CAS）校验。
2. **AI 原生阅读管理闭环（P0–P2）**：
   - **单书批注聚类综述与结构化导出（P0）**：将单书零散划线与想法按论点聚类为结构化综述（核心摘要、主题簇、认知启发），支持一键复制或导出带 `CFI` 锚点与原书跳转路由的 Markdown 读书笔记；
   - **跨周期断点前情提要（P1 Catch-up）**：在读列表展示搁置天数唤醒徽章，详情页提供前情提要卡片，结合进度、TOC 目录与最近标注生成脉络回顾与续读衔接建议；
   - **跨书观点对比矩阵与主题阅读路径规划（P2）**：支持勾选 2–4 本藏书生成共识、分歧与立场边界对照矩阵；支持按研究课题从本地藏书中规划阶梯式阅读序（Syllabus）并一键存为书架书单。
3. **墨水屏 4 种划线线型语义与定高步进翻页**：全局笔记视图支持「时间流 / 按书聚合」双模切换，将黑白屏无法区分的彩色高亮映射为 `实线·重点`、`双线·核心`、`虚线·存疑`、`底纹·概念` 四种墨水屏线型；详情页目录、阅读记录、全局笔记及选书网格全面采用定高步进分页，消除滚动拖影。
4. **统一双平面视觉语法与馆藏著录卡**：原生层新增 `pillBadge` 实体徽章，书籍详情页（`renderBook`）升级为双线 Ex Libris 馆藏档案卡（移除重复冗余的静态标签行），中图法索书号改为高对比度馆藏徽章，并同步补齐原生端前情提要、笔记导出与跨书对比对话框。
5. **PDF 阅读器顶栏认知减负与零合成闪烁浮层**：在顶栏版式控制台（`zoomMenu`）统一集成 `滚动/翻页` 及 `单页/双页/书籍视图`；彻底清除阅读器外围抽屉与浮层的 `backdrop-filter: blur` 高斯模糊与弥散阴影，杜绝离屏帧缓冲合成闪烁。
6. **在读页 7 段分段控制器主次解耦与原生设置原位切换**：将高频主工作流与归档流解耦，原生设置行提供 `● 开启 / ○ 关闭` 1 步原位切换；引入墨水屏静态线框骨架屏（Static Wireframe Skeleton），消除异步重排跳动。

### 2.1.0 核心演进：全系统视觉降噪、零位移渲染与排印深度重构

本版在 2.0.0 墨水屏原生化的基础上，针对真机物理呈现与复杂书籍排印做出了全方位的视觉降噪与体验升维：

1. **消除 N+1 异步列表跳变（Zero-CLS Instant Hydration）**：彻底重构藏书与在读列表加载流，分页查询直出等高完整卡片，规避了逐行替换导致的严重版面跳动（Layout Shift）与墨水屏连续全刷残影；同时清洗劣质元数据中的公元 101 年或 1970 年等无效时间戳与原始 ISO 字符串。
2. **原生 Markdown 简介格式化解析**：书籍详情页「简介」内建轻量化语法渲染器，将 AI 生成或导入摘要中的 `#` 标题、`**加粗**` 重点与列表符直接转为思源宋体加粗和层次分明的印刷版式，消除源码字符裸露。
3. **正文阅读器视口防截断与底部避让**：校准 Foliate 渲染容器的底部安全内边距（`typographyBottomInset` 保底扩充），彻底解决呼出底栏或滚动翻页时正文最后一行文字被拦腰裁切的物理缺陷。
4. **AI 伴读一键预设胶囊**：阅读助手侧栏空状态新增「提炼本页核心论点」、「梳理当前论证脉络」、「解析本页核心概念」三个高对比度实体按键，支持免打字、单手快速发起深度随页理解。
5. **工程控件静默收敛（De-cluttering）**：将常驻主界面的「核对设置提交 / 恢复」与「返回设置目录」等调试级通栏大按钮收纳为异常时才触发的自适应横幅，主界面视觉重心全面归还阅读内容。
6. **书籍详情与笔记动线重塑**：详情页重构为「简介与分类优先」阅读动线，操作按键紧凑同行排列；「全部笔记」按书分组卡片内直接预览最新高亮金句与想法，无需逐层点击深入。
7. **发丝分割线与设置双栏对齐**：列表卡片外框降噪为 1dp 细线，设置页每行增设发丝分割线（Hairline Rule），优化 10.3 英寸大屏扫视引导。

### 2.0.0 核心演进：全系统 E-ink 典藏级排印与交互重构

本版在保持 100% 既有功能与存储安全边界的前提下，全面升级为针对 300 PPI Carta 墨水屏物理特性的专属设计体系：

1. **16 级安全灰阶色板 (Carta Grayscale Palette)**：定义纯白纸面（`#FFFFFF`）、装裱浅灰（`#EEEEEE`）、轻选中灰（`#DDDDDD`）、发丝分割线（`#BBBBBB`）、次级辅助灰（`#777777`）、次要元数据（`#444444`）、正文浓墨（`#111111`）与纯黑印墨（`#000000`）。严格基于 4-bit 硬件色阶（`0x11` 步进）取值，彻底移除彩色半透明遮罩与微透明模糊，杜绝 GPU 抖动算法导致的网点麻点（Dithering Artifacts）。
2. **装裱式封面规制 (Archival Cover Plate)**：书架与在读列表封面统一规制为 3:4 经典开本比例，外围包裹纯黑细线并衬以 3dp `#EEEEEE` 浅灰衬纸装裱槽，彻底解决浅色/纯白封面融入背景或深色封面发乌的缺陷。
3. **人文衬线排印与十维索书码 (Editorial Typography & Call-Numbers)**：全系统页面标题、书名、章节标题与引文长文本升级为思源宋体粗体（`Typeface.SERIF, Typeface.BOLD`）；学科分类全面支持中西文十维索书码规范（如 `文学与语言 [LIT]`、`计算机与AI [CSI]`），数字、日期与进度强制启用等宽对齐（`tnum`）。
4. **单层平铺在读工作台 (Single-Deck Reading Queue)**：彻底消除双层嵌套 Tab，移除冗余的独立「书目」切换盒，将「推荐」作为第 7 态自然顺延至「弃读」右侧，形成 `在读 → 最近阅读 → 想读 → 暂缓 → 已读 → 弃读 → 推荐` 单层无缝切换轴；在读队列首位自动升级为双线装裱的「焦点在读主翻台（Hero Active Session）」。
5. **精装书口进度刻度规 (Fore-edge Gauge)**：详情页、在读页与书籍排行榜全面启用仿实体书切口刻度尺，内嵌 `25% / 50% / 75%` 垂直微刻度线，以实心黑块已读、纸质底色未读与等宽数字展示沉浸厚度手感。
6. **纯净度量看板与 4 宫格里程碑 (Archival Ledger & Milestones)**：阅读统计页面彻底移除视觉杂质按钮（「如何计时」与「核对恢复」隐式保留底层恢复安全契约），顶层视觉重心完整归还 `[概览 | 趋势 | 年历]` 主导航；里程碑全面升级为 2×2 规整指标卡（累计时长、活跃天数、最长连续、单日最长/读得最久）；零数据状态统一为 `INDEX // EMPTY LEDGER` 双线藏书票卡片与雕版尾花。
7. **中英文混排实时校准沙盒 (Live Typography Sandbox)**：设置页阅读排版专区首屏常驻高保真中英混排样张（*“在现代数字阅读 (Digital Typography) 中……”*），直观实时映射字号（13~24px）、行高倍率（1.3~2.2x）与盘古自动间距（CJK-Latin Spacing），无需反复进出正文即可直观调校。
8. **沉浸式阅读器与 AI 伴读硬边框规制 (Zero-Ghosting Canvas & E-Ink Companion)**：全局注入 `.pagewise-eink .bar`、`.fs-exit` 与 `.dj-card` 墨水屏规范，禁用弥散阴影与高斯模糊；伴读卡片与阅读助手采用 2px 纯黑直角实线外框配 3dp 垂直引文描边，彻底消除文石 Regal/Normal 模式下的灰阶残影。
9. **书籍详情著录与推荐链路重构**：顶部著录区统一规范为 `作者 · 出版时间` 紧随 `书名` 之后，移除冗余的监控文件夹提示条；推荐卡片统一为 `书名 · 作者` 与 `来源 → 推荐理由` 连贯链条。
10. **硬朗直角与零动画响应**：全局控件圆角收敛为 0dp 直角与 2dp 典藏微倒角，动效时长锁定为 0ms，彻底消除所有引起墨水屏残影的平滑补间。

## 功能范围

- **原生管理页**：藏书、正在阅读、书籍详情、全部笔记、阅读统计、设置、使用手册全部基于 Android 原生 View 与受控布局，避免 WebView 渲染延迟。
- **书库管理**：授权目录监测（SAF）、原生书目与封面提取、分类/书架管理、复合高级筛选、分页翻阅及批量多选管理。
- **正文阅读**：支持 EPUB、MOBI、PDF、TXT、Markdown 原生解析与阅读，包含目录（TOC / Smart TOC）、版式调节、阅读进度记忆（CFI / 页码）、全文检索与划线批注。
- **书籍简介与二级著录补全 (AI & Open Catalog CAS)**：支持并发查询 OpenLibrary、Google Books、豆瓣读书公开书目与 AI 著录推理补全；按最小书目信息请求 AI 生成简介或元数据，显式确认后以快照 CAS 原子写入，不发送正文或批注。
- **AI 原生阅读管理 (P0–P2)**：覆盖断点前情提要（Catch-up）、单书批注聚类综述与带 CFI 锚点的 Markdown 导出、跨书观点对比矩阵（Dialectical Matrix）以及本地藏书主题阅读路径规划（Syllabus Builder）。
- **本地馆藏推荐**：在正在阅读、书籍详情及书末展示相关书籍推荐，基于本地分类、主题与作者匹配，不依赖外部向量服务。
- **阅读度量与年历**：概览看板、阅读时长趋势直方图、4 级黑白几何年历热力图，保留精确到秒的本地阅读流水账。
- **伴读与助手**：章节理解、选段提问、分层阅读；支持 OpenAI、DeepSeek、Gemini、OpenRouter 等用户自有 API 端点。
- **BOOX 硬件桥接**：深度适配文石硬件翻页按键、墨水屏局部/全局刷新、手掌防误触与前光调控。

## 架构与数据

| 层级 | 主要实现 | 职责 |
|---|---|---|
| 原生管理界面 | Kotlin、Android Views | 藏书管理、阅读状态流转、详情卡片、笔记归档与设置控制 |
| 正文阅读与排版服务 | Vue 3、TypeScript、Vite、foliate-js | EPUB/PDF 正文渲染、双语混排、阅读器视窗与排版预设 |
| 应用容器与本地桥接 | Tauri 2、Rust、NDK aarch64 | Android 平台生命周期、底层 SQLite、文件 I/O 与安全 IPC |
| 存储与系统能力 | SQLite (`lightread.db`)、Android SAF、Onyx SDK 桥接 | 统一本地数据库、只读目录监测、TTS / MediaSession 调度 |

### 项目结构

```text
Pagewise/
├── readme.md                   # 项目总说明
├── design.md                   # 墨水屏核心设计规范
├── boox_native_reader_design_specification.md # 文石原生阅读器规范
├── docs/                       # 架构设计与通用开发指南
│   ├── deployment.md           # 部署与签名全流程
│   ├── device-admission.md     # 真机准入检查项
│   ├── deployment-1.9-status.md# 1.9.0 基线回执
│   └── archive/                # 历史版本部署与修复归档
│       ├── deployments/        # 1.1 ~ 1.8 部署回执
│       ├── historical-fixes/   # 历史现场修复与临时审计
│       └── upstream-plans/     # 上游云端旧方案归档
└── reader/
    ├── package.json            # 前端依赖与 Android 构建脚本
    ├── src/                    # Vue 界面、服务与样式
    ├── src-tauri/
    │   ├── src/                # Rust 命令与容器逻辑
    │   ├── android/            # 受管 Kotlin 模板与原生 Views
    │   ├── gen/android/        # 本地生成的 Android Gradle 工程
    │   ├── Cargo.toml
    │   └── tauri.conf.json
    └── scripts/                # 准备、构建检查与测试套件
        └── archive/            # 历史过渡验证脚本归档
```

## 开发与构建

### 依赖环境
- Node.js (>= 20)、npm
- Rust (>= 1.87) 及 Android 交叉编译目标：`rustup target add aarch64-linux-android`
- OpenJDK 21 (推荐 Microsoft Build of OpenJDK 21)
- Android SDK (API 36, Build-Tools 36.0.0) 及 Android NDK (`30.0.16248370`)
- LLVM-MinGW 工具链 (Windows 平台下用于 proc-macro 与本地工具链接)

### 构建命令

```bash
cd reader
npm ci

# 前端构建检查
npm run build

# 准备原生模板、版本属性及两版名称
npm run android:prepare

# 构建 Debug 与 Release APK
npm run android:build
npm run android:build:release
```

编译产物生成于：
- `reader/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
- `reader/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
（历史或独立 ABI 产物亦保留于同级 `arm64/` 目录）

### 侧载部署至 BOOX 设备

```bash
adb install -r <app-arm64-release.apk>
adb install -r <app-arm64-debug.apk>

# 若受 BOOX 系统冻结策略影响，可显式启用：
adb shell pm enable io.pagewise.reader
adb shell pm enable io.pagewise.reader.debug
```

## 隐私与安全

知页为纯本地优先的单机离线阅读器。所有藏书文件、阅读进度、笔记和统计数据均持久化在设备本地 SQLite 数据库或用户指定的监控目录中。启用 AI 功能时，仅发送用户明确选中的书目信息或选段文本至用户配置的私有 API 端点，本地密钥与书库绝不外传。

项目仓库：[shawnshi/Pagewise](https://github.com/shawnshi/Pagewise)。

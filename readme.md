<p align="center">
  <img src="reader/public/pagewise-logo.png" width="160" alt="知页阅读器 · Pagewise 项目 Logo">
</p>

# 知页阅读器 · Pagewise

面向文石（Onyx BOOX）Android 墨水屏设备的本地阅读应用。当前版本为 **2.0.0**，Android 版本码为 **2000000**。

项目专为 BOOX Android 设备设计与调优。浏览器仅用于前端组件开发与单元测试，不提供桌面、iOS 或 PWA 发行版。

## 当前状态

2.0.0 已在 **Note X3 Pro（Android API 32, Carta 1200 墨水屏）** 上完成构建与真机部署：

| 变体 | 桌面显示名称 | 包名 |
|---|---|---|
| Release | 知页 | `io.pagewise.reader` |
| Debug | 知页 2.0.0 测试版 | `io.pagewise.reader.debug` |

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
- **书籍简介 (AI CAS)**：按最小书目信息请求 AI 生成简介，支持预览、编辑或复制；显式确认后以 CAS 替换，不发送正文或批注。
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
- `reader/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`
- `reader/src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk`

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

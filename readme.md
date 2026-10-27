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

1. **16 级安全灰阶色板 (Carta Grayscale Palette)**：定义纸白（`#FFFFFF`）、晨雾灰（`#F0F0F0`）、水泥浅灰（`#D6D6D6`）、铅笔深灰（`#9E9E9E`）、碳素中灰（`#5A5A5A`）、浓墨深黑（`#121212`）与纯黑印墨（`#000000`）。彻底移除彩色半透明遮罩与浅灰底块，杜绝 GPU 抖动算法导致的网点麻点（Dithering Artifacts）。
2. **装裱式封面规制 (Framed Cover Plate)**：书架与在读列表封面严格锁定 1:1.414 经典开本比例，外围包裹 1dp 发丝线并衬以 2dp 浅灰衬纸，解决彩色封面转黑白后边缘发虚的缺陷。
3. **人文衬线宋体排印 (Editorial Serifs)**：书架书名、正文标题与简介长文本升级为思源宋体粗体（`Typeface.SERIF, Typeface.BOLD`），与无衬线元数据形成严密的古典出版物主次对比。
4. **反相矩阵选项卡与通栏分页规**：选项卡激活态采用纯黑底白字反相高亮，零灰阶拖影；书架与列表底部采用左右对齐的通栏书口分页条（`1 / 1 · 共 N 册`）。
5. **实体图书检索盒 (Archival Search Box)**：白底发丝线卡片盒内嵌几何矢量放大镜与清除按键，告别单薄悬空的下划线输入。
6. **精装书口进度刻度规 (Fore-edge Gauge)**：详情页与在读页全面启用仿实体书切口刻度尺，以实线已读、浅灰未读与等宽数字展示沉浸进度。
7. **硬朗微倒角与零动画**：全局圆角严格收敛为 2dp 典藏微倒角，动效时长锁定为 0ms，消除所有引起残影的平滑补间。

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

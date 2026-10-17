# 知页阅读器 · Pagewise

> 专注阅读，随页理解。

<p align="center"><img src="Pagewise.png" alt="知页标志" width="160"></p>

面向文石 Note X3 Pro 的个人本地阅读器，基于 [LightRead v1.15.0](https://github.com/yzfly/LightRead/tree/v1.15.0) 开发。Android 桌面名称为“知页”。

**项目处于开发阶段，仅面向 Android；尚无通过目标机验收的知页 APK。** 浏览器预览用于开发，不是桌面、PWA 或 iOS 发行版。

## 当前能力

- **藏书**：保留 EPUB、MOBI、PDF、TXT、Markdown；组合搜索、标签与格式/语言/阅读状态筛选、分页及有界封面缓存。点击书目查看详情，独立“阅读/继续”按钮直接进入正文。
- **阅读工作流**：在读、最近阅读、搁置与已读分组；返回时恢复列表查询与页码。显式阅读状态不由进度百分比推断，旧书缺失状态保留未知。
- **排版**：中英文语言预设与单书覆盖、草稿预览、出版原貌/自动优化/兼容修复。应用后恢复文本锚点；失败回滚并保留草稿。未知语言不自动归为中文。
- **来源与笔记**：脚注/引用的临时查看与主阅读位置分离；全局笔记可回到原书。未提交的想法作为本机草稿恢复，不能冒充正式保存成功。
- **墨水屏界面**：高对比列表、底部导航、简化动效；保留普通主题切换。
- **保留服务**：普通 AI/翻译、系统/Edge 听书、本地书单/标签、批注与阅读统计。部分服务需要联网，不宣称应用完全离线或无外联。

已移除在线书源、Calibre、账号/同步、设备互传、应用内更新、BabelDOC、歌词和论文 CLI Agent。历史退役格式记录不会自动删除，但不再提供其导入/打开入口。没有原生手写、NeoReader 批注迁移或已完成的 PDF 引擎重构。

## 验证状态

- 前端生产构建及合成数据回归已通过；新增流程覆盖筛选取消、排版失败回滚、列表恢复、脚注返回、草稿恢复及存储失败保护。
- 4000 条合成书目的查询与封面池检查已通过；这不等于 Note X3 Pro 的性能、残影或耗电验收。
- Android Rust 库和 Gradle `buildSrc` 已编译；APK 打包尚未完成，**未安装到目标设备**。
- 实际浏览器端到端以合成 EPUB/TXT 为主；不将格式入口检查当成全部格式的真机验收。未调用真实 AI、翻译或听书服务完成本轮验收。

实现与验收边界见 [UI v0.2 集成记录](docs/ui-v02-implementation.md)、[Android-only 说明](docs/android-only.md)、[设备准入](docs/device-admission.md)。

## 项目结构

- `reader/`：Vue、TypeScript、Tauri 应用源码及测试；当前源码版本沿用 `1.15.0`，不表示与上游发行物相同。
- `docs/`：架构、实施与设备准入文档。
- `scripts/`、`tests/`：PowerShell 设备/APK 只读准入及合成夹具检查。
- `Pagewise.png`：品牌原图；生成脚本在 `reader/scripts/`。

`.cache/`、`artifacts/`、`.worktrees/`、构建产物和个人数据不作为源码发布。下载的上游 APK 不是知页安装包。

## 本地开发

建议使用 Node.js 22.18+。在 `reader/` 目录执行：

```sh
npm ci --ignore-scripts
npm run dev
npm run build
npm run test:android-only
npm run test:library
npm run test:feature-trim
node --experimental-strip-types --test scripts/test-ui-v02-navigation.mjs scripts/test-ui-v02-transactions.mjs scripts/test-ui-v02-review-fixes.mjs
```

`npm run build` 只生成 Android WebView 共用的前端资源，不生成 APK。更多开发命令见 [应用 README](reader/README.md)。

## Android 构建与准入

需要 JDK 21、Android SDK API 36、兼容的 NDK，以及 Rust `aarch64-linux-android` 目标。本机 Android Studio 附带的 Java 25 与当前 Gradle 8.14.3 不兼容；为构建进程选择 JDK 21，不必修改系统默认 Java。

在 `reader/` 中执行：

```sh
npm run android:init -- --ci --skip-targets-install
npm run android:prepare
npm run android:build
```

构建命令使用 ARM64 调试配置。正式包标识为 `io.pagewise.reader`，调试标识为 `io.pagewise.reader.debug`。安装前检查包名、签名、ABI 和权限；不得通过卸载、清数据或覆盖未知签名应用绕过兼容性问题。

项目根目录的只读检查：

```powershell
pwsh -NoProfile -File tests/admission.tests.ps1
pwsh -NoProfile -File tests/fixtures.tests.ps1
pwsh -NoProfile -File scripts/Test-NoteX3Pro.ps1
```

设备元数据检查通过，不代表正文渲染、字体、选区、系统返回、休眠恢复及保存链路通过。发布工作流目前保留在 `reader/.github/workflows/`，尚未接入根仓库的 GitHub Actions；启用发布 CI 和正式发布另行处理。同步源码到 `main` 不会发布安装包。

## 源码仓库

目标仓库为 [shawnshi/Pagewise](https://github.com/shawnshi/Pagewise)，主分支为 `main`。在项目根目录管理提交；`reader/` 按普通源码目录跟踪，本地保留的上游 Git 元数据不上传，也不作为子模块发布。不要向本地 `reader/origin` 的上游 LightRead 仓库推送。

## 来源与许可

保留目标仓库已有的根 [LICENSE](LICENSE)，不改写其许可文本。`reader/` 衍生应用保留 LightRead（yzfly / 云中江树）署名，遵循其 [AGPL-3.0-or-later](reader/LICENSE)；根许可证不替代该上游授权。不复用上游私有签名材料或账号配置，不修改其已部署服务与历史发行物。

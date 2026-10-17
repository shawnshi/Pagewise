# 知页阅读器 · Pagewise

> 专注阅读，随页理解。

<p align="center"><img src="public/pagewise-logo.png" width="120" alt="知页标志"></p>

面向文石 Note X3 Pro 的本地阅读器，基于 [LightRead v1.15.0](https://github.com/yzfly/LightRead/tree/v1.15.0) 开发。**只面向 Android，仍处于开发阶段；尚无通过目标机验收的知页 APK。**

- 应用名称：知页；包标识 `io.pagewise.reader`，调试包后缀 `.debug`。
- 源码版本沿用 `1.15.0`；上游原版 APK 不是知页发行物。
- 保留 EPUB、MOBI、PDF、TXT、Markdown，以及普通 AI/翻译、系统/Edge 听书、书单/标签、批注与统计。联网服务需要相应配置，不保证完全离线。
- 不再提供桌面、PWA、iOS、在线书源、Calibre、账号/同步、设备互传、应用内更新、歌词、BabelDOC 或论文 CLI Agent。

## UI v0.2

- 藏书采用列表、独立详情/阅读入口；筛选使用可取消草稿，支持分页和返回状态恢复。
- 在读/最近阅读/搁置/已读分组；阅读状态与百分比独立，遗留未知状态不被强制改写。
- 中英文预设与单书覆盖；排版预览不修改正文，明确应用后才提交，布局或定位失败时回滚。
- 脚注/引用临时查看不写主阅读进度；全局笔记提供原文定位与本机未提交草稿恢复。
- 墨水屏模式使用高对比应用壳和底部导航；关闭后恢复原主题。

批量操作显示部分失败，并仅保留失败项目供重试。永久删除不是回收站；本机草稿也不等于正式笔记。

## 本地开发与检查

建议 Node.js 22.18+。在本目录运行：

```sh
npm ci --ignore-scripts
npm run dev
npm run build
npm run preview
npm run test:android-only
npm run test:library
npm run test:feature-trim
node --experimental-strip-types --test scripts/test-ui-v02-navigation.mjs scripts/test-ui-v02-transactions.mjs scripts/test-ui-v02-review-fixes.mjs
```

浏览器只作开发预览。`build` 执行 Vue/TypeScript 检查并生成共享前端资源，**不生成 APK**。阅读状态往返测试使用独立的合成 SQLite 数据库，不打开实际书库。

### 可选浏览器回归

UI v0.2 端到端测试只使用生成的 EPUB/TXT，阻断离站请求。需已有 Python 3.11+ 及 Playwright 可用的浏览器（Windows 使用本机 Edge），不会自动下载浏览器或读取实际书库：

```sh
python -B scripts/create-ui-v02-fixtures.py
node --experimental-strip-types scripts/e2e-ui-v02.mjs
```

合成夹具、报告和截图写入项目根目录 `.cache/ui-v02-20261017-01/`，不提交到 Git。

## Android 工程

需要 JDK 21、Android SDK API 36、兼容的 NDK、Rust 及 `aarch64-linux-android` 目标。当前 Gradle 8.14.3 不支持本机 Android Studio 附带的 Java 25；请为构建进程指定 JDK 21。

```sh
npm run android:init -- --ci --skip-targets-install
npm run android:prepare
npm run android:dev
# ARM64 调试 APK；不是已签署验收的正式发行版
npm run android:build
```

`--skip-targets-install` 避免初始化时自动安装其他 Rust 目标。`android:prepare` 校验输入并更新名称、图标及 MainActivity；保留联网和文件访问能力，移除应用更新安装权限。它不是 APK 编译或零外联证明。

本目录保留的 `.github/workflows/release.yml` 定义标签/人工发布，但尚未接入 Pagewise 根仓库的 GitHub Actions。启用发布 CI 需另行配置项目所有者自己的固定签名；不要读取、借用或提交上游私有签名材料。推送 `main` 不会自行发布 APK。

## 验证边界

前端构建、合成数据回归和浏览器交互已通过；4000 书目查询/封面池检查不是目标机性能验收。原生 Rust 库与 `buildSrc` 已编译，**APK 打包、安装与 Note X3 Pro 实机 UI 验收尚未完成**。不要通过卸载、清数据或覆盖旧应用绕过签名和迁移问题。

本轮没有使用私人书籍/笔记，也没有以真实 AI、翻译或听书请求作为测试。全局笔记采用聚合读取，时间与内存仍随标注数量增长。

若在完整 Pagewise 目录中开发，更多边界见 [项目说明](../readme.md)、[UI 集成记录](../docs/ui-v02-implementation.md) 和 [设备准入](../docs/device-admission.md)。部分上游历史文档及应用内手册不代表当前平台或发行承诺。

## 来源与许可

保留 LightRead（yzfly / 云中江树）署名、[AGPL-3.0-or-later](LICENSE) 和第三方许可。移除本地退役服务源码不等于删除或修改上游已部署服务与历史安装包。

# 知页阅读器 · Pagewise

基于 [LightRead v1.15.0](https://github.com/yzfly/LightRead/tree/v1.15.0) 的 Android 阅读应用，面向文石 Note X3 Pro。源码版本沿用 `1.15.0`，不代表已正式发行。

**当前仅面向 Android。浏览器是开发预览与测试环境，不是独立 Web/PWA 产品；没有正式发行的知页 APK。**

## 当前产品边界

- Android SAF 只读目录授权、持久化授权描述、前台增量监测和源文件引用。不提供源文件写入/删除接口，不用“空目录”掩盖权限或 IO 错误。
- EPUB、MOBI、PDF、TXT、Markdown 阅读；TXT/Markdown 通过保留的内部适配路径进入阅读器。普通 PDF 保留 PDFium 与 MuPDF 引擎。
- 搜索、标签、组合筛选、分页、独立阅读状态与进度，以及列表返回状态恢复。书籍信息包含作者、标签、出版社和精度不扩充的出版日期。
- 中英文排版、书内搜索、划线/笔记、阅读锚点与草稿保护。源文件缺失不删除书目、笔记或手工标签。
- 所有常规页面采用底部五入口，图标与文字常显，内容独立滚动并避让安全区；阅读路由隐藏主导航。阅读工具栏窄屏分行，采用不透明背景。
- AI 端点和提供商配置相互隔离；Gemini 预设默认模型为 `gemini-3.8-flash`。保留听书和阅读模式，但真实服务可用性不由配置或 mock 测试保证。

已退役书单、手动导入、显式 EPUB 转换和论文专用工作区，也不提供桌面/iOS、账号与云端同步产品。旧数据库、归档字段和必要路由兼容并未随入口退役而删除；普通 PDF 与 TXT/Markdown 阅读适配仍然保留。

## 目录与存储

首次使用从藏书页或设置授权监测目录。监测目录是书籍源，不是数据库根目录。来源书籍通过受目录授权约束的引用读取，不整本复制进应用；重复扫描不重建相同文档的书目，不覆盖已有手工信息。

完整、无错误且来源身份未变的扫描才能将未发现的文件标记为缺失。权限丢失、部分枚举和读取失败均保留错误语义。跨设备恢复归档不会重绑定另一台设备的 SAF 引用，需在目标设备重新授权目录。

## 开发

建议 Node.js 24+；Vite 的实际要求为 `^20.19.0 || >=22.12.0`。在本目录运行：

```sh
npm ci
npm run dev
npm run build
```

`build` 执行 Vue/TypeScript 检查及前端打包。Android 还需要 JDK 21、SDK API 36、兼容 NDK 和 Rust Android ARM64 目标：

```sh
npm run android:init -- --ci --skip-targets-install
npm run android:prepare
npm run android:dev
npm run android:build
```

常规调试包为 `io.pagewise.reader.debug`。合成验收使用单独的 `io.pagewise.reader.acceptance.v03.debug`，不覆盖原应用、不恢复其数据。通用构建命令不会自动建立此隔离身份；不要把普通调试包当作隔离验收包。

`src-tauri/gen/`、构建输出、依赖、缓存和本地验收报告不作为源码交付。初始化/准备步骤生成 Android 工程；原生模板位于 `src-tauri/android/`。

## 测试

```sh
npm run test:android-only
npm run test:library
npm run test:feature-trim
node --experimental-strip-types --test scripts/test-ui-v02-navigation.mjs scripts/test-ui-v02-transactions.mjs scripts/test-ui-v02-review-fixes.mjs
node --test scripts/test-ui-label-visibility.mjs
```

真实页面测试使用 Playwright 与本机 Edge、新浏览器上下文和合成数据，阻止外部请求，不使用个人浏览器配置；按脚本配置准备浏览器，不自动安装或升级依赖。`UI_LABEL_RUN` 可指定未使用过的结果目录名，避免覆盖旧证据。

最新底部导航改动通过 63 项定向 host 回归、10 个真实页面场景与目标机 3 项检查。覆盖宽窄屏、中英文、明暗主题、墨水屏布局、安全区、内容滚动不遮挡、选中态、阅读时隐藏导航和阅读锚点。

其他功能的基线结果与尚未验证项目见 [验证状态](../docs/validation-status.md)。历史流程记录见 [UI v0.2 历史快照](../docs/ui-v02-implementation.md)，不将其视为当前安装包的完整验收。正式安装前遵循 [设备准入](../docs/device-admission.md)。

## 来源与许可

保留 LightRead（yzfly / 云中江树）署名、[AGPL-3.0-or-later](LICENSE) 和第三方许可。移除退役服务的本地源码不等于修改上游已部署服务或历史发行物；不复用上游签名材料、账号或部署配置。更多项目边界见 [根目录说明](../readme.md)。

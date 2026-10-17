# 知页阅读器 · Pagewise

> 专注阅读，随页理解。

<p align="center"><img src="Pagewise.png" alt="知页标志" width="160"></p>

面向文石 Note X3 Pro 的个人本地阅读器，基于 [LightRead v1.15.0](https://github.com/yzfly/LightRead/tree/v1.15.0) 开发。Android 桌面名称为“知页”。

**目前仅面向 Android，仍处于开发与验收阶段。已有独立合成实机调试包，尚未正式发行；浏览器只用于开发预览和测试。**

## 当前功能

- **文件夹书库**：通过 Android 系统选择器授权一个书籍目录，启动、返回前台及前台监测时增量扫描。书籍引用源文件，不整本复制进应用；应用不修改或删除源文件。
- **阅读与元数据**：支持 EPUB、MOBI、PDF、TXT、Markdown。保留 TXT/Markdown 内部阅读适配；显示作者、标签、出版社和原始精度的出版日期，未知信息明确标示。
- **书库操作**：搜索、标签和组合筛选、分页、独立阅读状态、阅读进度及返回列表后的状态恢复。源文件缺失时保留书目、笔记和手工信息。
- **阅读与笔记**：中英文排版、目录、搜索、划线和笔记；排版修改、阅读锚点、系统 Back 和草稿恢复均有相应保护。
- **界面**：所有常规页面统一使用底部五入口——藏书、在读、笔记、阅读记录、设置。图标配常显文字，内容不被导航遮挡，并避让系统安全区；阅读时隐藏主导航。
- **可选服务**：保留兼容 AI 端点、听书及阅读模式。Gemini 预设默认填写 `gemini-3.8-flash`；模型和端点可用性需自行确认，配置值不代表服务验收。

当前不再提供书单、手动导入、显式 EPUB 转换或论文专用工作区。历史数据与旧路由保留必要兼容；普通 PDF 阅读不受论文工作区退役影响。

## 使用流程

1. 在藏书页或设置中选择“监测文件夹”，只授权计划作为书库的目录。
2. 等待扫描后阅读；后续添加文件由前台监测发现，也可手动重新扫描。
3. 目录权限丢失或源文件不可用时，先恢复授权或文件，再扫描。不要通过清数据、卸载或删除书目来绕过错误。
4. AI、翻译和听书涉及外部服务时，先核对端点、凭据及数据发送范围。合成验收包不应填写真实凭据或接入个人书籍目录。

监测书籍源目录与应用数据库/备份目录是不同概念。跨设备恢复归档不会自动继承另一台设备的目录授权。

## 开发与构建

建议使用 Node.js 24 或更新版本；当前 Vite 要求 Node.js `^20.19.0 || >=22.12.0`，部分测试还使用 Node.js 原生 TypeScript 支持。在 `reader/` 执行：

```sh
npm ci
npm run dev
npm run build
npm run test:android-only
npm run test:library
npm run test:feature-trim
```

`npm run build` 只生成 Android WebView 共用的前端资源，不生成 APK。Android 构建需要 JDK 21、Android SDK API 36、兼容的 NDK 及 Rust `aarch64-linux-android` 目标：

```sh
npm run android:init -- --ci --skip-targets-install
npm run android:prepare
npm run android:build
```

默认命令构建 ARM64 调试包。正式包标识为 `io.pagewise.reader`，常规调试标识为 `io.pagewise.reader.debug`；隔离验收包使用独立标识，不应覆盖原有应用。更多命令见 [应用开发说明](reader/README.md)，安装前遵循 [设备准入](docs/device-admission.md)。

## 验证与边界

当前底部导航版本已通过生产构建、63 项定向 host 回归、10 个真实页面场景及 3 项目标机检查。不同版本、不同批次的结果不能合并为当前安装包的一次完整验收；4000 书目模拟检查不等于目标机性能证明。

实际系统撤权/重授权、物理残影与人工触控体验、长时间稳定性及耗电仍未完成单独验收。真实 AI、翻译和听书服务也未作为本轮测试依据。详见 [验证状态与已知限制](docs/validation-status.md)。

源码同步不发布 APK、标签或 GitHub Release。`reader/.github/workflows/` 中的历史工作流尚未接入根仓库的发布流程。

## 仓库与许可

源码仓库为 [shawnshi/Pagewise](https://github.com/shawnshi/Pagewise)，主分支为 `main`。在项目根目录管理版本；`reader/` 作为普通源码目录发布，本地保留的上游 Git 元数据不是子模块，不向 `yzfly/LightRead` 推送。

保留根 [LICENSE](LICENSE)。`reader/` 衍生应用保留 LightRead（yzfly / 云中江树）署名并遵循 [AGPL-3.0-or-later](reader/LICENSE)；根许可证不替代该上游授权。原始设计材料和第三方许可保持原样，不复用上游签名材料或账号配置。

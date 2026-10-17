# Android-only 平台收敛（历史阶段记录）

> 历史快照：以下记录平台收敛当时的范围，不是当前功能或安装指令。当前产品范围见[项目说明](../readme.md)，当前结果见[验证状态](validation-status.md)，安装前遵循[设备准入](device-admission.md)。下文的旧规划或原型 PASS 不代表当前安装包已通过验收。

此阶段支持范围：**只维护 Android 应用**，目标为文石 Note X3 Pro / ARM64。`io.pagewise.reader[.debug]`、知页名称、Logo 原件和 `1.15.0` 版本保留。本轮不等于离线加固、阅读功能重写或 APK 已交付。

## 已移除

- 桌面二进制入口 `src-tauri/src/main.rs`、single-instance 和 Windows WebView 缓存/命令行文件接收分支。
- 桌面 CLI 论文 Agent、BabelDOC 外部 Python、本地 Kokoro 的原生实现与命令注册。前端对应能力关闭；上下文/历史数据辅助类型没有被伪装成可用引擎。
- `libc`、`sherpa-onnx`、`ureq`、`bzip2`、`tar`、`tauri-plugin-single-instance`、`windows-sys` 等直接依赖；仍被共享库需要的间接依赖不机械清除。
- PWA 构建插件、manifest、预缓存/注册生产路径、PWA 图标、根 SPA `wrangler.jsonc` 部署入口及通用桌面 Tauri 脚本。
- 桌面 ICO/ICNS、Windows PNG、iOS PNG。当前 26 个 PNG 为 Android 各密度 25 个，加 1 个 Tauri 共用原生图标。
- 桌面/iOS 发布任务；GitHub workflow 仅构建并验证 Android ARM64 APK，保留固定签名与摘要验证。没有执行该工作流，也没有删除远端历史发行包。

## 明确保留的共享内容

- `src/`、Vite、Foliate fork、兼容性处理、WASM/字体/阅读器资源。Android 本身使用 WebView，不能把这些当作“桌面版本”删除。
- EPUB/PDF/DjVu、书库、批注、阅读模式、统计、通用 AI/翻译、系统/Edge 听书、账号同步及互传。在线功能和上游更新源尚未在本轮裁剪或替换。
- SQLite/文件系统、Android 系统文件打开事件队列及读取授权、Calibre/字体/HTTP/更新共享实现；数据格式、归档格式、设置键和应用数据不迁移、不清除。
- `sync-server/` 是独立账号/同步后端，不是 PWA 页面部署。未改变已部署服务或其凭证。
- Dexie/browser 分支与 `dev`/`preview` 仅供本地开发验证；没有 PWA manifest、SW 注册或网页部署脚本。
- `src/main.ts` 的旧 SW 注销/CacheStorage 清理是 Android WebView 防陈旧资源措施，不是 PWA 注册，也不清除 IndexedDB 书库。
- Tauri `app.windows`/窗口标签、Cargo library/crate types 是 Android 共用结构；原生入口和构建脚本另有非 Android 拒绝条件，不代表保留桌面或 iOS 发行。

应用内手册已标为“上游参考”，其中旧平台/CLI 的历史文字不再作为支持承诺。

## 开发命令（在 reader/）

```powershell
npm ci --ignore-scripts
npm run build
npm run test:android-only
node --test scripts/test-android-native.mjs
python -B scripts/test-branding.py
npm run e2e

npm run android:init -- --ci --skip-targets-install
npm run android:prepare
# 以下需要完整 Android SDK/NDK 与 Rust Android 目标：
npm run android:dev
npm run android:build
```

`android:prepare` 同步托管的 Android 图标、名称、MainActivity，幂等应用原有 FileProvider/安装权限补丁。没有改掉共享 Android 更新协议，也没有宣称已经移除 INTERNET。原生构建的 Cargo 目标须为 Android；不要把宿主 `cargo check/test` 被明确拒绝当作已执行 Android 测试。

## 本轮实际证据

- `vue-tsc -b && vite build` 通过；产物没有 PWA manifest、注册脚本或 Workbox 输出。
- 使用已安装 CLI 成功生成 Android 工程并完成资源准备；初始化显式跳过 Rust 目标安装，未升级全局 SDK/JDK/NDK。
- 7 项 Android-only 与 4 项原生契约检查通过，15 项品牌/依赖保留检查通过。
- 7 组共享功能回归合计 184 项通过：阅读模式、页数、计时、TTS、朗读、同步设置、EPUB 转换。
- 隔离 Chromium、Android UA 开发预览通过：合成 TXT 导入、正文实际渲染、导航后书库保留、关于页“开发预览”标签；外部页面请求已拦截。它不是设备/OS 全隔离或 Note X3 Pro 真机证明。
- 发布 YAML 可解析，默认 yamllint 无告警；未实际发布。
- 另跑的书单组为 14/15：既有脚本使用 URL.pathname 生成 Windows 路径，出现 `C:\C:\...`。已确认测试文件与冻结基线相同、书单目录存在；本轮没有借此修改无关实现或声称全测试通过。

尚未执行 Android APK 编译、签名升级、真实设备阅读/休眠/残影/备份恢复验收。仍缺完整原生工具链与实机证据；上轮准入工具 PW-R1-01—03 也没有在本轮处理。独立源码复核结果单独绑定当前快照记录，不以这些测试数替代。

## 恢复与副作用边界

冻结当前工作树的完整快照、SHA-256 和原始品牌差异位于 `artifacts/android-only-baseline/`；它包含原先未提交的品牌改动。删除的原生实现和图标都可由该快照恢复。前一次因 Git 中文路径转义失败的部分快照被保留为 incomplete，不作为恢复基线。

只在授权代码工作树中移除文件。隔离工作树仅隔离代码，不隔离凭证/进程/网络；没有执行卸载、清数据、合并提交、git push、部署或远端清理。恢复前必须核对后来用户修改，不使用 reset/clean 覆盖现有工作。

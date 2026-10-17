# 知页品牌适配（历史阶段记录）

> 当前平台范围已收敛为 Android-only。本文记录此前跨平台品牌适配；其中桌面/PWA/iOS 图标已在后续阶段移除，当前仅保留 Android 与共享资源，见 [Android-only 说明](android-only.md)。

本轮范围：包名称、应用标识、显示名称、说明与 Logo；不改变阅读、存储、联网、更新及账号服务逻辑，不构建、安装或发布 APK。

## 已统一的名称

| 项目 | 值 |
|---|---|
| npm / Rust 包名 | `pagewise` |
| Rust 库名 | `pagewise_lib` |
| 应用短名 / 桌面名称 | 知页 |
| 关于页 / PWA 全名 | 知页阅读器 · Pagewise |
| 口号 / 安装包短说明 | 专注阅读，随页理解。 |
| 应用说明 | 面向文石 Note X3 Pro 的个人 EPUB 阅读器。专注阅读，随页理解。 |
| 正式应用标识 | `io.pagewise.reader` |
| 调试应用标识 | `io.pagewise.reader.debug` |
| 版本 | 保留上游基线 `1.15.0`，本轮不调整版本号 |
| Logo 原件 | 项目根目录 `Pagewise.png`，原图未修改 |

已同步 npm/Cargo 清单及 lock 根条目、Rust 入口、Tauri 配置、Android Kotlin package、发布工作流内的名称/路径/文件名和相应校验器。工作流没有执行，签名材料、发布权限和外部服务部署配置未修改。

前端已同步侧栏、关于页、中英文名称与说明、HTML/PWA 元信息及图标引用。上游作者、AGPL/第三方许可、服务名称及相关源码链接保留；账号入口明确标注“上游服务”。没有全局替换数据库名、持久化键、备份格式或原生 JS 桥名。

## Logo 派生资源

- 61 个 PNG：桌面、Windows、Android 各密度的普通/圆形/自适应/单色图标、iOS、PWA。
- Windows ICO、macOS ICNS，以及 favicon 和生成源 SVG。
- 原图逐字节复制到 `reader/public/pagewise-logo.png`，便于独立源码仓库复现。
- Android 自适应背景为纯白，不重复叠加 Logo；前景/单色图标使用透明度，主体限制在 108dp 画布的安全圆内。
- iOS PNG 无 alpha 通道；普通图标不拉伸原始长宽比。图标联系表位于 `artifacts/branding-preview.png`。

```powershell
python -B reader/scripts/prepare-branding.py --preview artifacts/branding-preview.png
python -B reader/scripts/test-branding.py
# 在 reader 目录运行：
node scripts/check-release.mjs --self-test
node scripts/check-release.mjs
```

脚本使用已经安装的 Pillow；没有新增或升级项目依赖。

## 验证边界

- 15 项品牌测试通过：清单/锁文件一致、原图哈希、平台尺寸和透明度、自适应背景与安全圆、ICO/ICNS、SVG 本地嵌入、前端品牌接缝、越界路径拒绝、版本及发布校验器。
- 依赖和版本不变；Cargo.lock 仅根包改名及其排序位置改变。Tauri 的非品牌配置保持不变，未更改权限/CSP/文件关联。
- 发布 YAML 已解析，并与原件按品牌替换结果进行结构比较；签名/权限/发布逻辑没有额外改动。YAML 原有格式告警保持一致，没有新增告警。
- 图标联系表已实际生成并目视检查；不是完整 Vue 或 Android 运行验证。
- 当前未安装前端依赖；Vite 类型检查仍报告原有模块不可用，Vue 全量类型/构建未验证。不能把静态品牌检查当成 APK、离线功能或 Note X3 Pro 的实机验收。
- 上轮准入工具独立复核项 `PW-R1-01`—`PW-R1-03` 仍待修；本轮按“品牌优先”未改动这些诊断脚本，未宣称其独立复审通过。

## 恢复

变更前原件与哈希位于 `artifacts/branding-baseline/`。该快照对应本轮开始的状态，不是最初只有 Logo/README 的项目快照。恢复时只恢复清单所列文件，并先检查后续用户修改；不要 `git reset/clean`、卸载或清空任何应用数据。原始 Logo 始终保留。

# 1.1.0 构建与安装记录

日期：2026-10-19。状态：**Release 和 Debug 1.1.0 均已构建、校验、安装，并完成启动检查。** 本记录是本机验收摘要，不是 GitHub Release 发布公告，也不表示完整性能验收已完成。

## 交付身份

| 项目 | Release | Debug |
|---|---|---|
| 包名 | `io.pagewise.reader` | `io.pagewise.reader.debug` |
| versionName / versionCode | 1.1.0 / 1001000 | 1.1.0 / 1001000 |
| debuggable | false | true |
| ABI | arm64-v8a | arm64-v8a |
| minSdk / targetSdk | 24 / 36 | 24 / 36 |
| APK 大小 | 82,924,534 字节 | 306,501,479 字节 |
| 本地产物 | `artifacts/Pagewise-1.1.0-release.apk` | `artifacts/Pagewise-1.1.0-debug.apk` |

APK SHA-256：

- Release：`13b2a96640a1a5c08d431a14ad0c459b9d6562724fae6b041dcbb300ddf7cc1c`
- Debug：`b855d55635700021649ff332e81859c56970db388400de894e267caf27209ef4`

两包使用既有证书，证书 SHA-256：`9b0f56619d62232588818c64083536bcbb3ae9182593b3610f67ef3c13f472a3`。这是本地覆盖安装的签名连续性记录，不是生产签名方案建议；私钥、签名容器及口令不入库。

## 构建与校验

五处根版本已同步为 1.1.0；仅根包版本变化，依赖图未升级。宿主定向回归、前端构建、浏览器 Worker 检查及性能切片独立审查已经执行。

早期全量构建曾遇到无效 NDK 路径、Java 25 与 Gradle 8.14 不兼容，以及冷编译时间预算问题。后续经授权采用现有 JDK 21、NDK 30.0.16248370 和封存 Rust 库，拆分应用 Kotlin、Java、R8、原生库、package 与 assemble 阶段，最终全部 exit 0。未追加不透明的全量 Tauri 重试，未安装新工具链或修改全局 Java/SDK。

只跳过已经完成且源码/库哈希绑定通过的 Rust 钩子；每阶段前后检查源码与固定密钥未漂移。最终检查了 ZIP CRC、包名、版本、ABI、SDK、debuggable、签名和探针方法；APK 内 Rust 库哈希与封存产物一致。临时生成的签名配置和 JNI 链接均已恢复。

## 实际安装与启动

- Release 于 23:09 同证书原位覆盖安装。设备 `base.apk` 与交付 APK 摘要一致，原 UID、首次安装时间和私有数据目录 inode 均保留。
- Debug 于 22:44 安装到独立包名。设备 `base.apk` 摘要一致；Release 安装前后 Debug 身份未变。Debug 原有用户禁用状态仅针对本包启用，没有调整系统冻结策略或其他应用。
- 未卸载、清数据、导出真实书籍或复制真实书库/账户设置。上述身份检查不是逐书内容审计。
- Release 冷启动 Activity 的一次 TotalTime 为 435ms，Debug 为 1090ms；两包均实际收到原生/前端数值探针 ready 记录。这些单次结果不是书籍打开、翻页尾延迟或面板显影成绩。
- 探针必须在创建 Activity 的启动 Intent 中显式启用；对已在运行的 Activity 发送热 Intent 不能作为启用证据。检查结束后已以探针显式关闭状态正常重启，观察窗口未出现探针日志。
- 启动检查没有读取或导出真实书籍、书库 UI 内容或账户字段。

目标设备：Note X3 Pro、Android 12/API32、1860×2480、300dpi、WebView 146.0.7680.178。其他设备与系统版本不据此视为通过。

## 剩余验收

PDF 部分主线程初始化/文本/交互开销、打开成本回退、SAF 与听书长时间运行，以及实体墨水屏的翻页延迟、清晰度和残影仍未闭合。宿主测试、API ready、Activity 启动时间和应用截图均不能代替这些验收。

本记录的 APK 形成于随后这轮 README 整理之前。`reader/README.md` 也是内置手册的构建输入，后续文档改动会在下次构建进入应用；本次 GitHub 源码同步不重新打包或发布 APK。

本机完整日志和回执保留在忽略的 `.cache/performance-20261019/device/`；APK 保留在忽略的 `artifacts/`。不把这些本机文件或私有签名材料推送至源码仓库。正式包更新后不保证能降级：必要恢复应使用同证书、递增 versionCode 的旧代码恢复包，不以卸载或清数据回退。

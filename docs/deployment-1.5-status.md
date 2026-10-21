# 知页 1.5.0 双版本安装记录

状态：构建、签名及指定设备覆盖安装完成。两包 versionName 为 `1.5.0`，versionCode 为 `1005000`；设备为 Note X3 Pro，Android API 32 / arm64-v8a。

## 安装结果

| 变体 | 显示名称 | 包名 | 安装包 |
|---|---|---|---|
| release | 知页 | `io.pagewise.reader` | `artifacts/Pagewise-1.5.0-release.apk` |
| debug | 知页 1.5.0 测试版 | `io.pagewise.reader.debug` | `artifacts/Pagewise-1.5.0-debug.apk` |

两版均从 1.4.0 覆盖升级，仍可共存，各自私有数据保持隔离。安装前后逐包核对 UID、首次安装时间、数据目录与 CE inode，均与原记录一致；这不等于逐条核验书目、批注或设置内容。本次未卸载、未清数据、未复制书库，也未主动启动应用。

## 构建与身份验证

- Node/Tauri/Cargo 应用版本同步为 1.5.0；npm/Cargo 依赖图未改变，仅变更应用根版本。
- Android 变体回归 **11/11** 通过；实际应用 `vue-tsc -p tsconfig.app.json` 和前端生产构建退出 0。
- Debug/Release Rust Android 动态库分别实际构建、封存，APK 内库摘要与对应源码输入清单绑定。没有把早期 `cargo check` 冒充本次库构建。
- 两版 Kotlin 和 assemble 完成；release R8 完成并关闭 debuggable，debug 开启 debuggable。两包 minSdk=24、targetSdk=36，仅包含目标设备的 arm64-v8a。
- 验证 ZIP CRC、APK 签名、包名、版本、87 个语言标签及 launcher activity 标签。名称分别为“知页”和“知页 1.5.0 测试版”。
- 个人侧载沿用既有证书，证书 SHA-256 为 `9b0f56619d62232588818c64083536bcbb3ae9182593b3610f67ef3c13f472a3`；与设备安装前两包一致。签名容器元数据未改变，没有新建或替换证书，不将其描述为应用商店生产签名方案。
- 两次 `adb install -r` 均返回 Success（debug 额外使用 `-t`），安装后的 `base.apk` SHA-256 与交付包完全一致。未修改应用启用状态或主动发起 Activity 启动。
- 与 v4 受审实现核对：除本次明确允许的版本元数据与文档外，没有实现源码或无关 dirty 文件漂移。打包安装阶段不含 Git 提交/推送，未发布 APK；原生成 JNI 链接已恢复。

## 包摘要

- release：`fe38ea858c735ff402b3c179f1ab8e5c4156fe1cd77350f87f75f061b2b86ee7`。
- debug：`554fd0f73862baea9d964db21e2033a778942efaa678cc86b5f46943e4f22ad0`。

## 证据与恢复

本机证据：`.cache/deployment-1.5/`，包含原包/版本文件备份、签名容器元数据、`source-inputs.json`、`native-debug.json`、`native-release.json`、Gradle/R8/assemble 日志、`artifact-*.json`、`installed-*.json` 和 `deployment-acceptance.json`。签名私钥和口令不进入日志或源码。

首次准备后的 Python 包装器因 Windows 默认编码报错，但两个准备任务已退出 0；修正 UTF-8 读取后仅核验已有回执，未重做准备。首次 debug 元数据闸门不识别 aapt 的 CRLF，87 个实际标签均正确；修正换行处理后重新校验同一个字节未变的 APK，未重新打包或交付错误名称。一次 Git Bash `/data` 路径转换导致空间探针失败，随后通过结构化 Python 子进程核对，安装不受影响。

原包不是保证可直接降级的回退方案。需要恢复旧代码时，应使用原源码、同证书和递增版本码制作恢复包，并单独检查数据兼容性；不能通过卸载、清数据或改包名回退。

## 验收边界

本次完成打包、签名和安装，不包含启动或功能运行验收。没有读取真实书库、批注、密钥或阅读记录，也没有调用在线 AI。安装可能终止或影响原进程；“未主动启动”不声明 Android 系统绝无自动进程行为。

七页原生实现已通过 v4 源码/host 独立复审，记录见 `.cache/native-pages-20261021/acceptance-v4.json`。实际 Android 界面/返回/键盘、原生存储迁移、真实 SAF provider 导入链、物理尺标、BOOX EPD/硬件键和长期后台听书仍需分别验收，不能从安装成功外推。

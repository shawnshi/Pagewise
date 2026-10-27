# Pagewise 1.3.0 安装记录

## 结果

Release 与 Debug 已在 Note X3 Pro（Android 12 / API 32）上由 1.2.0 覆盖升级至 **1.3.0 / versionCode 1003000**，并保持并行安装、启用状态。

| 变体 | 桌面显示名称 | 包名 | debuggable | 本地产物 |
|---|---|---|---|---|
| Release | 知页 | `io.pagewise.reader` | false | `artifacts/Pagewise-1.3.0-release.apk` |
| Debug | 知页 1.3.0 测试版 | `io.pagewise.reader.debug` | true | `artifacts/Pagewise-1.3.0-debug.apk` |

两包均为 `arm64-v8a`，`minSdk=24`、`targetSdk=36`。Release 经 R8 缩减；Debug 为保留原生调试符号的开发包，体积明显较大，不用于对比正式版大小或性能。

## 包身份与签名

- Release SHA-256：`e4cbbe708bde2bf426bba8ec9197806fa5ac75cb1ca73ec91f799627a9adee10`
- Debug SHA-256：`d0bcb806207ff66bfb0a72a801fb95056cc9a175122498d7cb805bf30cae2fca`
- 两包证书 SHA-256：`9b0f56619d62232588818c64083536bcbb3ae9182593b3610f67ef3c13f472a3`

证书与设备已安装的 1.2.0 一致。个人侧载沿用既有证书，并未生成或替换密钥；签名容器元数据检查未变。证书容器的历史名称是 `debug.keystore`，不代表公共生产发行签名方案。签名材料及口令不写入源码或报告。

## 构建及安装验证

1. Node、Tauri 与 Cargo 项目版本同步升至 1.3.0；npm/Cargo 依赖图保持不变。
2. 先修改名称断言，确认旧命名不满足要求；更新变体生成器后，Android 边界、模板恢复、变体幂等测试 **37/37 通过**。
3. `npm run build` 完成 Vue/TypeScript 检查与前端生产构建。仍有 Vite 动静态导入不拆包提示，不影响构建成功。
4. 使用 JDK 21、SDK 36、NDK 30.0.16248370 分别构建 Rust Android 库；绑定源码清单与原生库摘要，再进行 Gradle Debug assemble、Release Kotlin/R8/assemble。各任务均退出 0，未声称另行执行过顶层 `tauri android build`。
5. 校验 APK CRC、签名、包名、版本、完整桌面名称、ABI、debuggable，以及 APK 内 Rust 库与对应构建摘要一致。
6. 先 `adb install -r -t` 安装 Debug 并检查启动，再 `adb install -r` 安装 Release。设备已安装 `base.apk` SHA-256 与各自产物一致。
7. 两包的 `userId`、`firstInstallTime`、`ceDataInode`、`dataDir` 均与安装前相同；未卸载、未清数据、未复制或读取真实书库。安装前应用处于默认/禁用状态，按本次部署目标明确启用两包。
8. 两包均经过带探针的 Activity 启动及前端 ready 检查，再以 `PERF_PROBE=false` 正常启动；检查进程与前台 Activity、启动期间相关崩溃日志。最终探针关闭。
9. 有界归档、PDF Worker、原生环境、纸墨主题及 Android 构建契约等定向回归测试 **95/95 通过**。
10. 构建后恢复生成工程原先的 JNI 链接/文件，不覆盖旧版 APK；保留本次不可变 APK、原生库摘要和验证回执。

本机证据位于 `.cache/deployment-1.3/`：`device-before.json`、`source-inputs.json`、`native-*.json`、`artifact-*.json`、`installed-*.json`、`smoke-*.json`、`normal-launch-*.json`、`deployment-acceptance.json`、`regression-tests.log` 及分阶段构建日志。缓存与 APK 不提交源码仓库。

## 验收边界及恢复

本次交付证明的是指定两包已经构建、签名、覆盖安装及启动就绪，不是全部产品功能验收。数据目录标识未变不等于逐条核验了书籍、批注和设置内容，本次不读取这些内容。

EPD 波形与残影、双色温前光、低延迟手写、外部文件导入、原生 PDF/检索链路、合盖恢复以及连续息屏听书仍需分别进行专项真机验收；不从启动成功外推这些能力有效，也不确认 README 中的延迟、零拷贝或防丢保证。

安装前版本及原生输入备份保留在本机证据目录。Release 不保证接受版本降级；需要恢复旧代码时，使用同证书且递增 versionCode 的恢复包，另行验证数据兼容性，不通过卸载或清数据回退。

本次未推送 GitHub、未创建 Release、未上传 APK、未部署 relay。

# 知页 1.8.0 构建、部署与验证

> 本文保留原始1.8部署记录。设备现已覆盖为同版本 UI 修复包；当前产物与实机状态见 [1.8 UI修复部署](deployment-1.8-ui-fix-status.md)。原始APK和验收回执不覆盖。

## 当前结论

**release／debug 均已覆盖部署到 `9D7BC516`，版本1.8.0／1008000；包身份、安装字节、限定启动／页面及合成阅读路径已验证，独立复核 `scoped_OK`。** 未卸载、未清数据、未升级依赖／SDK／WebView，未改文石全局冻结策略。

| 项目 | release | debug |
|---|---|---|
| 显示名 | 知页 | 知页 1.8.0 测试版 |
| 包名 | `io.pagewise.reader` | `io.pagewise.reader.debug` |
| APK | `artifacts/Pagewise-1.8.0-release.apk` | `artifacts/Pagewise-1.8.0-debug.apk` |
| SHA-256 | `5aea52884c0cfd206be32eefe9f3ac26d12c556caf2e8ee9aca2acc324b2afc9` | `4cd608663c549c708998cef3e90b014426ba67095d843eaed2fcecf1188d8c4f` |
| 字节数 | 77,206,797 | 276,827,677 |
| UID／目录inode | 10097／59051 | 10095／52263 |
| 首次安装时间 | 2026-10-23 21:06:06 | 2026-10-23 10:55:31 |

覆盖安装后 UID、数据目录、首次安装时间及 inode 与前置记录一致；拉回的两包与对应候选 APK 字节一致。上述身份不变不等于完整数据库／字段未变证明。

两包均 arm64-v8a、min24／target36，87个本地化名称全部一致；设备启动器也实际显示两个指定名称。沿用现有 Android Debug 侧载证书 `9b0f5661…472a3`，不是应用商店发布签名。

## 代码与构建范围

仅同步6个版本 owner：`reader/package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`Cargo.lock`、`tauri.conf.json`、`src/services/appVersion.ts`。设置页原 `CURRENT_VERSION=1.15.0` 修正为1.8.0。另由既有准备器刷新生成的 `app/tauri.properties`，不直接手改生成文件。

- npm／Cargo 依赖图不变，未重解锁依赖。
- 包含已经完成的 S1／S2；S3–S6 未在本次版本打包中另行实现。
- 460输入冻结。预检发现2个 Kotlin 文件在前次验收后被格式化；恢复旧冻结文本并逐项比较，仅换行／分号等格式差异，当前文件保留。
- 明确调用 Vite `build()`，实际生成168资源；两个 Rust profile 均 offline／locked 重编。release Kotlin、R8、assemble及debug Kotlin、assemble通过。
- 两包 CRC、签名、版本、ABI、87名称以及冻结输入／前端清单／原生ELF→APK哈希绑定校验通过；全部83个当前 JS 资源名在对应原生库中验证。这不是逐份解包重算嵌入JS内容，也不构成可复现构建证明。
- 正确的 `tsconfig.app.json` 类型检查通过，包含 `appVersion.ts`；相关回归 **67/67**。
- 最后6路径 LSP：0诊断但0 confirmed clean，5 inconclusive、1 Cargo.lock too large；不把该结果称为 LSP clean。

## 实机验证

### 启动及原生页面

- Debug 冷启动恢复到“设置”根页；以准确包名、顶部原生标题和第二次稳定采样验证五页切换，再回藏书，6步通过。
- Release 原本被冻结，`enabled=3`、PID不存在。通过文石官方“知页”图标解除该应用冻结后，从无进程状态启动成功；同样验证五原生页及返回藏书，6步通过。
- 首批 `smoke-*.json` 的旧判定可能匹配底部常驻标签，**不作为页面就绪通过证据**；以 `pages-verified-v2-debug.json`、`pages-official-verified-release.json` 为准。
- Home＋12秒扩展脚本未完成其入口／页面前置条件，**不计为通过**；没有长期后台、自动冻结或精确页面恢复结论。

### Debug 合成阅读

只新增本轮 EPUB，不打开已有书籍正文：

1. 实际原生版本1.8.0，Web阅读器完成 Vue Opening、正文及 live CFI 就绪，可访问性遮挡恢复。
2. 两章节目录模型正确；下一页 CFI改变。
3. 通过正常 Reader 返回入口保存并退出，保存 CFI 等于退出前最后可见 CFI，旧 owner 失效。
4. 删除本轮合成书；原8本书 ID摘要不变，2条批注计数不变，前后 `integrity_check=ok`。

不把此路径解释为已关闭此前精确恢复差6字符或快速首次返回的历史问题。

### Release 合成阅读

通过原生 More→管理→导入及系统文件选择器，只选择本轮 `PW18-Verification.epub`。确认精确合成书目后打开正文；可见第一章标记，转到第二章后标记改变，正常返回藏书后显示保存进度 **50%**。

随后通过该书自身菜单及精确标题确认移除书目；藏书数由测试后的2257回到前置截图记录的2256，本轮下载文件已删除。**未直接检查正式版数据库完整性、全量ID或精确CFI。** 当前藏书数量不能证明原1.6数据恢复。

一次硬件 DPAD_RIGHT 的段落集合观察未形成可用翻页通过证据，不计入成功；后续切章是独立验证。输入法把一次合成搜索输入组合成中文混合文本，已用“清除搜索”清除，未重试旧标签输入测试。

## 恢复与数据边界

- 两个精确旧 APK 已保存。
- 设备 `ro.debuggable=0`，普通非调试包降级受限；因此另生成**同为1008000版本号的旧代码恢复包**。仅二进制 Manifest 的版本字段变化，其他未压缩代码／资源逐项哈希相同；重签后验证同包名、同签名和同版本，静态校验无需降级、卸载或清数据的覆盖路径。恢复包不是正常交付包，未实际安装演练。
- Debug 默认 DB／WAL／SHM／root locator 的恢复副本留在原 UID 内；创建时 PID不存在。不是全书库或事务级备份。
- 正式版没有完整数据库物理备份。核心存储／schema owner 与之前已安装 bootstrap-fix release 一致；APK恢复点不能替代数据库备份。
- 原1.6恢复、真实十本审计0/10、旧标签输入和精确CFI问题保持原记录，不因1.8安装／本轮合成验证而关闭。

## 已知测试副作用与限制

- 正式版排序在定位测试书时切到“加入时间”；原会话排序无法从该菜单回查，未声称恢复原排序。
- 合成书已从两库移除。正常应用删除按既有语义保留阅读统计，本轮合成阅读可能留在统计中；没有为清理测试而修改统计schema或批量删用户数据。
- 文石后台冻结策略未改。观察到正式版再次进入 `enabled=3` 时，普通 `am start` 无法替代官方解冻入口；该状态不按应用崩溃处理，也不保证未来不会被系统再次冻结。
- 不包含真实多书长测、完整无障碍、所有输入法／格式／迁移、物理EPD标定、启动／内存性能或长期后台验收。

## 证据

目录 `.cache/deployment-1.8-20261024/`：

- `preflight.json`、`before/`、`generated-before/`、`source-inputs-build.json`、`own-version.diff`。
- `version-verification.json`、`prepare-version-verification.json`、`frontend-inputs.json`、`native-release.json`、`native-debug.json`、`artifact-*.json`及构建日志。
- `install-debug.json`、`install-release.json`、`device-before.json`、`device-final.json`、`launcher-labels-1.8.json`。
- `pages-verified-v2-debug.json`、`release-official-cold.json`、`pages-official-verified-release.json`。
- `debug-reader-result.json`、`debug-postcheck.json`、`release-reader-result.json`、`release-fixture-cleanup.json`。
- `rollback-readiness.json`、`debug-private-backup.json`、`validation-scope.json`、`secret-scan.json`、`cdp-cleanup.json`、`jni-final.json`。
- `independent-review-v1.md` 保留首轮覆盖缺口 BLOCK；`independent-review-v2.md` 补核输入清单、实际哈希、绑定脚本与常量引用后关闭 P2-01，确认本轮 `scoped_OK`。审查未重跑构建、测试、ADB或部署。`acceptance.json` 为当前范围化终态。

原始私人 UI文字仅在受控宿主进程内处理；写入证据前按白名单脱敏，非合成截图遮住内容及未知标题。自有 DevTools转发已移除，未停止共享ADB；JNI恢复链接结构，目标是新编译1.8库，旧字节另存。

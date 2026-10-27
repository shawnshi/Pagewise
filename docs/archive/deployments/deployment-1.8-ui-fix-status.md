# 知页 1.8.0 UI修复双包部署

## 当前结果

Release、debug 已覆盖安装到设备 `9D7BC516`，均为 **1.8.0／1008000**。未卸载或清数据；UID、dataDir、首次安装时间和目录 inode 保持。拉回的已安装APK与下列候选字节一致。

| 项目 | release | debug |
|---|---|---|
| 显示名称 | 知页 | 知页 1.8.0 测试版 |
| 包名 | io.pagewise.reader | io.pagewise.reader.debug |
| APK | artifacts/Pagewise-1.8.0-ui-fix-release.apk | artifacts/Pagewise-1.8.0-ui-fix-debug.apk |
| SHA-256 | 86583e4570b9b320cada235bcf01fe06303e062065d3eed9debda2e4e0ac463b | ceb547ad277929498f0b5ecf92498bdd74e31c44a495f7ca66e47b0d25cd64b8 |

## 修复与构建

- 藏书搜索框放回结果列表之前；在读卡片以原分类标签替换标题右侧阅读状态，移除下方重复标签行。无标签不生成占位标签，窄屏沿用纵向标题布局。
- 未修改版本、依赖、存储/schema、CFI、WebView或文石冻结策略。460项源码冻结；相较原1.8仅两生产UI owner及配套fixture变化。修复验收后两个文件的格式差异已保留并核对，当前文本由Gradle实际编译。
- 准备器生成的两份Kotlin与对应源码字节一致；release Kotlin／R8／assemble及debug Kotlin／assemble通过，两个DEX载荷均已变化。
- **未重跑Vite或Rust编译**：168项前端资源未变，两个Web/Rust ELF载荷逐字节复用已验证的原1.8 APK。旧载荷来源清单与本轮打包清单分别记录，不混称新编译或可复现构建。
- 两包签名、CRC、arm64、min24／target36及87个本地化名称通过。沿用现有Android Debug侧载证书，不是商店发行签名。
- 本轮相关回归 **67/67**；源码修复阶段的真实Android测试 **35/35**另存于 `.cache/pw18-library-search-tags-20261024/`，不合并计数或冒称本轮重跑。此前Kotlin LSP不确定，不称clean。

## 实机验证与边界

- 两包均完成冷根页就绪，以及“藏书→正在阅读→藏书”三步验证；准确包名、顶部标题与第二次稳定采样共同判定。
- 两包搜索框均位于类别／结果之前；在读结构检查debug4行、release2行，原独立阅读状态和下方重复标签行均未出现。只保存结构、布尔值和几何信息，不保存私人书名、分类或正文。
- 文石“应用”页实际显示两个指定名称。初始Home不是应用列表；图标文字点击未形成启动通过证据。最终显式启动Activity，确认正式版藏书页在前台；不扩展为桌面图标启动链、长期后台或免冻结结论。
- 部署前通过正常系统返回离开正在运行的阅读器；未强制关闭正文或重放未知提交。本轮未导入、打开或删除测试书。正常返回及页面导航可保存进度和UI session，不称整个运行只读。
- 原1.8两份精确APK为同版本代码回退点，静态核对同包／同签名／同版本，未安装演练。Debug默认DB/WAL/SHM/locator副本留在原UID，不是全书库／事务级备份；正式版无完整DB物理备份。身份保持不等于逐字段完整性证明。
- 原1.6数据恢复、历史真实十本0/10、旧标签输入和CFI问题均不因本轮部署关闭。S3–S6仍未实施。

## 证据

`.cache/deployment-1.8-ui-fix-20261024/`：`preflight.json`、`source-inputs.json`、`prepare-verification.json`、`generated-inputs.json`、构建日志、`native-*.json`、`artifact-*.json`、`install-*.json`、`smoke-*.json`、`launcher-labels.json`、`device-final.json`、`rollback-readiness.json`、`debug-private-backup.json`、`jni-final.json`、`secret-scan.json`、`acceptance.json`。

本轮为有界UI补丁打包部署，自审，不冒称新的独立审查。历史1.8独立复核仅适用于其原冻结版本。JNI已恢复原链接与字节；未设置DevTools转发，未停止共享ADB。原始APK与历史验收记录保留，旧产物状态侧车已标记被本轮替代。

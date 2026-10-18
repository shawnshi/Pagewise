# NoteX3Pro 合成书矩阵：2026-10-18

## 结论

R2 已保留数据安装；9 本多章节合成书完成默认排版与跨章检查，6 组文表/文图完成实际可视区域与加载检查。单书修改、其它书隔离、重开以及真实进程重启恢复通过。**原生返回键未通过，不能宣布整体验收完成。**

## 夹具与数据边界

| 语言 | 纯文字 | 文表混排 | 文图混排 |
| --- | --- | --- | --- |
| 中文 | 2 章 | 3 章 | 3 章 |
| 英文 | 2 章 | 3 章 | 3 章 |
| 中英混排 | 2 章 | 3 章 | 3 章 |

共 9 本，新增于独立包 `io.pagewise.reader.acceptance.v03.debug`，书名以 `UI-TYPO-` 开头。图像为离线生成的 PNG / SVG，表格数值为合成数据，无外链。

- 设备当前共 12 本合成书：原有 3 本 + 本次新增 9 本。
- 原有 3 本书的完整行哈希、阅读位置、1 条批注及其哈希、既有显示偏好保持不变。
- UID 仍为 10097；未卸载、未清数据、未装辅助 APK，未更改源目录、全局字体缩放或冻结策略。
- EPUB 已按设备文件读回并校验 SHA-256，保存于 [artifacts/fixtures/typography-20261018](../artifacts/fixtures/typography-20261018/)；逐文件清单见其中的 `manifest.json`。

## 已验证

1. **9 组默认排版与跨章：** 中文、英文、混排的实际字号/行高、缩进、英文对齐与断词 CSS、无合成字重声明；打开书籍不创建单书覆盖。首次与末章均检查，没有整页横向溢出。
2. **6 组表格/图片：** 表格单元格不被普通正文规则改写；图片加载完成且宽高比保留。表格与图片实际位于未被工具栏遮挡的视口，分别留有截图；视检了混排文表和文图截图。
3. **单书记忆：** 仅对混排文图夹具修改字号 21、护眼绿、翻页、单栏、关闭竖屏强制滚动、百分比进度；实际生效并保存。其它 8 本新夹具仍为默认，没有串设置。
4. **取消与恢复：** 取消按钮不保存草稿；切书、重开恢复单书配置与原始逻辑字符位置。仅强制停止此验收包进程，冷启动后配置、位置、UID、目录授权与原有数据仍通过。
5. **输入说明：** 按钮操作使用 ADB tap，坐标由本应用 Activity 和 RustWebView 的实际边界校验；修改排版时使用产品已有的 `M` 阅读模式 → 微调入口。未把排版工具栏的自动化时序问题算作通过。

## 缩放与物理边界

现场只读确认：屏幕 1860 × 2480，WebView 约 992 × 1322 CSS px，DPR 1.875，系统字体缩放 0.85。未改这些设置。

名义字号 18 在当前 WebView 中实际计算为 15.3 px；中文行高 26.01 px、英文 23.715 px、混排中文 26.775 px。检查区分了配置值、系统缩放后的渲染值、em 缩进和实际比例，不套用未核验的物理 PPI。尚未做实物尺量，也不声称真实 pt/mm 或墨水屏长期舒适度达标。

## 阻塞：PW-NATIVE-BACK-01

- **实际失败：** 排版草稿打开时，Android Back 会退到上一本书，而不是仅关闭当前排版面板。草稿没有被保存，但交互层级错误。
- **证据：** `.cache/typography-native-20261018-r2/native-back-trace.json`，同时确认页面上的 `window.__pagewiseReaderBack` 存在，APK DEX 也包含该桥接。
- **已定位原因：** `MainActivity.onCreate` 先注册读取页回调；随后生成的 `WryActivity.setWebView` 又注册直接 `WebView.goBack()` 的回调。后注册者优先，读取页桥接因此被遮蔽。
- **最小修复提案：** 将读取页回调注册移至 `MainActivity.onWebViewCreate`，排在 Wry 基础回调之后；保留基础 fallback，不修改生成的 Wry 源码。
- **当前边界：** 失败分支已停止，没有为获得通过反复重试或更改设备策略。本轮未应用该修复；需新增一轮受控修复、重打包、独立审查及原生 Back 复验。

## 证据

目录：`.cache/typography-native-20261018-r2/`。

- `device-install.json`、`device-after-probe.json`：安装、前端及原数据检查。
- `typography-fixtures.json`、`device-fixture-policy.json`：夹具身份、所有权、文件哈希。
- `native-defaults.json`、`native-media.json`：9 组跨章及 6 组媒体检查。
- `native-edits.json`、`native-restart.json`：单书、隔离、取消及进程重启。
- `native-final-status.json`：汇总，状态为 `NATIVE_CORE_PASS_BACK_BLOCKED`。
- `device/native-*.png`：真实 APK 的 WebView 截图；不是墨水屏表面实拍。

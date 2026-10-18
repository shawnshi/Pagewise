# 白纸墨黑配色：变更与验证

## 交付边界

- 代码提交：`5b7cfd2b3a18c735578001651b83bf65dfd8dd68`。
- 起始基线：`12ab2ac821b594df2aaccdf13323a269080dc8b5`。
- 合并目标：项目根目录 `Pagewise` 仓库的 `main`，采用 fast-forward。`reader/.git` 是独立仓库，本次没有修改它的分支、提交或远程引用。
- 只提交本次 8 个展示层源文件和 2 个定向测试文件；其他功能的既有修改不包含在代码提交中。
- 保留墨水屏开关、普通彩色主题和已保存的主题选择，不进行设置或批注数据迁移。
- 按用户要求，不构建 APK，不执行 Android／墨水屏实机测试，不推送远程。

## 最终配色

| 用途 | 日间 | 手动夜间 |
|---|---|---|
| 页面、工具栏、弹层 | `#FFFFFF` | `#000000` |
| 正文、标题、链接、主要图标 | `#000000` | `#FFFFFF` |
| 次级文字 | `#444444` | `#CCCCCC` |
| 页码等辅助文字 | `#555555` | `#BBBBBB` |
| 必要边界 | `#777777` | `#888888` |
| 装饰分隔线 | `#BBBBBB` | `#444444` |
| 小面积分组背景 | `#F0F0F0` | `#1A1A1A` |
| 选中与批注背景 | `#E0E0E0` | `#333333` |

普通文字与三个实际背景的对比度均至少 4.5:1，必要边框与这些背景均至少 3:1，共检查 24 个组合。

- `#777777`／白底为 4.478:1：只承担必要边框等非文字用途，不用作普通文字。
- `#555555`／日间批注底为 5.648:1。
- 日间必要边框的最低对比度为 3.392:1；夜间为 3.564:1。
- 浅灰选中底与白底只有 1.320:1，不能单独表达状态。

## 语义变更

- PAPER-01：统一阅读器、工具栏、排版面板、批注面板和全局提示的日夜灰阶；移除墨水屏界面的阴影和背景模糊。选中使用勾选／描边，键盘焦点使用独立轮廓。
- PAPER-02：EPUB 使用一个 Custom Highlight 集合在文字后方绘制灰底，重叠范围不再反复用透明层覆盖字形。SVG 仅绘制实线、双线、虚线、点线。删除批注时同步清除背景；不支持 Custom Highlight 时退化为线标。
- PAPER-03：PDF 原页不反色、不染灰。批注使用原字形框下方的黑色线标，不覆盖原文字；重排文字遵循黑白主题。
- PAPER-04：墨水屏模式暂停软件调暗遮罩与夜间定时，保留已保存的数值。用户仍可手动选择黑底白字；排版预览和取消不提前提交设置。
- 现有批注仍保存 `yellow / green / blue / red`，只改变显示映射，不改写历史记录。

主要变更文件：`reader/src/styles/main.css`、`reader/src/services/readerTheme.ts`、`reader/src/components/TypographyPanel.vue`、`reader/src/composables/useReadingModes.ts`、两个阅读器视图及中英文文案。

## 验证证据

| 检查 | 结果 |
|---|---|
| 原始分支定向回归基线 | 75/75 通过 |
| 新增配色、误用、批注生命周期、PDF 线标几何和定时保护回归 | 17/17 通过 |
| 合并前与合并后的定向回归合计 | 92/92 通过 |
| 实际 Vue／Foliate EPUB 与 PDFium PDF 浏览器集成 | 两组测试通过，14 条场景记录 |
| Vue／TypeScript 应用项目检查 | 通过 |
| Vite 前端生产构建 | 通过，不是 APK 构建 |
| 本次代码提交的 whitespace 检查 | 通过 |

浏览器使用独立 Microsoft Edge 上下文与合成书籍，没有读取用户书库。覆盖中英两种语言、390／960 px 屏宽、日夜模式、四种重叠批注、排版草稿取消、批注删除与重载、正文大字、旧 WebView 能力缺失退化、PDF 原页像素保留及重排夜间模式。外联请求为 0，页面脚本异常记录为 0；这不等于控制台没有下述既有告警，也不是全库测试或无障碍认证。

可复查记录：

- `artifacts/paper-ink-20261019/main-browser/results.json` 与同目录截图。
- `.cache/paper-ink-20261019/main-unit.log`、`main-types.log`、`main-browser.log`、`main-build.log`。
- `artifacts/paper-ink-20261019/main-build/`：前端构建验证产物。
- `.cache/paper-ink-20261019/`：基线、文件哈希、输入快照、语义合并补丁与恢复信息。

重跑定向检查：

```sh
cd reader
node --experimental-strip-types --test scripts/test-paper-ink.mjs scripts/test-read-aloud.mjs scripts/test-reader-panels.mjs scripts/test-reader-typography.mjs scripts/test-reading-modes.mjs
node --experimental-strip-types --test scripts/test-paper-ink-browser.mjs
```

## 既有工作保护

先在隔离分支完成补丁，再重放主线当时的未提交输入并验证组合结果。解决的三个重叠点分别保留了原稿排版的保护逻辑、自动字体／排版调用以及新的批注绘制。

合并前主线曾继续变化，前两次检查均在修改主线之前停止；刷新相关输入并重新验证后才进行第三次合并。最终快进仅包含本次代码提交，随后恢复相关文件的既有改动。8 个恢复后的目标文件与已经验证的组合版本逐字节一致，66 个无关已修改文件通过哈希保护，既有未跟踪输入没有覆盖。

## 残留与未验证项

- PAPER-BASE-01：开发环境存在 `ResizeObserver loop completed with undelivered notifications` 告警。临时撤回本补丁后，在原始 `12ab2ac` 基线同样复现；见 `artifacts/paper-ink-20261019/baseline-browser/results.json`。本次未处理该既有问题，没有屏蔽它或宣称控制台完全无告警。
- 大型 Vue 文件超出 LSP 工具的行数上限，使用实际 SFC 编译、Vue TypeScript 检查和浏览器路径验证。静态规则对既有 `read(): unknown` 的提示未纳入本次修复。
- 旧 WebView 的背景能力缺失退化已在浏览器中模拟；具体设备对 CSS、前光、色温、刷新模式、残影和细线的表现仍需后续实机验收。
- 本次未进行 APK 打包、安装、设备测试或远程推送。

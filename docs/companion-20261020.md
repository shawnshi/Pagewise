# 伴读 Companion：交付与验收

日期：2026-10-20。状态：**主工作树源码与合成浏览器验收通过；最终独立复核 OK with notes**。没有提交或部署；实机、远端及长期运行未验证。以下历史失败完整保留。

## 主工作树已完成

- 中文界面显示「伴读」，英文为「Companion」。内部目录、引擎类、组合函数和组件统一为 `PagewiseCompanion`：
  - `reader/src/services/PagewiseCompanion/`
  - `reader/src/composables/usePagewiseCompanion.ts`
  - `reader/src/components/PagewiseCompanion*.vue`
- 卡片翻译通过 `AbortSignal` 取消。关闭、更换卡片、停用、格式不支持或销毁时撤销请求所有权；重复点击不重复发送，旧响应不能覆盖重新打开的同一目标或后续重试。
- 保留真实失败、空结果、引用错误、重复输出和不完整结果的错误语义。取消重试时恢复之前的不完整结果及原错误；临时查看原文前先取消翻译，避免返回时恢复无主的「翻译中」状态。
- 状态点保持静态，改为不占正文布局高度的浮层；状态及卡片按钮至少 48px。状态说明支持关闭、Esc 恢复焦点和点击外部关闭。卡片原文入口使用真实中英文字典，不再显示缺失的翻译键。
- 卡片按活 Range 定位，观察原文/布局、滚动、视口和 iframe 变化；无效、折叠、隐藏或移除的原文关闭卡片，不导航、不回退到附近文字。移除临时 `rect` 快照及 `hostRect()`，不改持久化位置。
- 长内容按可用视口限高，正文内部滚动，标题及操作区可见；连续标识可换行。无 ResizeObserver 时仍响应卡片状态更新。
- 首次布局同步测量并等待可见样式提交后聚焦卡片；Tab 环绕、Escape 关闭。记录外层、ShadowRoot 及同源 iframe 的焦点路径，按顺序返回原控件并禁止滚动。
- 局部修复状态弹窗与要句卡主按钮的深色文字对比度；只使用现有语义令牌，不修改全局主题。实测深色由 3.13:1 提升至 13.87:1，浅色 16.13:1、墨水屏 21:1；键盘焦点环与其实际邻接表面均达 3:1。
- 更新当前手册名称；保留旧手册文件名和链接，避免已有入口失效。历史设计稿保留历史内容，并注明当前命名与验收状态。

## 兼容边界

本轮没有数据迁移。以下标识有意保留：

- 序列化设置 `settings.dianjing` 及其子字段。
- IndexedDB `lightread-dianjing`、原缓存键与版本，以及提示词版本 `dj3`。
- 服务端 `/v1/dianjing`、`dianjingPromptVersion` 和 `x-dj-*` 协议。
- 原高亮标识、正文 DOM、CFI 计算及持久化定位格式。
- 既有 `npm run test:dianjing` 入口。

未修改启动恢复策略、EPUB/PDF 边距政策、依赖版本或应用版本。源码仍为 1.2.0。没有暂存、提交、推送、APK 部署或 BOOX 设置变更；没有读取真实书库、账号或调用真实 AI 服务。

## 已执行验证

| 验证 | 实际结果与范围 |
| --- | --- |
| 集成回归 | 146/146 Node 测试通过，包含 33 项请求生命周期与真实 `ReaderView.sourceContext` 调用方测试 |
| 新增兼容测试 | 7/7 通过；含旧缓存键、设置语义、手册入口及本地 relay 协议响应，外部 fetch 被禁止 |
| 类型与构建 | App、Node 类型检查和隔离生产构建均 exit 0；不代表 APK 或设备验证 |
| 主版本浏览器切片 | 1100px 中文浅色、390px 中文墨水屏、390px 英文深色三组通过；无外部请求或捕获的页面异常 |
| 完整卡片套件 | 27/27，通过实际、无诊断插桩的主树 SFC/helper；覆盖动态定位、iframe、负向 Range、长内容、清理、触摸和键盘 |
| 实际 ReaderView 调用方 | 11/11；挂载阅读器及合成 TXT 书，模拟模型传输；覆盖上下文、失败重试、旧流、翻页/关闭/返回取消。PDF 仅调用方静态检查及构造器浏览器 oracle，不含 PDF 渲染 |
| 浏览器覆盖 | 状态控件无正文尺寸位移、48px 尺寸、底栏避让、弹窗边界、状态动作/Esc/焦点、短卡片与要句原文入口、六组主按钮文字和焦点对比度 |
| 兼容性比较 | 10 个模块/设置在明确内部名称及导入路径替换后编译运行时代码一致；CFI、安全处理、分页器、PDF、启动及包文件保持冻结哈希 |
| 已有改动保护 | 冻结写入集之外的已记录源文件未发现字节漂移 |

三配置切片及完整卡片套件均使用合成数据；390px 触屏上下文实际执行 `.tap()`。截图已检查长内容及操作区边界。它们不冒充真实 BOOX。最近 LSP 抽测四个改动文件：三项确认 clean，一项超时未确认；未声称完整「零诊断」。App/Node 类型检查与构建证据单列。

## 单行样式修复与焦点回归

用户明确批准后，仅把全局减少动态规则中的 `transition-duration: 0.01ms !important` 改为 `0s`。相对追加冻结基线，整份 CSS 除该值外字节一致，动画规则未动。两组 A/B 各 11 项：原值 7 通过/4 失败，修复组 11/11；计算 transition 从 `1e-05s` 变为 `0s`，animation 两组均为 `1e-05s`。普通动态模式另行实测源元素及卡片 duration 均为 `0s`。这确认了本轮可复现异常与该规则的因果关系，不证明所有设备表现。

隔离及初次主树卡片套件各 23/23。完整阅读器首轮 9 项通过，旧夹具在功能关闭时注入卡片而被正确的停用守卫阻止；仅为合成书开启智能版、隔离后台分析 I/O 后 11/11，未放松生产守卫。

独立最终复核曾以首次聚焦时序问题判 BLOCK：原键盘测试手动 focus 掩盖了问题。新增负向回归最初两项均失败；仅增加 nextTick 仍失败，因为测量实际由 rAF 排队。同步初始测量后，父文档及 iframe 首次聚焦、Tab、Escape 均通过；这时首次暴露 Escape 只恢复 iframe、不恢复其内部原按钮的另一条件。增加精确焦点路径恢复后，该阶段套件 **26/26**，包含原按钮恢复及宿主/阅读区/iframe 滚动位置不变。原有失败回执、原始条件及计数保留在 `motion-fix-1/focus-review-1/conditions.json`，不重置旧定位计数。

随后的真实接缝复核判 P1：Foliate view 和 paginator 均使用 closed ShadowRoot，公开 `.shadowRoot` 无法取得内部焦点。修复改为仅在 Range 所属文档实际持有焦点时，利用该已知文档及其 frameElement 路径保存内部控件；没有打开 ShadowRoot、移动 Range 或导航。新增双层 closed root＋同源 iframe 原生点击用例，先核验宿主重定向、两个公开 root 均不可见及源文档持有焦点，再断言卡片首次聚焦、Tab/Shift+Tab、Escape、原内部控件恢复及滚动不变。最终完整套件 **27/27**，同一返回焦点条件累计第三次执行通过，未重置计数。

最终独立复核：**No issues found，acceptance=OK，Merge verdict=OK with notes**，仅限冻结的 48 个代码/测试文件与合成验证。闭合根 P1 已解除；复核者未改代码、未代跑测试。最终源码哈希再次核对无漂移。

最终完整阅读器 11/11，捕获的页面异常和外部请求均为零；控制台有一次 `ResizeObserver loop completed with undelivered notifications`。独立复核认为现有证据不足以仅凭该通知阻塞，也不足以认定无影响。保留为长期/实机观察风险，不隐藏通知或据此宣称无警告。

## 历史停止与诊断（不代表当前状态）

初次独立审查指出当时两项原始需求未在主版本完成：

1. 卡片仍使用打开时的矩形；未完成随原文、滚动、内容变化重新定位及失效 Range 关闭。
2. 长释义/译文仍缺少视口限高和内部滚动，操作按钮可能超出视口。

候选补丁在独立工作树出现三项失败：`UI-LAYOUT-MUTATION`、`UI-FRAME-GEOMETRY`、`UI-INVALID-RANGE-CLOSE`。第一项达到原三次失败上限后停止，未合入候选，也未把子代理正常退出当作功能通过。

用户批准的一次追加验证已执行：**18 项通过、4 项失败，exit 1**。已修正独立 collapsed/disconnected 样本并保留真实断言，诊断通过测试期变换注入，未修改候选生产逻辑。

新增证据确认 mutation 过滤、schedule、rAF、place 和 DOM 提交均有执行，但几何采样与之后对同一目标的测量不一致，尚未证明唯一根因。iframe 正向样本的实际计算可见性为 hidden，前置条件不成立，不能据此修改偏移公式。候选中的折叠/删除原文关闭、内滚动和合成触摸等独立切片通过，不代表整体通过。

用户随后批准一次定向修复验证：候选改用 `getBoundingClientRect()` 并先读布局再检查可见性；iframe 正向样本显式显示并检查计算状态。第五次验证仍为 **18 项通过、4 项失败，exit 1**，表明仅调整采样 API/顺序的假设不足以修复问题，未证明唯一根因。

**第五次候选未合入，主生产源码冻结哈希保持不变。** 当时停止了完整原卡片脚本；下述另行授权的分层诊断实际涉及卡片失败面，继续累计而非重置计数。

随后获准执行一次不含 Vue/Vite/应用样式/伴读代码的最小 DOM/Range 诊断：同一 Edge 156.0.4314.36、两个独立上下文，**58/58 检查通过，exit 0**。两种读取顺序下，原生矩形 API 均一致；margin 变化同步移动 80px，滚动移动 −40px，隐藏/显示与 iframe 类名/内联可见性切换均正常。无页面异常或外部请求，主生产源码未变，未重跑原卡片断言。

随后获准执行最多五组分层对照，已全部完成：纯 DOM、Vue 浏览器构建、Vue+Vite 三组均为 7/7；加入应用 CSS 后为 5 通过、2 失败；再加入未合入卡片候选后为 6 通过、5 失败。总计 **32 通过、7 失败，exit 1**，无初始化错误、外部请求或源码变化。卡片相关稳定计数推进至 6/5/4；未重跑完整原卡片脚本或开启后续修复。

触发层已缩小到应用样式。`reader/src/styles/main.css:701–710` 的减少动态规则给所有元素设置正值 `transition-duration: 0.01ms !important`；由于默认 `transition-property` 为 all，这可能向原本无过渡的 margin/visibility 等属性引入过渡，与首帧采旧值、之后值变化但无新属性通知的观测一致。分层诊断结束时尚未单独 A/B 验证，因此当时不能把候选机制当作已证实根因。

此后用户另行批准单行修复、A/B 及完整卡片复验，结果见上节。原定位失败累计从 6/5/4 经授权 A/B 的原值对照推进到 7/6/5；记录保留，修复组和主树通过不删除历史失败。

真实设备的触摸、残影、内存/能耗、Android WebView 与软键盘表现仍未验证。首次独立审查对当时已完成子集未发现新增合格实现问题；后续独立复核亦确认新增局部对比度/焦点及验证改动为 **OK**。这两次历史复核对当时全部原始需求的结论为 **BLOCK**，不构成最终版本批准。复核者未修改文件或重新执行测试。

## 证据入口

- `.cache/companion-20261020/motion-fix-1/results.json`、`scope.json`、`before/`：单行授权、原始字节及 A/B；最初加载超时执行 0 断言，修正测试加载方式后执行对照，未修改生产源码绕过。
- `.cache/companion-20261020/card-browser/main-closed-focus-final-1/browser-results.json`：最终 27 项真实组件检查及截图；`main-motion-1/` 保留最初 23 项通过回执。
- `.cache/companion-20261020/motion-fix-1/focus-review-1/`：首次聚焦与返回焦点红/绿回执、条件计数、阶段性 ReaderView 11 项结果。
- `.cache/companion-20261020/motion-fix-1/closed-focus-1/`：闭合根修复前源码及最终完整 ReaderView 11 项结果；`independent-closed-shadow-review.md` 保留实际接缝 P1 原文。
- `.cache/companion-20261020/lsp-final.json`：实际 LSP 覆盖和未完成项，不替代编译器证据；闭合根最终编辑获 on-edit JS/TS clean，随后 App/Node 类型及构建重跑通过。
- `.cache/companion-20261020/baseline.json`、`baseline/`、`baseline-*-additions.json`：当前脏工作树基线，不是仅用干净 HEAD。
- `.cache/companion-20261020/integrated.diff`、`change-manifest.json`：相对该基线的已集成差异；报告和新增验证资产纳入后刷新。
- `.cache/companion-20261020/acceptance.json`：最终源码及合成验收的机器可读汇总，保留历史失败和未验证范围。
- `.cache/companion-20261020/independent-final-review.md`、`review-final.json`、`review-source-freeze.json`：最终独立复核原文、范围及 48 个代码/测试文件哈希绑定。
- `.cache/companion-20261020/verification.json`、`unit-final.log`、`compat.log`、`inspection-before.log`、`inspection-after.log`、`build.log`。
- `.cache/companion-20261020/independent-contrast-review.md`、`review-followup.json`：后续独立复核原文及范围。
- `.cache/companion-20261020/protected-comparison.json`、`browser/results.json` 及 `browser/*.png`。
- `.cache/companion-20261020/ui-additional-round.md`：追加授权及停止边界。
- `.cache/companion-20261020/contrast-before.json`、`contrast-after.json`、`contrast-after.log`：独立局部对比度修复的红/绿证据。
- `.worktrees/companion-ui-20261020/.cache/companion-lane/attempt4/handoff.md`、`browser-results.json`、`diagnostic-findings.json`：首次追加诊断的失败回执。
- `.cache/companion-20261020/attempt5/handoff.md`、`preflight.json`、`browser-results.json`、`run.log`：后续定向修复验证及主源码未变的证据。
- `.cache/companion-20261020/minimal-dom-1/report.md`、`probe.mjs`、`fixture.html`、`results.json`：无 Vue 最小诊断及 58 项实际通过结果。
- `.cache/companion-20261020/layers-1/report.md`、`probe.mjs`、`started.json`、`results.json`：五组分层对照、实际输入及应用样式触发层证据。
- `.worktrees/companion-ui-20261020/.cache/companion-lane/handoff.md` 与诊断/失败记录：未合入候选的证据，不能替代主版本验收。

回退仅针对本轮差异，并先核对当前哈希；不得重置工作树或覆盖原有无关改动。

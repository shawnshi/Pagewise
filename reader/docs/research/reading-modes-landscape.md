# 阅读模式全景 · 调研与信息架构

> 2026-10-05 · 状态：调研稿，未实现 · 前置文档：`docs/reading-modes.md`（已评过 Bionic、RSVP、阅读尺、BeeLine、中文分词着色，本文不重复，只引用其结论并扩展）
> 范围：可重排书籍（foliate：EPUB/MOBI/AZW3/FB2 + TXT/MD/HTML）；PDF/DjVu 只在相关处注明

## 0. 结论

1. **定名 11 个模式，一个名字对应一个模式**：夜间、护眼、墨水屏、沉浸、双栏、大字、听书、打字机、歌词、仿生阅读、自动翻页。所有别名只在 §1 的对照表里出现一次。旧设计稿里的「行聚焦（阅读尺）」**并入「歌词」**（歌词的手动驱动就是阅读尺），不再单列。
2. **信息架构按「它改变了什么」分 3 组，放在同一个「阅读模式」面板里**（§5）：
   - **显示**（夜间、护眼、墨水屏、大字）：开关类，长期生效，本质是一组排版/配色参数的预设。夜间、护眼不新增配色，只是套用现有正文主题，正文主题仍是唯一的配色来源。
   - **版面**（沉浸、双栏）：开关类，长期生效。
   - **带读**（自动翻页、打字机、歌词、听书）：**同一时刻只能运行一个**，有「开始/暂停」，共用一个阅读光标和同一个速度单位 `字/分`。仿生阅读是一个可叠加在任何模式上的「实验」开关。
3. **歌词是本轮新增模式里最值得做的**。做法是当前行固定在屏幕约 40% 高度处，其余行压暗，按 `字/分` 逐行前进，也可以跟随听书或手动推进。主流中文阅读器里**没有找到公开资料证明有人做过这个模式**；英文世界最接近的是 Voice Dream Reader（可选只显示 1/3/5 行，加上聚焦阅读的自动滚动）和微软沉浸式阅读器的 1/3/5 行聚焦（手动）。研究上，1–3 行的窗口比 ≥4 行的窗口**读得略慢，但理解程度相同**（Duchnicky & Kolers 1983）。所以默认设置是「1 行高亮，上下文淡显而不隐藏」，同时保留 3 行档位。详细规格见 §4。
4. **大字**按工信部适老化规范给出具体数值：正文从 24px 起，「特大」为 30px；行距 2.0；字距 0.05em；单栏；界面按钮放大到 ≥60dp；把听书放到最显眼的位置（§6.4）。
5. **护眼要说实话**：防蓝光眼镜对视疲劳「可能没有差别」（Cochrane 2023），只改色温不降亮度对褪黑素没有可测出的帮助（Nagare 2019），豆沙绿护眼没有研究支持。所以护眼模式 = **暖色主题 + 应用内调暗 + 20 分钟休息提醒**（20-20-20 规则有 RCT 支持，但效果小），界面文案不承诺「保护视力」（§6.2）。
6. **优先级**：P0 = 面板改版 + 歌词 + 大字 + 沉浸（Android 隐藏系统栏、阅读时保持屏幕常亮）；P1 = 墨水屏、护眼（提醒和调暗）、听书×歌词跟读、夜间定时；P2 = 仿生阅读、勿扰、三栏（§7）。

## 1. 命名对照（别名只在这里出现）

| 定名 | 曾用名 / 竞品叫法 / 别名 | 现状（2026-10-05 代码） |
|---|---|---|
| 夜间 | 深色模式、暗黑模式、夜间模式、Dark mode | **已有**：正文主题 `dark`（#17181a / #c5c8ce，对比度 10.6:1）；`auto` 跟随应用外观 |
| 护眼 | 羊皮纸、米黄、暖色、减少蓝光、豆沙绿、护眼绿、Sepia | **部分**：有主题 `sepia`（9.8:1）和 `green`（10.2:1），没有休息提醒，也没有应用内调暗 |
| 墨水屏 | 电纸书模式、E-ink / Paper 模式、水墨版 | **缺失**：翻页动画始终开启（`renderer.setAttribute('animated','')`），没有纯黑白配色，也没有设备识别 |
| 沉浸 | 禅定、Zen、专注、全屏、无干扰 | **部分**：阅读时工具栏自动隐藏；桌面和网页有全屏按钮（Tauri `setFullscreen` / Fullscreen API）；Android 只做了 edge-to-edge 系统栏配色（`MainActivity.kt`），**没有隐藏状态栏和导航栏，也没有屏幕常亮** |
| 双栏 | 分栏、杂志模式、对页、Spread | **已有**：`maxColumnCount` 可选 1 或「自动双栏」（宽度够时自动分两栏） |
| 大字 | 老人模式、长辈模式、关怀模式、适老化、大字号 | **部分**：字号 8–64（滑条 12–64）、行距 1.2–2.6、页边距 2–16% 都能调，但没有一键预设，界面按钮也不会随之放大；没有字距设置 |
| 听书 | 朗读、TTS、跟读、Read-along、Read Aloud | **已有**：句级高亮、句/段跳转、断点续读、剩余时长、定时关闭、连续播放（v1.6.0） |
| 打字机 | 逐字显示、逐步显示 | **已有 P0**：逐字/逐句/逐行，`字/分`，后文隐藏或淡显，墨迹未干，打字声 |
| 歌词 | 单页单行、单页三行、聚焦行、行聚焦、阅读尺、提词器、Teleprompter、Line focus、Reading ruler | **缺失**：`settings.readingMode.lineFocus` 只有字段，面板里只有「自动翻页 / 打字机」两个分段 |
| 仿生阅读 | Bionic Reading、词首强调、分词着色、词块引导 | **缺失**：`settings.readingMode.wordGuide` 只有字段 |
| 自动翻页 | 自动阅读、自动滚屏、Auto-scroll | **已有**：按秒/页计时（3–60 秒），已迁入阅读模式面板 |

**命名风险**：「仿生阅读」是 Bionic Reading（注册商标）的通行中文译名。中文界面用这个名字是用户的决定，可以接受，但**英文界面不要出现 "Bionic"**，建议写作 *Word-start emphasis*；文案里也不要使用「提速」类说法（证据 A−，见 `reading-modes.md` §2.2）。

## 2. 调研：呈现方式的分类

把各家产品的「模式」拆开看，都是下面四个维度的组合。LightRead 也按这四个维度设计，这样不会出现第 12、13 个名字：

| 维度 | 取值 | 对应定名 |
|---|---|---|
| **配色与字形**（静态） | 日间 / 夜间 / 暖色 / 纯黑白；字号、行距、字距、字重 | 夜间、护眼、墨水屏、大字 |
| **版面与移动方式** | 分页（覆盖/滑动/仿真/无动画）、纵向滚动、单栏/多栏、全屏 | 双栏、沉浸、墨水屏（无动画） |
| **注意力引导**（动态，有光标） | 无 / 后文隐藏（打字机）/ 聚光（歌词：当前行亮、其余暗）/ 单词闪现（RSVP，不做）/ 按段（段落模式） | 打字机、歌词 |
| **驱动来源** | 手动 / 节拍（`字/分` 或 秒/页）/ 语音（听书） | 自动翻页、听书，以及打字机和歌词的「驱动」选项 |
| 叠加的文字标记 | 词首强调、分词着色、行色渐变（BeeLine，不做） | 仿生阅读 |

### 2.1 「歌词式」和相近呈现：谁在做、怎么做

| 产品 | 呈现 | 驱动与速度 | 值得借鉴的细节 | 证据级别* |
|---|---|---|---|---|
| **Voice Dream Reader**（iOS/Mac，视障和读写障碍用户群体大） | 屏幕上可只显示 **全部 / 5 / 3 / 1 行**；高亮可以是词、行或句；有「聚焦阅读」（缩小文字区并自动滚动）；「Pac-Man」模式让已经读过的文字消失；也有 RSVP[^vd][^vd2] | 跟随 TTS | 「显示几行」和「高亮什么」是两个独立的设置项 | 二手资料（官方页面已 404，来自评测和搜索摘要），中 |
| **微软沉浸式阅读器**（Word/Edge/Teams/OneNote） | 行聚焦 1/3/5 行，其余变暗 | **手动**：↑/↓ 键或屏幕箭头 | 默认手动，不自动前进[^immersive] | 官方文档，高 |
| **Readwok**（网页） | 4 种视图：单段 / 当前段 + 已读段 / 渐进滚动 / 全部 | 自动播放，速度用 **「每个字符的时间」** 设置[^readwok] | 「当前段 + 已读段」能保留回看 | 官方页面，高 |
| **Readest**（同样基于 foliate） | 段落模式（#1844 → PR #3096）、RSVP、阅读尺[^readest-para] | 手动 | 同类开源项目已经把「按段聚焦」做成了模式 | GitHub，高 |
| **Nook / FocusReader / ADHD Reading Focus**（浏览器扩展和 App） | 一次只显示一行或一段，用遮罩压暗其余部分；可自动前进，进度条显示倒计时[^nook][^adhdext] | 自动，按 WPM | 卖点是 ADHD；宣传里的「0% 理解损失」「完全弥合 ADHD 差距」属于**营销说法，没有找到原文出处** | 营销，低 |
| **提词器 App**（Teleprompter.com、Lines 等） | 连续滚动，**阅读线放在屏幕上 1/3 处** | WPM（如 40–450），或 行/分、像素/秒、秒/屏；空格暂停，方向键调速，开始前 3 秒倒计时[^tp][^tp2] | 速度单位之间可以互相换算：WPM ÷ 每行词数 = 行/分 | 产品文档，高 |
| **Moon+ Reader** | 5 种自动滚动：卷帘（屏幕上方一条线逐像素揭开下一页）、按像素、**按行**、按页等 | 实时调速，音量键调速[^moon] | 「按行跳」是一种离散的滚动方式，适合墨水屏 | 商店页面和评测，中 |
| **Apple Music / QQ 音乐 歌词页**（交互原型） | 当前句居中、放大或提亮，其余句变暗或模糊；逐字填色；**点哪一句就跳到哪一句**；用户手动滚动后暂停跟随，并出现「回到当前」按钮[^am] | 跟随音频时间戳 | 这几种交互可以直接照搬到阅读里 | 开源复刻和说明，中 |
| **极简单行阅读器 / Thief-Book**（中文「摸鱼」工具，Windows、VS Code、IDEA） | **一次只显示一行**（状态栏或透明小窗），有单行和多行模式；可自动播放；「听书带字幕」[^dxd][^thief] | 自动或快捷键 | 中文用户已经接受「单行阅读」这种形态，只是用途是藏起来看书 | 产品页面，高 |
| 微信读书、番茄、起点、掌阅、QQ 阅读、七猫 | **没有找到歌词式单行/三行聚焦模式的公开资料**。有的是：自动阅读（微信读书：长按暂停、轻点快进），翻页方式有覆盖/仿真/滑动/上下滚动，掌阅/起点有「滚屏」式自动阅读[^weread][^qidian]；听书页面是否显示同步文稿，也没有找到资料 | — | 这是空白点，也是差异化机会 | 未找到 ≠ 不存在，低 |
| Kindle 沉浸式阅读 / Apple Books 朗读 | 有声书配合电子书，**逐词或逐句高亮**；Apple Books 可以选择朗读完一页后自动翻页（EPUB 媒体覆盖，仅限固定版式书）[^kindle][^apple] | 跟随真人录音 | 「自动翻页 / 手动翻页」是朗读的一个子选项 | 官方，高 |
| Speechify / ElevenReader | 逐词高亮 + 「自动滚动」开关[^speechify] | TTS | 高亮和自动滚动分成两个开关 | 官方，高 |

\* 证据级别指的是「这个产品确实有这个功能」这件事的来源可靠程度，不是功能效果的证据。

### 2.2 效果证据（只列本文新增的；旧文档的评级口径不变：A 一致 / B 少量正向 / C 间接或厂商 / A− 证据充分但结论为无效或有害）

| 结论 | 证据 | 评级 |
|---|---|---|
| **窗口只有 1–3 行时读得略慢，但理解程度不受影响**；4 行和 20 行没有差别 | Duchnicky & Kolers 1983（Human Factors）：比较了 1/2/3/4/20 行的窗口，4 行和 20 行比更少的行数读得快，各条件下理解没有差别；常被引用的数字是 1–2 行时**约慢 9%**。被试可以自己调节滚动速度，阅读速率按「行/秒」换算[^dyson]；Dyson 2004 综述：窗口大小对速度和理解的影响很小，但主观上**大家更偏好大窗口**[^dyson] | **B**（样本少、年代早、是西文显示终端，但方向一致） |
| 平滑滚动的「走马灯」式文字，理解程度不低于 RSVP，而且更受偏好 | Kang & Muter 1989：100–300 wpm 时，平滑横向滚动的理解程度至少和 RSVP 持平，被试明显更喜欢平滑滚动[^kang] | B |
| 在手机上，**分页最快、负担最小**；「走马灯」会让眼动变得不规则，主观负担更高 | Öquist & Lundin 2007：比较分页、滚动、走马灯、RSVP 四种方式，分页明显更快，理解没有差别；按 NASA-TLX 量表，分页的负担明显低于走马灯和 RSVP[^oquist] | B |
| 自动滚动的文字，理解程度和工作记忆有关 | Harvey & Walker 2018（QJEP，横向滚动文字）[^harvey]（只读到标题和摘要片段） | C |
| 不能回看会损害理解 | Schotter 2014、Rayner 2016（见旧文档） | A |
| 边听边读的理解程度和单独读、单独听相同（成人） | Rogowsky 2016（91 人随机分组，即时测试和两周后测试都没有差异）[^rogowsky] | B |
| 朗读辅助对 ADHD 和学习障碍有小幅帮助 | 旧文档的综述和元分析 | B |
| 行聚焦（阅读尺）能提速，读写障碍者获益最多，但**没有一种样式是所有人都偏好的** | CHI 2023（旧文档） | B |

**推导出的设计原则**（歌词模式直接采用）：
1. 默认**不要只剩 1 行**，上下文要保留：其余行淡显而不是隐藏，这样不会损失回看能力和对下一行的预读（下一行是在眼睛余光里提前看到的）。「纯净单行」作为可选项提供。
2. 驱动方式默认**跟随听书**或**手动**；节拍驱动（自动前进）作为第三种方式，速度默认值低于自然默读速度。
3. 位置推进用**离散跳行**（平滑过渡约 250ms）而不是匀速爬行：Öquist 的研究表明连续移动的文字眼动不规则，负担更高；离散推进也更适合墨水屏。
4. 不宣传「提速」，定位是**专注、跟读和不跳行**。

## 3. 各模式卡片（按定名）

> 格式：场景 · 证据 · 普遍程度 · 可借鉴的交互 · 无障碍 · LightRead 现状 → 建议

### 3.1 夜间
- **场景**：环境暗、睡前、OLED 手机省电。
- **证据**：在正常照明下，**深色字、浅色底的阅读和校对成绩更好**，对年轻人和老年人都成立。机理是背景越亮瞳孔越小，看细节越清楚（Piepenbrock 2013 等）[^piep] → **A（指日间阅读表现）**。深色模式可能减少近视风险：Aleman 2018 发现读白底黑字 1 小时脉络膜变薄约 16µm，读黑底白字变厚约 10µm[^aleman]，但这只是短期替代指标，样本小，没有近视结局数据 → **C**。
- **普遍程度**：所有阅读器都有。
- **可借鉴**：按时间或日出日落自动切换（KOReader 的 Auto Warmth and Night Mode 插件[^ko]）；KOReader 的夜间是反色。
- **无障碍**：夜间对比度不要拉满（纯白字配纯黑底在 OLED 上会拖影、产生光晕），现有 10.6:1 合适。
- **现状 → 建议**：主题 `dark` 已有。在面板里做成一键开关（开 = `theme:'dark'`，关 = 恢复之前的主题，**不新增主题**）；P1 增加「按时间自动」（如 22:00–7:00）。

### 3.2 护眼
- **场景**：长时间阅读，觉得白底刺眼。
- **证据（如实说）**：
  - 防蓝光镜片对视疲劳、视觉表现和睡眠「可能没有差别」（Cochrane 2023，17 项随机对照试验）[^cochrane] → **A−**（指「减少蓝光能护眼」这个说法）。
  - iPad 夜览（Night Shift）只改色温不降亮度，对褪黑素抑制没有可测出的改善，**亮度才是关键**（Nagare 2019，12 人）[^nagare] → B。
  - 豆沙绿护眼：没有研究支持，被认为是「看远处绿色植物」的讹传；绿底唯一的作用可能只是让屏幕没那么刺眼[^green] → **无证据**。
  - 20-20-20 规则（每 20 分钟看 6 米外 20 秒）：随机交叉研究显示，数码视疲劳和干眼**症状**有改善，但改善幅度可能不到临床意义的程度，两周内体征没有变化（Talens-Estarelles 2023）[^2020] → **B**。
  - 墨水屏的视疲劳和纸书相近，LCD 会让眨眼次数下降、疲劳更明显（Benedetto 2013）[^benedetto] → B（说明「眨眼和休息」比「换颜色」更重要）。
- **普遍程度**：中文阅读器几乎都有「护眼模式」，通常就是绿色或米黄背景。
- **建议**：护眼 = 一键开关，包含三件事：① 套用暖色主题（默认米黄 `sepia`，可改为 `green`，**沿用现有主题，不新增**）；② **20 分钟休息提醒**（不打断阅读的轻提示「看看远处 20 秒」，可以「稍后」，打字机、歌词、自动翻页运行时顺带暂停；间隔可选 20/30/45 分钟）；③ **应用内调暗**（Android 用原生 `WindowManager.LayoutParams.screenBrightness` 只调本窗口亮度，其他平台用半透明遮罩，见 §6.2）。文案写「暖色柔和背景，并提醒你定时休息眼睛」，**不写「防蓝光」「保护视力」**。

### 3.3 墨水屏
- **场景**：Boox、海信 A 系列、掌阅 iReader、Bigme、Meebook 等安卓墨水屏设备（可以侧载 LightRead APK）。
- **证据**：以工程问题为主（刷新慢、残影、灰阶有限），不涉及效果证据。
- **竞品做法**：
  - **Readest**：自动识别 Boox、Kindle、Kobo 等设备，开启后减少或关闭动画、使用高对比配色、简化过渡效果；设置里可选自动、强制开、强制关[^readest-eink]。
  - **KOReader**：全刷频率可设（如每 N 页，或「从不」）、关闭界面黑闪、夜间用反色[^ko]。
  - **微信读书墨水屏版**：独立的 App，界面只剩一个主屏，排版只能调字体和字号，翻页可改为平移、左侧点击也翻下一页[^weread-ink]。
  - **Boox 系统**：可以按 App 单独设置刷新模式、加深浅色文字、漂白背景、DPI[^boox]，所以 App 自己**不需要也不应该去控制 EPD 刷新**。
- **建议（P1）**：
  - 开关为「自动 / 开 / 关」。Android 原生读取 `Build.MANUFACTURER/MODEL` 匹配白名单（ONYX、Hisense 墨水屏型号、Zhangyue/iReader、Bigme、Meebook、Boyue 等），把结果传给前端。
  - 开启后：配色变为纯白底纯黑字（21:1），夜间配合变为纯黑底纯白字；正文字重 +100（相当于 Boox 的「加深」）；去掉 foliate 的 `animated` 属性；外壳加类名后用 `transition/animation: none`；骨架屏不闪烁；关闭平滑滚动；划线改为灰底加下划线（彩色在灰阶屏上分辨不出来）。
  - 带读类模式自动适配：打字机强制使用「逐句」或「逐行」；歌词改为「整屏跳」（当前行到达屏幕 80% 处时一次性重新定位，而不是每行都滚动）；自动翻页不变。
  - 「每 N 页黑白闪一次清残影」只作为实验项，要在 Boox 实机上验证有没有用。

### 3.4 沉浸
- **场景**：只想看字，不想看到时间、电量、通知。
- **可行性（按平台）**：

| 能力 | Android（Tauri WebView） | 桌面（Tauri） | 网页 PWA |
|---|---|---|---|
| 隐藏状态栏和导航栏 | ✅ 原生：`WindowInsetsControllerCompat.hide(systemBars())` + `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`（从边缘滑出后会自动收回），要改 `MainActivity.kt` 和 `systemBars.ts` | ✅ 已有全屏 | ⚠️ Fullscreen API：安卓 Chrome 和 iPad 可用，**iPhone Safari 不支持对元素全屏** |
| 阅读时屏幕常亮 | ✅ 原生 `FLAG_KEEP_SCREEN_ON` 最稳；网页的 Wake Lock API 在 WebView 中的支持有限制（可能被 Permissions Policy 禁用）[^wakelock] | 一般不需要 | ✅ `navigator.wakeLock`（Baseline 2025），失败时静默处理 |
| 屏蔽通知（勿扰） | ⚠️ 需要用户在系统设置里授予「勿扰权限」（`ACCESS_NOTIFICATION_POLICY`）。**targetSdk ≥35 时，`setInterruptionFilter` 不再改变全局勿扰状态，而是创建一条属于本 App 的隐式 AutomaticZenRule**[^a15]。我们的 targetSdk 是 36 | ❌ | ❌ |
| 隐藏阅读器内的页眉页脚 | ✅ 纯前端 | ✅ | ✅ |

- **建议（P0）**：沉浸 = 一键开关：隐藏系统栏 + 屏幕常亮（阅读页内有效，**无操作 10 分钟后释放**，避免手机放着一直亮）+ 页脚只保留极简页码（可关）。勿扰放到 P2，做成「开启沉浸时顺便开勿扰」的显式选项，第一次使用时引导授权，并说明会出现在系统「模式」列表里；授权前**只提供「去系统勿扰设置」的快捷入口**。
- **无障碍**：系统栏隐藏后，用户必须能从屏幕边缘滑出系统栏；沉浸状态下点一下屏幕中间仍然会呼出工具栏。

### 3.5 双栏
- **场景**：横屏平板、桌面宽屏，像杂志一样分栏。
- **证据**：每行字数比列数更影响阅读速度（每行字多读得快，但大家主观偏好中等行长）；有研究里双栏被评为更有条理、更好读[^dyson] → B（西文）。中文最佳行长没有找到可靠的数据。
- **现状 → 建议**：已有「单栏 / 自动双栏」，foliate 的 `max-column-count` 也支持更大的值。建议在面板里给一个开关（等同于现有设置，保持同一个数据源）；只在超宽桌面窗口（例如 ≥1800px 且每栏 ≥30 个汉字）才开放「三栏」（P2）；大字和歌词运行时**强制单栏**。

### 3.6 大字
见 §6.4（具体数值）。证据要点：
- 工信部《移动互联网应用（APP）适老化通用设计规范》（2021）：适老版的主要文字 **≥18dp**，主要功能的最大字体 **≥30dp**；适老版主要组件的点击区域 **≥60×60dp**（其他页面 ≥44×44dp）；对比度 ≥4.5:1（大于 18dp 的文字 ≥3:1）；禁止广告弹窗和诱导按钮[^miit] → 规范，必须遵守的下限。
- 大字印刷品：通常为 16–18pt；RNIB 的最低标准是 14pt，常用 16pt[^rnib]。低视力人群从 10pt 增大到 16pt，中位速度从 144 提高到 163 wpm[^lp] → B。
- 读写障碍：加大字距能减轻「拥挤效应」，提高速度和准确率（Zorzi 2012，PNAS，8–14 岁儿童）；有争议，但后续有重复验证[^zorzi] → B（人群是读写障碍儿童，不是老年人，**只作为适度加字距的依据**）。
- 竞品：主流中文阅读 App 的「长辈模式」没有找到公开资料；UC 大字版对小说阅读做过适老化（大色块目录、放大字体、看累了可以听书），七猫听书 App 以极简界面适合老年人为卖点[^elder-cn]。**听书是老年人群的核心需求**。

### 3.7 听书
- **现状**：已经比较完整（v1.6.0）。
- **证据**：成人边听边读的理解程度和单独读、单独听相同（Rogowsky 2016，B）；对二语学习者、读写障碍和 ADHD 有小幅帮助（B）。
- **可借鉴**：Voice Dream 的「显示几行 + 高亮粒度」；Kindle 的逐词高亮；Apple Books 的「读完一页自动翻页 / 手动」；Speechify 的「自动滚动」开关；Apple Music 的「手动滚动后暂停跟随，出现回到当前按钮」。
- **建议（P1）**：听书面板加一个按钮「歌词视图」，相当于用听书驱动歌词模式（§4.3），这就是「跟读」。现有的「回到朗读位置」按钮和歌词模式的「回到当前行」统一成同一个组件。

### 3.8 打字机
已有 P0，见 `reading-modes.md` §3.1。本轮的调整只有：**与歌词共用速度设置**（同一个 `字/分`，在两个模式间切换时速度不变），并且和歌词互斥。

### 3.9 歌词
见 §4（详细规格）。

### 3.10 仿生阅读
证据见旧文档：西文词首强调的提速说法为 A−；中文分词着色为 B，对老年人略有帮助，但分词错误有害。建议保持 P2、标注「实验」、默认关闭，作为一个开关可叠加在任何模式上。

### 3.11 自动翻页
- **现状**：按秒/页。
- **建议**：保留现有行为。在设置旁边换算显示「≈ X 字/分」（按本页字数估算），让三种节拍模式的速度感一致。滚动排版下改为**按行跳动的匀速滚屏**（类似 Moon+ 的「按行」，每次滚一行，间隔由 `字/分` 推算），不做逐像素爬行（依据 Öquist 2007 和墨水屏的需要）。
- **合并**：「平滑滚屏」不再单独成为一个模式，它就是「自动翻页 · 滚动排版」。

### 3.12 不纳入的形态
RSVP、BeeLine（旧文档已经否决）；**段落模式**（Readest/Readwok）作为歌词的「聚焦单位：行/段」选项放到 P2，不单列；**双语对照**和**仿真翻页动画**属于功能或设置，不是阅读模式。

## 4. 歌词模式交互规格（P0）

### 4.1 定位
「像看歌词一样读书」：当前行固定在视线高度，按节奏、跟随朗读或由你自己一行一行往前走，其余文字淡下去但始终看得到。**价值是不跳行、不走神、跟读，不承诺提速。**

### 4.2 呈现
| 项 | 规格 | 理由 |
|---|---|---|
| 排版 | 开始时**临时**切换为滚动排版（`flow=scrolled`）并强制单栏，退出时恢复原设置 | 分页排版里当前行无法固定在屏幕中间 |
| 当前行位置 | 视口高度的 **40%**（可选 50% 居中）；居中时上方留出已读上下文 | 提词器的阅读线在屏幕上 1/3 处；歌词则居中 |
| 聚焦行数 | 分段控件 **[ 1 行 \| 3 行 ]**，默认 **1 行** | 用户原话；Voice Dream 和微软都提供 1/3（以及 5） |
| 3 行的含义 | 当前行加上下各一行都是全亮，当前行左侧有一条 3px 强调色竖条（墨水屏用实心黑条）；**每次前进一行**（滑动窗口），而不是一次跳 3 行 | 和微软行聚焦一致；滑动窗口更连贯 |
| 其余行 | 分段控件 **[ 淡显 \| 隐藏 ]**，默认淡显，用正文色的约 **30%**；「隐藏」即纯净提词器（等同于只看一行） | 保留回看和预读（§2.2 原则 1） |
| 「模糊」 | 不提供 | `::highlight` 不能设置模糊；在外壳上用 `backdrop-filter` 盖住 iframe 的效果和性能都需要实测，减少动效和墨水屏下也得关掉，收益很小 |
| 字号 | 可选「歌词字号」：默认 **正文字号 ×1.2**（18→22），行距至少 2.0；进入模式时重排一次，退出时恢复 | 每行字少一些、行间距大一些，聚焦带更容易分辨；**只在进入和退出时重排** |
| 已读行 | 与「其余行」一样淡显；**不改变颜色深浅来区分已读和未读** | 避免出现三种以上的亮度层级，视觉负担过重 |
| 实现 | CSS Custom Highlight：`lr-ly-dim` 覆盖「整节减去聚焦带」，只改颜色，**不改 DOM、不影响 CFI**；不支持时用 overlayer 画半透明的主题背景色矩形（打字机的 `revealLayer` 已经有这条回退路径） | 复用打字机的基础设施 |

### 4.3 驱动（一个光标，三种来源；分段控件 **[ 自动 \| 跟读 \| 手动 ]**）
- **自动（节拍）**：与打字机共用 `pacing.ts` 的字符时间表。**一行的停留时间 = 这一行的字当量 ÷ `字/分`，再加上标点停顿**。这样段尾的短行停留短，长句停留长，「行/秒」不需要固定。速度默认 **300 字/分（200 词/分）**，与打字机共用；面板上次要显示「≈ 2.6 秒/行」帮助理解。
- **跟读（听书驱动）**：听书正在播放时自动选中。当前句所在的行就是聚焦行；句子跨行时，按句内已播放的比例（现有的分块起点推算）把聚焦带移到对应的那一行。听书暂停，歌词也暂停。
- **手动**：手机上点屏幕下半部分 = 下一行，点上半部分 = 上一行，上下滑动 = 逐行移动，音量键 = 下一行或上一行（Android，需要原生拦截，P1）；桌面上 ↓/J/空格 = 下一行，↑/K = 上一行。这就是旧设计稿里的「行聚焦 / 阅读尺」。

### 4.4 行的测量与切分
- **不自己切行**，直接用浏览器排版出来的视觉行：对可见范围上下各一屏内的文本 Range 取 `getClientRects()`，用现有的 `groupLines(tops, lineHeight)` 归并（已经能处理 ruby 和上标造成的抖动）。所以**中文按字断行、西文按词断行（含连字符）、标点禁则**都由浏览器负责，中西文不需要两套规则。
- 惰性测量：只测「当前行 ±1 屏」，前进到测量范围边缘时再补测；字号或窗口宽度变化（relocate 或 resize）后清空缓存，**以字符偏移为锚点**重新定位当前行。
- 混排：同一视觉行里中西文混排时，字当量按 `pacing.ts` 的 token 权重相加。

### 4.5 边界
| 情况 | 行为 |
|---|---|
| 段落结束 | 加段落停顿（+4 个字当量，300 字/分时约 0.8 秒）；段间空白照常保留，聚焦带越过空白时不停留 |
| 标题 | 当成一行，停留时间 ×1.5；标题字号大，聚焦带高度随行高变化 |
| 图片、SVG、公式 | 整块作为一个「行」，不压暗，停留 **max(1.2 秒, 图片高度 ÷ 视口高度 × 2 秒)**；超出视口的大图以图片顶部对齐锚点，再按停留时间滚过去 |
| 表格、代码块 | 按渲染出来的视觉行处理，代码块速度 ×2（同打字机） |
| 脚注弹层、选字、打开面板、切到后台 | 暂停 |
| 章末 | 显示下一章标题卡（1.2 秒，减少动效时直接显示），然后调用 `nextSection()` 继续；全书结束时提示「全书完」 |
| 竖排、RTL | P0 只保证横排；竖排的「行」是列，锚点改为水平方向的 40%，放到 P1 实测 |
| PDF / DjVu / 固定版式 | P0 不支持，面板里显示为禁用并说明原因 |

### 4.6 交互
- **开始**：从当前页第一条可见行开始（如果听书正在播放，从朗读位置开始）；**永远不会自动启动**（WCAG 2.2.2）。
- **点按**：点中间区域 = 暂停/继续，同时呼出迷你控制条；**点任意一行淡显的文字 = 跳到那一行**（Apple Music 的「点一句跳到哪」）；跟读模式下点某一行，听书也从那一句开始读（复用「从这里听」）。
- **手动滚动**：暂停跟随；当前行离开屏幕后，在它离开的那一侧边缘出现 **「回到当前行」** 按钮（带箭头），点击后回到当前行并继续。**不会自动回弹**。
- **长按**：选字、划线、查词照常可用，同时自动暂停。
- **前进动画**：滚动 250ms ease-out；**减少动效或墨水屏时直接跳过去**；墨水屏使用整屏跳（§3.3）。
- **迷你控制条**：和打字机共用组件 `[⏸] 300 字/分 [−][+] · 本章约 8 分钟 [×]`（复用 `progress.ts`）；Shift+↑/↓ 调速 ±10%，Esc 退出。

### 4.7 设置（`settings.readingMode.lyric`，替代未使用的 `lineFocus`）
```ts
lyric: { lines: 1 | 3; others: 'dim' | 'hide'; anchor: 0.4 | 0.5;
         driver: 'pace' | 'tts' | 'manual'; scale: number /* 1.0–1.6，默认 1.2 */ }
// 速度复用 typewriter.cpm / wpm；dim 的透明度固定为 0.3（不开放，避免设置过多）
```
`lineFocus` 字段从未上线，可以直接改名，不需要迁移。

### 4.8 验收
1/3 行 × 三种驱动 × 浅色、深色、墨水屏；中文、英文、中英混排、带图、带表格的章节各跑一遍；字号改动后当前行不丢失；换章能接上；K30 Pro 上 300 字/分连续运行 30 分钟不掉帧（每次推进 JS 开销 <1ms，与打字机的预算相同）；退出后正文全部恢复为正常颜色（e2e 断言）。

## 5. 信息架构：一个「阅读模式」面板

### 5.1 原则
- **一个名字 = 一个开关或一个入口**；别名不出现在界面上。
- **不复制设置**：夜间和护眼复用正文主题；双栏复用 `maxColumnCount`；大字和墨水屏是「预设开关」，开启时**记录当时的排版参数快照**，关闭时恢复（用户在大字模式里手动调过的字号，作为大字模式自己的值保存）。
- **带读类互斥**：同一时刻只运行一个；开启一个时自动停止另一个，并提示一句。听书例外：它可以作为歌词的驱动（跟读）。
- 兼容 e2e：自动翻页的容器保持 `.auto-panel`，按钮 title 保持「阅读模式」。

### 5.2 面板布局
```
阅读模式                                              [×]
显示   [夜间] [护眼] [墨水屏] [大字]          ← 开关卡片，可同时开多个（夜间与护眼互斥）
版面   [沉浸] [双栏]
带读   [ 自动翻页 | 打字机 | 歌词 | 听书 ]     ← .segmented，选中后下方展开该模式的设置和「开始」按钮
       ……（所选模式的设置）……
       [ ▶ 从本页开始 ]
实验   仿生阅读 (开关)  ·  一行说明它不能提速
```
- 「听书」分段只放一个大按钮「开始听书」，以及「同时显示歌词视图」开关；详细设置仍在听书面板里，**不复制一份**。
- 显示区的开关卡片长按或点 ⓘ 可以看到这个预设会改动哪些参数（透明说明）。
- 组合规则：夜间 × 护眼互斥（都在改主题）；墨水屏会覆盖夜间和护眼的配色（变成纯黑白），但保留「夜间 = 反色」的含义；大字和歌词开启时强制单栏，双栏开关显示为「暂不可用（大字/歌词中）」。

### 5.3 设置页与快捷入口
- 设置页「阅读」分区只保留默认值（默认速度、提醒间隔、墨水屏自动识别等），不重复放开关。
- 第一次启动时，如果识别到墨水屏设备，或者系统字体缩放 ≥1.3，**提示一次**「要开启墨水屏/大字吗？」，不自动开启。

## 6. 预设参数（具体值）

### 6.1 夜间
`theme: 'dark'`（关闭后恢复之前的主题）；P1 增加「自动：22:00–7:00 / 跟随系统」，默认跟随系统（即现有的 `auto`）。

### 6.2 护眼
| 项 | 值 |
|---|---|
| 主题 | `sepia`（可在卡片里改为 `green`）；关闭后恢复之前的主题 |
| 休息提醒 | 每 **20 分钟**的连续阅读（计时口径与阅读记录相同，暂停超过 5 分钟就重新计时）弹出轻提示「看看 6 米外，休息 20 秒」，带 20 秒倒计时，可「跳过 / 30 分钟内不再提醒」；间隔可选 20/30/45 分钟 |
| 应用内调暗 | 滑条 0–60%。Android 用原生窗口亮度；其他平台在正文上叠一层 `rgba(0,0,0,x)`（pointer-events:none）。21:00 之后第一次打开时提示「夜里建议调暗或开夜间」 |
| 文案 | 「暖色柔和背景，定时提醒你休息眼睛。」不写「防蓝光」「保护视力」 |

### 6.3 墨水屏
| 项 | 值 |
|---|---|
| 配色 | 日间 #ffffff / #000000（21:1），夜间 #000000 / #ffffff；链接为黑色加下划线 |
| 字重 | 正文 `font-weight` +100（不改字号） |
| 动画 | 去掉 foliate 的 `animated`；外壳 `.eink *{transition:none!important;animation:none!important}`；关闭平滑滚动和骨架屏闪烁 |
| 划线 | 灰色 #bfbfbf 底，或 2px 黑色下划线（按颜色映射） |
| 带读适配 | 打字机最小粒度为逐句；歌词整屏跳；自动翻页不变 |
| 识别 | 自动 / 开 / 关；Android 由原生按厂商和型号白名单识别 |

### 6.4 大字
| 项 | 大（默认） | 特大 | 依据 |
|---|---|---|---|
| 正文字号 | **24px**（约 18pt） | **30px** | 现有默认 18px 已经是工信部规定的下限；30dp 是适老版「最大字体」的要求 |
| 行距 | **2.0** | 2.0 | 防止串行；中文正文常用 1.8–2.0 |
| 字距 | **0.05em** | 0.05em | 适度减轻拥挤效应（Zorzi 2012，作为参考）；不做大字距，以免中文变得松散 |
| 段距 | 0.6em | 0.6em | 段落边界更清楚 |
| 页边距 `gap` | **4%** | 3% | 手机 360dp 宽时每行约 13 个汉字（24px）或约 11 个汉字（30px），不至于太窄 |
| 字体 | 黑体，字重 500（字体不支持时退回 400） | 同 | 低视力指南推荐无衬线、笔画清晰的字体 |
| 西文 | 两端对齐关闭、连字符关闭 | 同 | 大字号窄行时，两端对齐会拉出很大的词间空隙 |
| 版面 | 强制单栏 | 同 | |
| 主题 | 保持用户当前主题（现有 4 个主题对比度都 ≥9.8:1，超过 AAA 的 7:1） | 同 | |
| 界面 | 阅读器工具栏图标 28px，**点击区域 ≥60×60dp**；底栏只保留「目录 · 字号 · **听书** · 夜间 · 更多」；页码文字 ×1.25 | 同 | 工信部适老版要求的点击区域；听书放在中间位置 |
| 点击翻页 | 左 1/3 上一页，右 2/3 下一页（扩大「下一页」的区域）；中间点按仍然呼出菜单 | 同 | 减少误触；可在卡片里还原 |
| 关闭时 | 恢复进入大字模式前的快照 | | |

### 6.5 沉浸
隐藏系统栏 + 屏幕常亮（无操作 10 分钟后释放）+ 页脚极简（只显示页码，可关）；勿扰为 P2 的显式选项（§3.4）。

## 7. 分期

| 期 | 内容 | 主要改动点 |
|---|---|---|
| **P0** | 面板改版（11 个定名、3 组）；**歌词**（1/3 行、淡显/隐藏、三种驱动、点行跳转、回到当前行）；**大字**（预设、快照恢复、界面放大）；**沉浸**（Android 隐藏系统栏和常亮需要改 `MainActivity.kt`，网页用 Wake Lock） | `ReadingModePanel.vue`、新增 `readingModes/lyric.ts`（复用 `pacing/blocks/revealLayer`）、`settings.ts`（`lyric`、`presets` 快照）、`readerTheme.ts`、`systemBars.ts` + `MainActivity.kt`、i18n |
| **P1** | 墨水屏；护眼（休息提醒、应用内调暗）；听书 × 歌词跟读；夜间定时；自动翻页的滚屏改为按行跳；音量键翻行 | Android 原生（设备识别、窗口亮度、音量键），`ReaderView.vue` 接线 |
| **P2** | 仿生阅读（实验）；勿扰；三栏；歌词「按段」聚焦单位；竖排歌词 | — |

**本地指标**（不做追踪）：在阅读记录中按模式显示专注分钟数；歌词模式每 10 分钟的暂停次数中位数 ≤3；进入歌词后 2 分钟内调速的比例 ≤40%（用来判断默认速度是否合适）；内测问卷问「跳行/走神是否减少」，而不是问「读得更快吗」。

## 8. 待验证 / 风险
- `flow` 临时切到滚动排版，可能和用户在分页排版下的进度和页码模型冲突 → 进出模式都以 CFI 为锚点，退出时 `goTo` 回到当前行。
- Highlight API 在旧 WebView（低于 Chrome 105）上不可用 → 用 overlayer 回退；鸿蒙 4.2 平板需要实测。
- 应用内调暗、音量键、常亮、系统栏都需要原生代码 → 尽量集中在一个 Tauri 插件或 `MainActivity` 里，桌面和网页提供降级方案。
- 「仿生阅读」商标 → 英文界面不出现 Bionic。
- Voice Dream 的具体参数来自二手资料（官方页面 404），引用时注明。

---

### 参考
[^vd]: Voice Dream Reader 显示行数（全部/5/3/1）、高亮方式（词/行/句）、Pac-Man 和 RSVP、Focused Reading Mode 自动滚动：AI Indigo 教程 https://aiindigo.com/tutorials/getting-started-with-voice-dream-reader-optimizing-tts-for-focus-and-accessibili ；Inclusive Info Hub https://inclusiveinfohub.com/voice-dream-reader-the-ultimate-text-to-speech-app-for-students-with-visual-impairments-and-everyone-else ；（官方功能列表 https://www.voicedream.com/reader/reader-feature-list/ 在 2026-10-05 返回 404）
[^vd2]: TechforTBI：https://techfortbi.wordpress.com/reading/voice-dream-reader/
[^immersive]: Microsoft, Use Immersive Reader in Word：https://support.microsoft.com/en-us/accessibility/word/use-immersive-reader-in-word ；Edge：https://support.microsoft.com/en-US/education/use-immersive-reader-in-microsoft-edge-1
[^readwok]: Readwok：https://readwok.com/ ，https://readwok.com/features
[^readest-para]: Readest #1844（段落模式，已由 #3096 关闭）https://github.com/readest/readest/issues/1844
[^nook]: Nook Focused Reading（营销页面）：https://getnook.net/focused-reading
[^adhdext]: ADHD Reading Focus 扩展：https://chromewebstore.google.com/detail/adhd-reading-focus/gaeemcahbpiiejgnmcbhajklkipakdpe ；FocusReader：https://www.focusreader.xyz/for/adhd
[^tp]: Teleprompter.com, Which scrolling mode should I use：https://www.teleprompter.com/faq/which-scrolling-mode-should-i-use ；速度换算：https://sayscroll.com/tools/teleprompter-scroll-speed-calculator
[^tp2]: Lines: Teleprompter（0.25x–3x，40–450 wpm）：https://apps.apple.com/us/app/lines-teleprompter-for-video/id6761660449 ；阅读线位于屏幕上 1/3：https://teleprompter.works/blog/automatic-teleprompter-auto-scroll-guide-for-creators/
[^moon]: Moon+ Reader：https://play.google.com/store/apps/details?id=com.flyersoft.moonreader ；MobileRead Wiki：https://wiki.mobileread.com/wiki/Moon%2B_Reader
[^am]: Apple Music 风格歌词的开源复刻（当前行居中、点击跳转、滚动后暂停跟随、「回到当前行」按钮、逐字填色）：https://github.com/purnasth/apple-music/pull/11 ；https://github.com/HuangRunHua/Apple-Music-Lyric-Animation ；Apple 支持文档：https://support.apple.com/en-us/105076
[^dxd]: 极简单行阅读器：https://read.home133.com/
[^thief]: Thief-Book：https://www.appinn.com/thief-book/ ；Ace Thief Book：https://marketplace.visualstudio.com/items?itemName=Kutius.ace-thief-book
[^weread]: 微信读书自动阅读（旧文档）：https://zhuanlan.zhihu.com/p/179084726
[^qidian]: 起点读书自动阅读和翻页方式：https://m.qidian.com/ask/qenlwiqjdmi ，https://jingyan.baidu.com/article/c843ea0be1f4cd36931e4ada.html
[^kindle]: Amazon Immersion Reading：https://press.aboutamazon.com/2012/9/audible-and-amazon-introduce-immersion-reading-and-whispersync-for-voice-two-momentous-steps-forward-for-reading ；Audible 的 Read & Listen（2026）：https://9to5mac.com/2026/02/18/amazon-adds-read-and-listen-mode-to-audible-app-for-immersion-reading-feature/
[^apple]: Apple Books Asset Guide，Read Aloud 界面：https://help.apple.com/itc/booksassetguide/en.lproj/itcd68191c9b.html ；Media Overlays：https://help.apple.com/itc/booksassetguide/en.lproj/itcf373ff8f8.html
[^speechify]: Speechify 自动滚动：https://speechify.com/blog/how-do-i-enable-auto-scroll-as-the-web-app-reads-my-document/ ；ElevenReader：https://elevenreader.io/text-reader-app
[^dyson]: Dyson, M. C. (2004). How physical text layout affects reading from screen. *Behaviour & IT* 23(6)（含 Duchnicky & Kolers 1983、Creed 1988 等）：https://stu.westga.edu/~ssynan1/literacy/Dyson.pdf
[^kang]: Kang & Muter (1989). Reading dynamically displayed text. *Behaviour & IT* 8：https://web-archive.southampton.ac.uk/cogprints.org/1971/1/Abs1989.htm
[^oquist]: Öquist & Lundin (2007). Eye movement study of reading text on a mobile phone using paging, scrolling, leading, and RSVP. MUM '07：https://dl.acm.org/doi/10.1145/1329469.1329493 ；https://www.semanticscholar.org/paper/567097a5ceb469da2e6b6e7d79cf5eed446e8275
[^harvey]: Harvey & Walker (2018). Reading comprehension and its relationship with working memory capacity when reading horizontally scrolling text. *QJEP*：https://doi.org/10.1080/17470218.2017.1363258
[^rogowsky]: Rogowsky, Calhoun, Tallal (2016). Does Modality Matter? *SAGE Open*：https://eric.ed.gov/?id=EJ1198304
[^piep]: Piepenbrock 等 (2013). Positive display polarity is advantageous for both younger and older adults. *Ergonomics*：https://pubmed.ncbi.nlm.nih.gov/23654206/ ；综述：https://www.cogsci.nl/blog/miscellaneous/232-is-bright-text-on-a-dark-background-a-good-idea
[^aleman]: Aleman, Wang, Schaeffel (2018). Reading and Myopia: Contrast Polarity Matters. *Scientific Reports*：https://www.nature.com/articles/s41598-018-28904-x
[^ko]: KOReader 用户指南（E-ink 设置、夜间模式、Auto Warmth）：https://koreader.rocks/user_guide/
[^cochrane]: Singh 等 (2023). Blue-light filtering spectacle lenses… Cochrane：https://www.cochranelibrary.com/cdsr/doi/10.1002/14651858.CD013244.pub2/full ；报道：https://www.citystgeorges.ac.uk/news-and-events/news/2023/08/blue-light-filtering-spectacles-probably-no-difference-eye-strain-visual-performance-sleep-quality
[^nagare]: Nagare, Plitnick, Figueiro (2019). Does the iPad Night Shift mode reduce melatonin suppression? *Lighting Res. Technol.*：https://pubmed.ncbi.nlm.nih.gov/31191118/
[^green]: 果壳「豆沙绿？护眼并非如此简单」：https://www.guokr.com/article/21649/ ；维基百科「豆沙绿」：https://zh.wikipedia.org/zh-hans/%E8%B1%86%E6%B2%99%E7%BB%BF
[^2020]: Talens-Estarelles 等 (2023). The effects of breaks on digital eye strain, dry eye and binocular vision: Testing the 20-20-20 rule. *Contact Lens & Anterior Eye*：https://www.sciencedirect.com/science/article/pii/S1367048422001990
[^benedetto]: Benedetto 等 (2013). E-Readers and Visual Fatigue. *PLoS ONE*：https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0083676
[^readest-eink]: Readest 文档（E-Ink Mode）：https://readest.com/docs/customization
[^weread-ink]: 微信读书墨水屏版：https://jingyan.baidu.com/article/fec4bce261502fb3618d8b94.html ，https://zhuanlan.zhihu.com/p/100223502
[^boox]: BOOX 刷新模式与分应用优化：https://www.tifan.ca/guides/boox-refresh-modes-explained ，https://help.boox.com/hc/en-us/articles/360030811891
[^wakelock]: MDN Screen Wake Lock API：https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API ；WebView 支持：https://caniwebview.com/features/web-feature-screen-wake-lock/
[^a15]: Android 15 行为变更（勿扰 / 隐式 AutomaticZenRule）：https://developer.android.com/about/versions/15/behavior-changes-15
[^miit]: 工信部《移动互联网应用（APP）适老化通用设计规范》(2021)：http://wza.isc.org.cn/bztx/bzjd/mobile/index.html ；要点：https://www.woshipm.com/pd/5422669.html
[^rnib]: RNIB 大字与超大字：https://www.rnib.org.uk/living-with-sight-loss/independent-living/leisure/reading-and-books/large-and-giant-print/ ；Sensory Trust：https://www.sensorytrust.org.uk/resources/guidance/designing-with-clear-and-large-print
[^lp]: The effect of font and line width on reading speed in people with mild to moderate vision loss. *Ophthalmic Physiol Opt*：https://link.springer.com/article/10.1111/j.1475-1313.2006.00409.x
[^zorzi]: Zorzi 等 (2012). Extra-large letter spacing improves reading in dyslexia. *PNAS*：https://www.pnas.org/doi/10.1073/pnas.1209921109 ；商榷：https://pmc.ncbi.nlm.nih.gov/articles/PMC3497831/
[^elder-cn]: 适老化阅读类案例（UC 大字版等）：https://www.woshipm.com/pd/4784458.html ；https://www.ifanr.com/1398614 ；七猫免费听书：https://sj.qq.com/appdetail/com.fcat.freader

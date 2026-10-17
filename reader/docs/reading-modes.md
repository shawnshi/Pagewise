# 阅读模式 · 调研与产品设计

> 2026-10-04 · 状态：设计稿，尚未实现 · 范围：可重排书籍（foliate：EPUB/MOBI/AZW3/FB2 + TXT/MD/HTML）
> 相关：`docs/产品设计.md`、`src/views/ReaderView.vue`（自动阅读、听书）、`node_modules/foliate-js/{paginator,tts,overlayer}.js`
> 2026-10-07：「阅读模式」与「排版」两个面板的分工（场景卡片、每个设置只有一个入口）见 `docs/reader-panels.md`。

## 1. 结论

1. **新建「阅读模式」入口**，把已有的「自动翻页」和新模式收进同一个面板（手机底栏「自动」改为「模式」，桌面顶栏同位置）。底栏仍是 5 个按钮。
2. **P0 打字机模式**（用户明确要求）：正文按设定速度一个字一个字、一句一句或一行一行显示出来，读过的保持可见；可调速度（中文 `字/分`，西文 `词/分`），轻点暂停/继续，读到页末自动翻页，读到章末自动进入下一章。产品定位是**帮人专注、控制节奏的仪式感工具，不承诺读得更快**。没有研究直接验证「打字机式显示」，相关研究都是间接证据，详见 §2。
3. **P1 行聚焦（阅读尺）**：当前 1/3/5 行保持清晰，其余行压暗。这是本次调研里证据最好的视觉辅助（CHI 2023，含读写障碍人群）。它和打字机共用一个「阅读光标」调度器：可以手动移动，也可以按节拍自动前进（引导式阅读）。
4. **P2 词块引导（实验）**：中文用「分词交替着色」，有多篇同行评审眼动研究支持，效果小，主要见于老年人、儿童和二语学习者；西文用「词首强调」（Bionic 风格），只作为偏好项，界面上如实说明它不能提速。Bionic Reading 本体已被多项研究证伪，不作为卖点，也不能用这个商标名。
5. **不做**：RSVP 单词闪现（Spritz/Kindle Word Runner 一类，会损害理解）、BeeLine 渐变色（主要是厂商自己的研究，独立研究结果为阴性）。
6. **技术关键**：全部基于 Range 和 **CSS Custom Highlight API**（`::highlight()`）实现，只改颜色，**不改 DOM，不触发 foliate 重排**，也不破坏 CFI 和标注。旧 WebView 不支持 Highlight API 时，打字机退回到 foliate overlayer 的遮罩矩形方案。逻辑放在可单测的纯函数模块 `src/services/readingModes/pacing.ts`。

## 2. 调研

### 2.1 证据评级口径

| 级别 | 含义 |
|---|---|
| A | 多项独立、同行评审研究或综述，结论一致 |
| B | 少量同行评审研究，结论正向但效应小或人群有限 |
| C | 只有间接证据，或主要是厂商、非正式研究 |
| A− | 证据充分，但结论是**无效或有害** |

### 2.2 各方法与证据

| 方法 | 做法 | 证据 | 评级 | 对本产品的含义 |
|---|---|---|---|---|
| **Bionic Reading（词首加粗）** | 每个西文词前半部分加粗 | Snell 2024（Acta Psychologica）：阅读时间无显著差异[^snell]；Readwise 线上实验（1,916 人）：325.3 vs 327.9 wpm，理解率都是 88%[^readwise]；Beelders 2025（JEMR，眼动，53 人）：速度、注视次数和时长都没有变化，注视仍分布在整个词上[^beelders]；Parker 等 2026（Royal Society Open Science，预注册眼动，90 人）：只让长词的首次注视略往前移，速度、跳读和理解都没有提升，48% 的人认为不加粗更好读[^parker]。没有针对读写障碍或 ADHD 的严格研究[^parker] | **A−** | 只能作为「个人偏好」的排版选项，不宣传提速。Readest 维护者以证据不足为由拒绝把它做成核心功能，建议用 Bionic 字体实现[^readest-bionic] |
| **Bionic 的中文改编** | 社区做法是先分词再加粗词首字，或者加粗偏旁、关键词[^cn-bionic] | **没有找到任何实证研究** | C | 中文不跟风做「首字加粗」，改为下一行的分词着色 |
| **中文分词交替着色** | 相邻的词交替用两种颜色，标出词边界 | Zhou/Ye/Yan 2020（Applied Psycholinguistics，韩国籍汉语二语学习者）：注视更靠近词中心，回视更少，读得更快[^zhou-l2]；Memory & Cognition 2018：交替着色帮助中文读者引导眼动[^mc2018]；Pan 等 2024（Psychonomic Bulletin & Review，60 名老年人 + 59 名青年）：老年人提速约 5 字/分，青年几乎没有变化；**按错误边界着色会干扰阅读，对老年人干扰更大**[^pan2024]；另有针对 2–5 年级儿童的研究[^children] | **B** | 少数有中文实证的「强调」方法。分词准确率是关键风险：`Intl.Segmenter` 对「图书馆」「人工智能」会切错（实测见 §5.6） |
| **RSVP / Spritz / ORP** | 在固定位置逐词闪现，对齐最佳识别点 | Rayner 等 2016（PSPI 综述）：速度和理解此消彼长，眼动只占阅读时间的约 10%，去掉回读会损害理解[^rayner2016]；Schotter 等 2014：屏蔽已读词（不能回视）会降低理解[^schotter2014]；Benedetto 等 2015：250 wpm 时 Spritz 的字面理解就已下降，眨眼减少，视觉疲劳增加[^benedetto] | **A−** | 不做。Kindle Word Runner 据称已于 2024 年下线（来源只有一条社交媒体帖子，较弱）[^wordrunner]；Readest 有 RSVP 模式[^readest-rsvp]，如果用户强烈要求，可以以后再评估 |
| **阅读尺 / 行聚焦** | 高亮当前一行或几行，压暗其他行 | Niklaus 等，CHI 2023「Digital Reading Rulers」：91 名读写障碍者 + 86 名普通读者参与众包实验，4 种尺子都显著提速，读写障碍者提升最多，但**没有一种样式是所有人都偏好的**[^chi2023]。注意：常被引用的「平均 +86 wpm」是拿每个人最快的那种尺子和不用尺子比，存在挑选偏差。微软沉浸式阅读器提供 1/3/5 行聚焦[^immersive]，Helperbird 提供阅读尺[^helperbird] | **B** | P1 做，提供多种样式，默认不开 |
| **BeeLine 渐变色** | 每行用颜色渐变把视线引到下一行 | 厂商合作研究报告提速 10–30%[^beeline-stanford]；莱顿大学针对初学读者的独立研究：理解没有提升，读者更偏好黑字，觉得渐变更难读[^beeline-leiden] | **C** | 不做；这是商业专有方案，知识产权情况需要另行核实 |
| **打字机 / 逐步显示** | 文字按节奏逐字出现 | **没有直接研究**。间接证据：①不能回看已读内容会损害理解（Schotter 2014）→ **已读文字必须保持可见**；②移动窗口范式表明，限制副中央凹预览会降低阅读速度（熟练读者右侧需要约 14–15 个字符）[^movingwindow] → 打字机**一定会限制最高速度**，默认速度应低于自然阅读速度，并提供「淡显后文」选项保留预览；③RSVP 文献表明速度越高理解越差 → 设置上限，标点处停顿（参考 Word Runner 的标点放慢做法[^wordrunner2]） | **C** | 定位为专注、节奏和仪式感，不承诺效率。写作软件里已有同类体验：iA Writer 的句子/段落聚焦和打字机滚动，Ulysses 的打字机模式[^ia] |
| **听书 + 同步高亮** | 朗读时高亮当前句 | 系统综述：朗读类辅助对 ADHD 和学习障碍有小幅正面作用[^adhd-review][^at-meta] | B | 已实现（句级高亮）；P1 让打字机或行聚焦跟随朗读 |

### 2.3 竞品

| 产品 | 相关能力 |
|---|---|
| 微信读书 | 「自动阅读」：可调速度，**长按暂停、轻点快进、滑动干预**[^weread]。没有找到打字机或词首强调功能的公开资料 |
| 掌阅 / 多看 | 自动翻页分「覆盖」和「滚屏」两种，有加速/减速按钮，默认速度 75[^ireader] |
| Moon+ Reader | 5 种自动滚动：rolling blind、按像素、按行、按页等，可实时调速[^moon] |
| Readest（同样基于 foliate） | RSVP 速读模式和段落模式，用户反馈入口太深、希望一键进入[^readest-rsvp]；拒绝内置 Bionic[^readest-bionic] |
| Koodo Reader | 有「快速阅读模式」，即 Bionic[^koodo] |
| 微软沉浸式阅读器 | 行聚焦 1/3/5 行，辅以朗读、音节划分等[^immersive] |
| iA Writer / Ulysses | 写作场景：句子/段落聚焦（压暗其余部分）、打字机滚动（当前行固定在屏幕中部）[^ia] |

**机会点**：中文阅读器里还没有人做「打字机」这种带仪式感的专注模式，用户的诉求很明确；中文分词着色有学术依据，但还没有阅读器落地。我们的差异化是**体验做好，并对证据保持诚实**，不像竞品那样宣传「提速 X%」。

### 2.4 无障碍要求

- **WCAG 2.2.2 暂停、停止、隐藏**：自动移动超过 5 秒的内容必须能暂停或停止[^wcag222]。打字机、自动行聚焦都必须一键暂停，并且永远不能自动启动。
- **WCAG 2.3.3 交互动画** 和 `prefers-reduced-motion`[^wcag233]：减少动效时关闭光标闪烁、平滑滚动和翻页动画，默认粒度改为「逐句」（画面跳动更少）。
- BDA 2023 读写障碍排版指南：行距约 1.5，避免斜体和下划线，用粗体表示强调，每行 60–70 字符[^bda]。行聚焦的下划线样式要用**下方色条**而不是文本下划线；词首强调优先用「对比度」而不是斜体。
- 屏幕阅读器：隐藏只靠改颜色实现，**不加 `aria-hidden`**，读屏仍能读到全文；迷你控制条的状态变化用 `aria-live="polite"` 播报。

## 3. 模式设计

### 3.0 总体：一个光标，多种呈现

所有模式共用一个**阅读光标**（cursor = 当前读到的字符位置，用 Range 表示）。光标可以由三种来源推动：**节拍**（按速度调度）、**朗读**（TTS 的句子标记）、**手动**（轻点或方向键）。各个模式只是同一个光标的不同呈现方式：

| 呈现 | 光标之前 | 光标处 | 光标之后 |
|---|---|---|---|
| 打字机 | 正常显示 | 「墨迹未干」：最新 1–2 个字用强调色 | 隐藏（默认）或淡显 |
| 行聚焦 | 压暗 | 当前 1/3/5 行清晰 | 压暗 |
| 词块引导 | 静态着色，与光标无关 | — | — |
| 自动翻页（现有） | 不使用光标，按秒/页计时 | — | — |

**互斥与组合**：打字机与自动翻页互斥，因为翻页由打字机接管；打字机可以和行聚焦叠加，聚焦带跟随打字行；P0 中打字机与听书互斥，P1 改为「听写同步」。词块引导可以和任何模式叠加，叠加时打字机的隐藏层优先级最高。

### 3.1 打字机（P0）

**用户场景**
- 刷手机久了静不下心读书的人，想要一个有节奏感、「被带着读」的开场（睡前、通勤）。
- ADHD 倾向或容易走神的读者：文字不会一下子全部出现，注意力被锚定在出字的位置。这一点没有循证保证，界面上要表述为「可能有帮助」。
- 想放慢速度细读诗歌、经典、外语原著的人：逐句出现会逼自己慢下来。
- 纯粹觉得好玩、有氛围感（配打字声）。

**核心价值**：用节奏帮读者进入状态。指标是专注时长，不是速度。

**粒度**（分段控件，默认「逐字」）
- **逐字**：中文按字（字素）出；西文在一个词内匀速出完，时间按词计算；阿拉伯文、希伯来文这类连写或 RTL 文字**自动改为按词出**，避免半个词的连写字形断开。
- **逐句**：整句一起出现，停留时间等于这句话按速度算出的时长。
- **逐行**：整行一起出现，停留时间等于这一行按速度算出的时长。三种粒度的节奏一致，只是颗粒大小不同。

**速度**
- 单位跟随书的主语言：中文书显示 `字/分`，西文书显示 `词/分`。内部统一按「字当量」计算：一个汉字算 1，一个西文词算 1，词内字母平分这 1 份时长；超过 8 个字母的长词每多一个字母 +0.1。
- 默认：**中文 300 字/分**，西文 **200 词/分**。参照：IReST 朗读速度中文约 255 字/分[^irest]；英文成人默读约 238（非小说）/ 260（小说）wpm[^brysbaert]。默认值略低于自然默读，读者会感到「被带着走」，又不至于被催促。
- 范围：中文 60–1200 字/分，西文 40–800 词/分。滑条步长 10，旁边有 −/+ 按钮（±10%），并提供快捷档 **慢 200 / 中 300 / 快 450**（西文 150/200/300）。
- 标点停顿（乘以单字时长）：逗号、顿号、分号、冒号 +1.5；句号、问号、叹号、省略号 +3；段落结束 +4；图片 +1.2 秒（固定时长）。由「标点停顿」开关控制，默认开。
- 自适应提示（本地计算）：如果 10 分钟内暂停超过 6 次，或者连续两次点「加速」，弹出提示「要不要调到 X 字/分？」。只提示，不自动修改。

**呈现**
- 后文：**隐藏**（默认，最有打字机感）/ **淡显**（约 18% 不透明度，保留预览，适合想快读的人）。
- 墨迹未干：最近出现的 2 个字用主题强调色，按主题取 `READER_THEMES[*].link`，下一次推进时变回正文色。这里没有动画，只是颜色切换，减少动效时同样保留。
- 打字声（默认关）：WebAudio 合成 15ms 的噪声脉冲，不需要音频资源文件。每出一个字（中文）或一个词（西文）响一次，超过 600 字/分时降为每 3 个字一次；听书开启时静音。
- 光标插入符：P1 再做（需要在 overlayer 里画矩形）。

**开始与结束**
- 从**当前页第一个可见字**开始；本页文字会先全部隐藏，再从页首重新打出。打字机只在用户点「开始」后启动，从不自动启动。
- 分页模式下打到本页最后一个可见字后，停留 `翻页停顿`（默认 0.8 秒，减少动效时为 1.2 秒），然后自动翻页并从新页页首继续。
- 章末：调用 `renderer.nextSection()`，与听书的章节衔接逻辑相同；全书结束时停止，提示「全书完」。
- 滚动模式下，出字行保持在视口高度约 40% 处（打字机滚动）。光标行超出 60% 时，向下滚动一行的距离；减少动效时直接跳转，不做平滑滚动。

**干预**
- 轻点正文任意位置：暂停，同时呼出工具栏和迷你控制条；再点一次继续。打字机运行期间，左右三分区**不翻页**，以免误触。
- 横滑或翻页键：手动翻页。翻页后光标移到新页页首并保持原来的运行/暂停状态；往回翻的页面全部显示。
- 长按选字：自动暂停，选字、划线、查词照常可用，但只能选中已经显示的文字。
- 目录、搜索、书签、标注跳转：暂停，光标移到目标位置。
- 应用切到后台（`visibilitychange`）、打开脚注弹层、打开任意面板：自动暂停。

**与其他功能的关系**
- 自动翻页：两者互斥，开始打字机时停止自动翻页，反之亦然，并提示一句。
- 听书：P0 互斥，开始打字机时暂停听书。P1 提供「听写同步」：打字机跟随朗读按句出字，句内用 `listenEta` 测得的实时语速插值，逐字出现，效果类似卡拉 OK。
- 阅读时长：运行期间调用 `pingReadingAuto()`，计入阅读记录，口径与听书一致。
- 排版修改（字号、行距等）：光标位置不变，因为 DOM 没有改动；重排完成后按新的可见范围继续。

**默认设置**：逐字 · 300 字/分（200 词/分）· 后文隐藏 · 标点停顿开 · 墨迹未干开 · 打字声关 · 翻页停顿 0.8 秒。

### 3.2 行聚焦（P1）

- **场景**：读写障碍或视线容易跳行的读者；夜读长段落；配合听书时跟随朗读位置。
- **呈现**：聚焦带默认 1 行，可选 3/5 行（与微软沉浸式阅读器一致）。样式有三种：**遮罩**（默认，带外压暗到 35% 不透明度）、**色条**（当前行底部 3px 强调色条，不压暗正文）、**亮框**（当前行浅底色）。双栏布局下聚焦带只覆盖当前所在栏。
- **驱动方式**：**手动**（默认）：桌面用 ↑/↓ 或 J/K；手机上轻点正文中间三分之一区域的下半部分进到下一行、上半部分退回上一行，左右分区照旧翻页，到页末再前进时翻页并跳到首行。**节拍**：与打字机共用调度器，按 `字/分` 自动前进，即引导式阅读。**跟随朗读**：听书开启时聚焦带跟随当前朗读的句子所在行。
- **组合**：与打字机同时开启时，聚焦带固定在出字行。

### 3.3 词块引导（P2，实验）

> **现状（2026-10）**：词块引导已并入点睛阅读，成为它的**基础版**（按词分色，不联网），入口在「阅读模式」面板顶部的「点睛阅读 → 基础」，不再单独放在「实验」组；原点睛阅读为智能版。界面文案只讲好处，不再出现「实验」标记和研究说明，下文是当时的设计记录。见 [manual/05-点睛阅读](manual/05-点睛阅读.md)。

- **入口**：在「阅读模式」面板里，标注「实验」字样，并附一行说明：「研究显示它不会让大多数人读得更快，部分读者觉得更易聚焦。」
- **中文：分词着色**。相邻的词交替使用正文色和「正文色与强调色约 7:3 混合」的颜色。强度分「轻」（默认，色差小）和「标准」两档。只给词长 ≥2 的词着色，单字词保持正文色，以降低分词错误造成的干扰。Pan 2024 表明错误的边界有害，所以这个选项默认关闭。
- **西文：词首强调**。不加粗，而是保持词首约 40% 的字母（参照 Bionic 的注视长度表）为正文色，其余字母为正文色的 70%，这是「对比度」样式。另有「描边加粗」样式（`-webkit-text-stroke-width`，需要实测，见 §5.4）。两种样式都不改变字宽，所以不会引起重排。
- **混排**：按每个片段的文字类型自动选用对应规则。

### 3.4 自动翻页（现有，迁入面板）

行为不变：秒/页，3–60 秒。面板第一栏保留 `.auto-panel` 的结构，e2e 用到的选择器见 §4.4。

### 3.5 边界情况

| 情况 | 处理 |
|---|---|
| 图片 / SVG / MathML / 视频 | 作为原子块处理：未到达时用 `visibility:hidden` 隐藏（加 class，不改布局，CFI 不受影响），到达时整块显示并停留 1.2 秒 |
| 表格 | 按 `tr` 作为块（与 tts.js 的 `blockTags` 一致），格内按字出 |
| 脚注 | 正文中的注引号作为普通文字打出；foliate 弹出脚注时暂停；`display:none` 的内嵌脚注（没有 client rects）直接跳过 |
| 超长段落（硬换行 TXT、10 万字的单段） | 块内按 5,000 字一个窗口惰性分词和建时间表，不一次处理整段；TXT 导入时已由 `txtParagraphs` 切成段落 |
| 200KB 的 TXT 单节 | 块迭代器惰性生成（仿照 tts.js 的 `ListIterator`），只处理可见范围及其后一个块；从当前页开始时，用 `compareBoundaryPoints` 定位起始块，与 `tts.from()` 的做法相同 |
| Ruby（注音） | `rt` 与基字一起显示（遇到 `ruby` 时整个 `ruby` 元素作为一个单位） |
| 代码块 `pre` | 按行出，速度 ×2 |
| RTL（阿拉伯文、希伯来文） | 按 DOM 逻辑顺序出字，所以方向正确；粒度自动改为按词 |
| 竖排 `vertical-rl` | 出字顺序同上；滚动跟随改用 paginator 的轴向（`#vertical` 时为水平方向）；需要用日文竖排样书实测 |
| 固定版式 EPUB、CBZ 漫画、PDF、DjVu | P0 不支持，面板里显示为禁用并给出原因；行聚焦的 PDF 版放到 P2（需要 PDF 文本层的行框） |
| 已有划线标注 | overlayer 的高亮矩形会画在还没出现的文字上，会暴露位置但不会暴露内容；P0 接受这一点，P1 在打字机运行时把光标之后的标注组透明度降到 0 |
| 选中文字 | 只能选已显示的部分；如果选区越过了光标，自动暂停，并把光标推进到选区末尾 |

## 4. 交互与 UI 规格

### 4.1 入口

- **手机**：底栏第 4 个按钮「自动」改为 **「模式」**，图标改成「页面 + 光标」的内联 SVG，按钮 `aria-label` 为「阅读模式」。点击后弹出底部抽屉，复用现有 `sheet-scrim`。运行中按钮显示 `active` 状态。
- **桌面**：顶栏原「自动阅读」按钮改为「阅读模式」按钮，点击后在原位置弹出浮层卡片。
- **快捷键**（只在阅读器内生效，正在输入时不拦截）：`M` 打开/关闭面板，`Shift+T` 开始/停止打字机。打字机运行时，`Space` 改为暂停/继续（平时是下一页），`→` 立即显示到本段末，`←` 重打当前句，`Shift+↑/↓` 调速 ±10%，`Esc` 退出打字机（与现有 Esc 行为合并）。需要在 `services/keyboardShortcuts.ts` 和快捷键帮助中登记。

### 4.2 面板布局（自上而下）

```
阅读模式                                         [×]
[ 自动翻页 | 打字机 | 行聚焦 | 词块引导·实验 ]     ← 全局 .segmented
───────────────────────────────
(打字机)
 粒度      [ 逐字 | 逐句 | 逐行 ]
 速度      [−] ━━━━●━━━━ [+]   300 字/分
           慢 200 · 中 300 · 快 450
 后文      [ 隐藏 | 淡显 ]
 标点停顿  (开关)    打字声 (开关)
 一行说明：「轻点正文暂停；读过的文字始终可见。」
 [ ▶ 从本页开始 ]                                ← .btn 主按钮
```

- 每个分段页都是**设置加主按钮**的结构；词块引导和行聚焦的「手动」方式是开关，打开后立即生效，没有开始按钮。
- 所有文案都走 `t()`，在 zh.ts 和 en.ts 中新增 `// ---- 阅读模式 ----` 分区，key 用 `readingMode.*`。
- 样式只使用语义令牌。阅读区 iframe 里的颜色来自 `READER_THEMES`，属于正文主题而不是外壳令牌；`::highlight` 的样式写在 `getReaderCSS()` 里。

### 4.3 迷你控制条（运行中）

- 悬浮在底部居中，位置和样式参照现有 `tts-mini`：`[⏸] 300 字/分 [−][+] [×]`。运行 3 秒后淡出（减少动效时直接消失），暂停时常驻显示。
- 触控目标 ≥ 44px，图标按钮带 `aria-label`；状态文字容器使用 `aria-live="polite"`。
- 手机：位于底栏上方；工具栏隐藏时贴近底部安全区。

### 4.4 e2e 兼容

`scripts/e2e-full.mjs` 依赖 `[title="自动阅读"]`、`.auto-panel input[type=range]` 和 `.auto-panel .btn`。处理方式：自动翻页这一栏的容器继续使用 `.auto-panel` 类名；桌面按钮的 title 改为「阅读模式」后，**在同一个改动里更新 e2e-full**（先点「阅读模式」，再选「自动翻页」分段）。smoke 测试（`e2e-smoke.mjs`）不受影响。CLAUDE.md 列出的选择器语义都保持不变。

## 5. 技术方案

### 5.1 核心思路：只改颜色，不动 DOM

foliate 的 paginator 在 iframe 的 body 上挂了 `ResizeObserver`，每次 `setStyles` 都会重排。把文字包进 span 的方案有三个问题：① 动态加 class 或样式时有重排风险；② CFI 是按 DOM 结构计算的，包裹期间生成的划线和进度 CFI 会错；③ 大章节一次性包裹的成本很高。所以：

1. **主路径：CSS Custom Highlight API**。在 iframe 的 window 上（每个文档有自己的 `CSS.highlights` 注册表，`Highlight` 构造函数也必须取自 `doc.defaultView`）注册以下几个 Highlight：
   - `lr-tw-hidden`：Range = [光标, 节末]，样式 `color: transparent; text-shadow: none; -webkit-text-fill-color: transparent`，`priority` 最高
   - `lr-tw-ghost`：淡显时代替 hidden，颜色为正文色 18%
   - `lr-tw-fresh`：最近 2 个字，颜色为主题 link 色
   - `lr-wg-a` / `lr-wg-b` / `lr-wg-fix`：词块引导，只为可见页 ±1 页内的词生成 Range
   
   每次推进只执行 `hiddenRange.setStart(node, offset)`，浏览器只重绘，不重新布局。`::highlight` 允许的属性只有 color、background-color、text-decoration、text-shadow、`-webkit-text-stroke-*`、`-webkit-text-fill-color`，**不能改字重**[^mdn-highlight]。这正好保证不会重排，也是词首强调用对比度而不用加粗的原因。
2. **样式静态注入**：所有 `::highlight(lr-*)` 规则一直写在 `getReaderCSS()` 里（颜色随主题变化）。开关模式只增删 Highlight 对象，**不调用 `setStyles`**，所以不会触发重排。
3. **回退路径**：`BROWSER_TARGET` 是 chrome89/safari15，而 Highlight API 需要 Chrome 105+、Safari 17.2+、Firefox 140+。不支持时，打字机改用 foliate overlayer（SVG 叠在 iframe 之上，`pointer-events:none`）绘制 `lr-tw-mask`：对「光标到可见范围末尾」这段 Range 取 `getClientRects()`，用主题背景色画不透明矩形，每次推进时重画。一页只有几十个矩形，可以接受。淡显用半透明背景色矩形实现。词块引导在不支持的环境下隐藏这个选项，并提示「需更新系统 WebView」。
4. **图片等原子块**：给尚未到达的 `img, svg, video, math, figure` 加 `data-lr-pending` 属性，用静态 CSS `[data-lr-pending]{visibility:hidden}` 隐藏。设置属性不会改变尺寸，CFI 也不包含属性，不受影响。

### 5.2 模块划分

| 文件 | 职责 | 类型 |
|---|---|---|
| `src/services/readingModes/pacing.ts` | 分词、权重、标点停顿、时间表、偏移↔时间、句子切分修正、按行分组、速度单位换算 | **纯函数**，可用 `node --test` 测试 |
| `src/services/readingModes/wordGuide.ts` | 词块着色和词首强调的区间计算（P2） | 纯函数 |
| `src/services/readingModes/blocks.ts` | 块迭代器：从 tts.js 的 `getBlocks` 改写，因为 tts.js 没有导出它；提供 textWalker 节点表和 `locate(offset) → {node, offset}` | DOM（薄层） |
| `src/services/readingModes/revealLayer.ts` | `createRevealLayer(doc, overlayer, colors)`：优先用 Highlight API，否则用 overlayer 遮罩；`setHidden / setFresh / setGhost / dispose` | DOM |
| `src/services/readingModes/typewriter.ts` | `TypewriterController`：rAF 循环、状态机（idle/running/paused/turning）、可见范围检测、翻页和换章回调 | DOM |
| `src/composables/useReadingModes.ts` | 与 ReaderView 对接：监听 relocate、section load、visibilitychange；与自动翻页和听书互斥；调用 `pingReadingAuto` | Vue |
| `src/components/ReadingModePanel.vue`、`ReadingModeMini.vue` | 面板和迷你控制条（scoped 样式，语义令牌） | Vue |
| `src/services/readerTheme.ts` | `getReaderCSS()` 追加 `::highlight(lr-*)` 和 `[data-lr-pending]` 规则 | 修改 |
| `src/stores/settings.ts` | 新增 `readingMode` 字段（见下文），只需改 `SettingsState` 和 `defaults`，无需迁移 | 修改 |
| `src/i18n/zh.ts`、`en.ts` | `readingMode.*` 文案 | 修改 |
| `src/views/ReaderView.vue` | 只做接线：替换底栏和顶栏入口、点击分发（`onContentClick` 在打字机运行时改为切换暂停）、键盘、挂载组件。**等另一会话对 ReaderView 的修改合入后再动**，并且尽量把逻辑放在 composable 里 | 修改（小） |
| `scripts/test-reading-modes.mjs` + `package.json` 的 `test:reading-modes` | 纯函数契约测试 | 新增 |
| `scripts/e2e-full.mjs` | 更新自动阅读选择器，新增打字机冒烟：开始 → 2 秒后可见字数增加 → 暂停 → 继续 → 翻页 | 修改 |

```ts
// settings.ts 新增
readingMode: {
  typewriter: { unit: 'char' | 'sentence' | 'line'; cpm: number; wpm: number;
                upcoming: 'hidden' | 'ghost'; punctuationPause: boolean; freshInk: boolean;
                sound: boolean; pageDwellMs: number }
  lineFocus:  { enabled: boolean; lines: 1 | 3 | 5; style: 'shade' | 'bar' | 'box';
                driver: 'manual' | 'pace' | 'tts' }
  wordGuide:  { enabled: boolean; style: 'auto' | 'alternate' | 'fixation'; strength: 'light' | 'normal' }
}
// 默认: { typewriter: { unit:'char', cpm:300, wpm:200, upcoming:'hidden', punctuationPause:true,
//          freshInk:true, sound:false, pageDwellMs:800 }, lineFocus: { enabled:false, lines:1,
//          style:'shade', driver:'manual' }, wordGuide: { enabled:false, style:'auto', strength:'light' } }
```

### 5.3 纯函数接口（`pacing.ts`）

```ts
export type Script = 'cjk' | 'latin' | 'rtl' | 'other'
export interface Token { start: number; end: number; weight: number; kind: 'cjk' | 'word' | 'space' | 'punct' | 'atom' }
export interface Schedule { ends: Uint32Array; times: Float64Array }   // 第 i 个出字点: 偏移 ends[i] 在 times[i] ms 出现

export function dominantScript(text: string): Script
export function tokenize(text: string, lang?: string): Token[]          // 字素级 (Intl.Segmenter grapheme), CJK 每字一 token, 西文按词
export function sentenceSpans(text: string, lang?: string): Array<[number, number]>  // Segmenter sentence + 引号修正
export function buildSchedule(tokens: Token[], unitsPerMinute: number,
  opts?: { punctuationPause?: boolean; unit?: 'char' | 'sentence'; sentences?: Array<[number, number]> }): Schedule
export function offsetAt(s: Schedule, elapsedMs: number): number        // 二分查找, 单调
export function timeAt(s: Schedule, offset: number): number             // 跳转/重打时换算
export function groupLines(tops: number[], lineHeight: number): Array<[number, number]>  // 每字 rect.top → 行区间, 容差 0.5 行高 (兼容 ruby、混排字号)
export function locate(lengths: number[], offset: number): { node: number; offset: number }
export function clampSpeed(n: number, script: Script): number           // 60–1200 字/分 或 40–800 词/分
export function adjustSpeed(n: number, dir: 1 | -1): number             // ±10%, 取整到 10
```

测试要点（`node --experimental-strip-types --test scripts/test-reading-modes.mjs`。Node 24 自带完整 ICU，`Intl.Segmenter` 可用）：
- 本机实测，句子切分的引号会挂到前一句：`第二句！“ || 第三句？”`。修正规则是把句末的开引号或开括号移到下一句开头。`Mr. Smith` 不应被切开，tts.js 已有同类缩写合并，可以照搬。
- 标点停顿：「，」之后的出字点间隔约为单字时长的 2.5 倍（1 + 1.5）。
- 字素：emoji、组合附加符、代理对不能被切开（`offsetAt` 返回的偏移不能落在代理对中间）。
- `offsetAt` 和 `timeAt` 互为近似反函数，并且都单调。
- 速度换算：300 字/分时 60 秒内出 300 个汉字（关闭标点停顿时）。
- `groupLines`：同一行里有 ruby 或上标造成的 top 抖动时，不应拆成两行。
- `locate`：处理跨多个文本节点的偏移和边界（节点末尾或下一节点开头），对空节点有保护。

### 5.4 运行循环（`typewriter.ts`）

```
start(fromRange):
  块迭代器定位到 fromRange 所在块 → 收集块内文本节点 → tokenize/buildSchedule（超长块按 5k 窗口）
  revealLayer.setHidden([块起点, 节末])  // 先全部隐藏当前页
  rAF 循环:
    elapsed = now - t0 - pausedTotal
    off = offsetAt(schedule, elapsed)；没变就跳过
    hidden.setStart(locate(off))；fresh = [off-2, off]
    if 块完成 → 下一个块（原子块：显示并停留 1.2s）
    if 光标越过 lastRelocate.range 末尾（分页模式） → 状态 turning：停留 pageDwellMs → onNeedTurn() 即 turnPage('right')
       等待 relocate → 用新的可见范围起点继续
    if 节末 → onNeedNextSection()（nextSection + 等待 load），新文档重新 attach
    滚动模式：光标 rect.bottom > 60% 视口时调用 renderer.next(行高)
  逐行模式：只在当前块里调用 getClientRects 测量每个字的 top，再 groupLines；页内约 500 字，测量开销为毫秒级。字号变化（relocate）后重新测量
```

- `visibilitychange`、`pagehide`：暂停。卸载文档（换章）时 `dispose()`，释放 Range、Highlight 和 rAF。
- 性能预算：每帧 JS 开销 p95 < 1ms（K30 Pro）；Highlight 路径每次推进 **0 次强制布局**；overlayer 回退路径每次推进 < 4ms。在 `scripts/perf.mjs` 中加一个打字机场景，并写入 `docs/perf-ledger.md`。
- 待实测：`-webkit-text-stroke-width` 在 `::highlight` 中的实际表现（Chrome/Safari）；Huawei WebView 对 Highlight API 的支持情况；Safari 17.x 在 iframe 中使用 `::highlight` 的表现。

### 5.5 与现有代码的接点

- 文本块：tts.js 的 `getBlocks` + `ListIterator`，以及 text-walker.js 的节点遍历方式（跳过 script/style）。
- 可见范围：paginator 的 `relocate` 事件里的 `detail.range`（`#getVisibleRange()`）。
- 翻页：`ReaderView.turnPage('right')`。换章：`view.renderer.nextSection()` + `waitSectionLoad()`，与 `startTTS` 的写法相同。
- 叠层：`view.renderer.getContents()[0].overlayer`（foliate 的 Overlayer，`add(key, range, drawFn)`，重排时自动 `redraw`），行聚焦和回退遮罩都用它绘制。行聚焦的遮罩 drawFn 画一个铺满整页、中间挖空当前行矩形的 path（evenodd），这样自然支持双栏。
- 阅读计时：`pingReadingAuto()`。

### 5.6 中文分词的现实情况

本机 Node 24 实测 `Intl.Segmenter('zh', {granularity:'word'})` 的输出：`他|慢慢地|走进|了|图书|馆|，|翻开|一本|关于|人工|智能|的|书`，「图书馆」「人工智能」被切开。对策：① 只为长度 ≥2 的词着色；② 用一张小型合并词表（常见三字、四字词，约 2 万条，gzip 后约 100KB，按需懒加载）做最长匹配合并；③ 默认关闭并标注「实验」。如果效果仍然不可靠，宁可不上线（Pan 2024：错误边界有害）。

**现状（2026-10-07 接入，调研见 `docs/research/zh-segmentation-for-word-guide.md`）**：中文按自带词表切分（`readingModes/zhSegment.ts`，jieba 式 DAG 最短路径，不猜新词），另一个词典词跨过边界的地方不上色；词表 `src/data/zh-lexicon.txt`（约 6.6 万词，约 230 KB gzip）在第一次遇到中文段落时才下载，下载完之前用 ICU + 2,617 个三四字常用词的合并表（`zhMergeWords.ts`）。只给多字词上色，单字、数字、标点、夹在中文里的西文词不上色也不占交替序号，交替序号每段从头开始。词表由 `scripts/build-zh-lexicon.mjs` 从 jieba 词典（MIT，Copyright (c) 2013 Sun Junyi）和 DeepSeek-R1 分词器词表（MIT，Copyright (c) 2023 DeepSeek）生成，许可全文见 `src/data/zh-lexicon.README.md`。

## 6. 分期计划

| 期 | 内容 | 验收 |
|---|---|---|
| **P0 打字机**（约 1 个迭代） | `pacing.ts` + 测试；`blocks / revealLayer / typewriter` 三个 DOM 模块；Highlight API 主路径和 overlayer 回退；逐字/逐句/逐行；速度；后文隐藏/淡显；标点停顿；墨迹未干；分页自动翻页和换章；滚动跟随；轻点暂停、手势、快捷键；与自动翻页、听书互斥；减少动效适配；「阅读模式」面板（迁入自动翻页）和迷你控制条；i18n；e2e-full 更新 | 纯函数测试通过；`npm run e2e` 和 e2e-full 通过；K70、K30 Pro 实机：300 字/分连续运行 30 分钟，无掉帧、无内存增长，翻页、换章、改字号都能接续；中文、英文、日文竖排、阿拉伯文样书各跑一章；深色主题和四种正文主题检查 |
| **P1 聚焦与同步** | 行聚焦（手动/节拍/跟随朗读，三种样式，1/3/5 行）；打字机 × 听书「听写同步」；打字声；光标插入符；光标之后的标注隐藏；阅读记录按模式统计时长 | 同上，另加读屏抽测（TalkBack、VoiceOver 能读出全文和控制条状态） |
| **P2 实验与扩展** | 词块引导（中文分词着色 + 词表合并、西文词首强调）；自适应速度建议；PDF 文本层的行聚焦；按书记住模式 | 10 人以上内测问卷；如果分词错误率主观反馈明显，回退为不上线 |
| 不做 | RSVP、BeeLine 渐变、「提速 X%」类宣传 | — |

**成功指标**（本地优先、**不做追踪**，所以指标在本地计算，展示给用户本人；内测由用户主动导出诊断 JSON）：
- 北极星：**每周在阅读模式中的专注阅读分钟数**，在「阅读记录」中单独显示为「专注模式 xx 分钟」。这个数字本身也是给用户的价值反馈。
- 采用：内测两周内，≥30% 的用户使用打字机 ≥3 次；单次会话时长中位数 ≥10 分钟。
- 体验健康度：每 10 分钟暂停次数的中位数 ≤3（过高说明速度过快）；开始后 2 分钟内调速的会话占比（用于判断默认速度是否合适，目标 ≤40%）；在打字机模式中读完一章的比例，和同一用户普通阅读时的读完率对比。
- 质量护栏：性能预算见 §5.4；不影响非模式状态下的打开和翻页性能（perf.mjs 账本不退化）；e2e 全部通过。

## 7. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| 打字机没有直接的效果证据，可能被质疑是噱头 | 口碑 | 文案只说「帮助专注、控制节奏」，不说提速；在帮助文档中链接本文的证据表 |
| 隐藏后文会限制阅读速度（移动窗口效应） | 快读者觉得慢 | 提供「淡显」；速度上限 1200 字/分；提供逐句、逐行粒度 |
| 旧 WebView、macOS 10.15 不支持 Highlight API | 回退路径更重 | overlayer 遮罩回退方案；词块引导在不支持时隐藏选项；在设置的「关于」中显示 WebView 版本 |
| paginator 重排、换章时序竞态（ReaderView 中已有多处类似注释，如 tts 的 from 抛错、翻页弹回） | 光标错位或卡死 | 控制器只信任 relocate 和 load 事件；会话号（与 `ttsSession` 相同的模式）丢弃过期回调；异常时停止并提示，不能卡在隐藏状态（`dispose` 必须清除所有 Highlight） |
| 隐藏状态残留（崩溃或切书后文字仍是透明的） | 严重：用户看不到正文 | Highlight 挂在文档上，文档卸载即消失；另外在 `onUnmounted` 和换书时清空 `CSS.highlights` 中 `lr-*` 前缀的项；e2e 断言退出后所有字可见 |
| 中文分词错误 | 词块引导反而有害 | P2 实验、默认关闭、只着色长度 ≥2 的词、词表合并；效果不行就不上线 |
| 与另一会话同时修改 ReaderView.vue | 合并冲突 | 逻辑放进 composable 和组件，ReaderView 只做接线，等对方合入后再改 |
| 「Bionic Reading」是注册商标 | 法律 | 只使用「词首强调」这个名称，不出现该商标 |
| 动效、闪烁引起不适 | 无障碍 | 遵循 `prefers-reduced-motion`；永不自动启动；一键暂停；没有闪烁频率 > 3Hz 的元素（墨迹未干只是颜色切换） |

---

### 参考

[^snell]: Snell, J. (2024). No, Bionic Reading does not work. *Acta Psychologica* 247, 104304. https://doi.org/10.1016/j.actpsy.2024.104304 · https://research.vu.nl/en/publications/no-bionic-reading-does-not-work/
[^readwise]: Readwise (2022). Does Bionic Reading actually work? https://blog.readwise.io/bionic-reading-results/
[^beelders]: Beelders, T. R. (2025). Guiding the Gaze: How Bionic Reading Influences Eye Movements. *Journal of Eye Movement Research*. https://pmc.ncbi.nlm.nih.gov/articles/PMC12565662/
[^parker]: Parker, A., Lee, H., Wang, H., Joseph, H. (2026). *Royal Society Open Science*（预注册眼动研究）。报道：https://scienceblog.com/s-bionic-reading-bolds-the-first-half-of-each-word-on-the-promise-of-more-efficient-reading-and-a-registered-eye-tracking-study-of-90-skilled-adult-readers-found-the-bolding-moved-their-first/ ；另见 Možina 等 2025 https://doi.org/10.1177/21582440251376158
[^readest-bionic]: Readest #6235（维护者以证据不足为由拒绝内置）https://github.com/readest/readest/issues/6235 ，#1819 https://github.com/readest/readest/issues/1819
[^cn-bionic]: 果壳：https://m.guokr.com/article/461569 ；CSDN：https://blog.csdn.net/baidu_30087715/article/details/148024610
[^zhou-l2]: Zhou, Ye, Yan (2020). Alternating-color words facilitate reading and eye movements among second-language learners of Chinese. *Applied Psycholinguistics*. https://www.cambridge.org/core/journals/applied-psycholinguistics/article/abs/alternatingcolor-words-facilitate-reading-and-eye-movements-among-secondlanguage-learners-of-chinese/1C7ABF554543D7ED61666951017F0BE5
[^mc2018]: Word segmentation by alternating colors facilitates eye guidance in Chinese reading. *Memory & Cognition* (2018). https://link.springer.com/article/10.3758/s13421-018-0797-5
[^pan2024]: Pan 等 (2024). Printing words in alternating colors facilitates eye movements among young and older Chinese adults. *Psychonomic Bulletin & Review*. https://pmc.ncbi.nlm.nih.gov/articles/PMC12000219
[^children]: Chinese children benefit from alternating-color words in sentence reading. https://link.springer.com/article/10.1007/s11145-020-10067-9 ；2–5 年级朗读：https://link.springer.com/article/10.1007/s11145-021-10164-3
[^rayner2016]: Rayner, Schotter, Masson, Potter, Treiman (2016). So Much to Read, So Little Time. *Psychological Science in the Public Interest* 17(1). https://journals.sagepub.com/doi/full/10.1177/1529100615623267
[^schotter2014]: Schotter, Tran, Rayner (2014). Don't believe what you read (only once). *Psychological Science* 25. https://pubmed.ncbi.nlm.nih.gov/24747167/
[^benedetto]: Benedetto 等 (2015). Rapid serial visual presentation in reading: The case of Spritz. *Computers in Human Behavior* 45. https://www.sciencedirect.com/science/article/abs/pii/S0747563214007663
[^wordrunner]: 社交媒体帖子（弱来源）：https://x.com/helloanand/status/2012455857309745266
[^wordrunner2]: Word Runner 标点放慢：https://archive.bookstr.com/article/the-little-known-app-that-helps-you-get-through-those-tough-novels/
[^readest-rsvp]: Readest RSVP 与段落模式：https://github.com/readest/readest/issues/4473 ，https://github.com/readest/readest/issues/5820
[^chi2023]: Niklaus, Cai, Bylinskii, Wallace (2023). Digital Reading Rulers. *CHI '23*. https://dl.acm.org/doi/10.1145/3544548.3581367 ；摘要：https://readabilitymatters.org/articles/research-highlight-digital-reading-rulers
[^immersive]: Microsoft, Use Line focus in Immersive Reader. https://support.microsoft.com/en-us/topic/use-line-focus-in-immersive-reader-for-office-for-the-web-and-onenote-815d5ae2-9291-4d57-b6d5-780280da27c7
[^helperbird]: https://www.helperbird.com/features/ruler/
[^beeline-stanford]: 厂商页面：https://www.beelinereader.com/stanford
[^beeline-leiden]: Does BeeLine Reader's gradient-coloured font improve the readability of digital texts for beginning readers? https://www.sciencedirect.com/science/article/pii/S2451958822000318 ，https://scholarlypublications.universiteitleiden.nl/handle/1887/3448262
[^movingwindow]: 移动窗口范式综述：https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2016.00514/full ；知觉广度个体差异：https://link.springer.com/article/10.3758/s13414-015-0942-1
[^ia]: iA Writer Focus Mode：https://ia.net/writer/support/editor/focus-mode ；Ulysses 对比：https://mariusmasalar.me/ulysses-vs-ia-writer-a-new-comparison-7015c899e883
[^adhd-review]: Educational Accommodations for Children and Adolescents With ADHD（系统综述）https://pubmed.ncbi.nlm.nih.gov/32745597/
[^at-meta]: Assistive Technology Interventions for Adolescents and Adults with Learning Disabilities（元分析）https://pmc.ncbi.nlm.nih.gov/articles/PMC5736156/
[^weread]: 产品点评：微信读书-自动阅读 https://zhuanlan.zhihu.com/p/179084726
[^ireader]: 掌阅自动翻页：https://jingyan.baidu.com/article/f0e83a25cbb99363e59101aa.html ，https://pcedu.pconline.com.cn/1178/11787061.html
[^moon]: Moon+ Reader：https://play.google.com/store/apps/details?id=com.flyersoft.moonreader
[^koodo]: Koodo Reader 文档：https://www.koodoreader.com/en/document
[^wcag222]: WCAG 2.2 Understanding 2.2.2 Pause, Stop, Hide. https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
[^wcag233]: WCAG 2.2 Understanding 2.3.3 Animation from Interactions. https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html
[^bda]: British Dyslexia Association, Dyslexia Style Guide 2023. https://cdn.bdadyslexia.org.uk/uploads/documents/Advice/style-guide/BDA-Style-Guide-2023.pdf
[^irest]: Trauzettel-Klosinski & Dietz (2012). IReST. *IOVS*. https://iovs.arvojournals.org/article.aspx?articleid=2166061
[^brysbaert]: Brysbaert (2019). How many words do we read per minute? *Journal of Memory and Language*. https://www.researchgate.net/publication/332380784
[^mdn-highlight]: MDN `::highlight()`：https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::highlight ；支持情况：https://caniuse.com/mdn-api_highlight

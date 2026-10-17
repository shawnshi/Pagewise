# 点睛阅读 · 调研与产品设计

> 2026-10-05 · 状态：设计稿，尚未实现 · 范围：可重排书籍（foliate：EPUB/MOBI/AZW3/FB2 + TXT/MD/HTML）；PDF 论文不在本期
> 相关：`docs/reading-experience-plan.md`（需求 F1–F6、Q5）、`docs/reading-modes.md`（打字机、Highlight API 方案）、`docs/sync.md`、`src/services/ai.ts`、`relay/`
> 命名：**点睛阅读**（取「画龙点睛」：AI 预读全书，为你点出书中的「睛」）。曾用名「结构化阅读」，此前也叫过 AI 辅读、AI 速读、AI 预读、重点标注；以后统一叫点睛阅读，不再使用这些名字。
> 英文界面用 **Spotlight Reading**，开关副标题：「AI 先读一遍，为你点出关键概念与要句」/ "AI pre-reads and spotlights the key ideas"。

## 0. 结论

1. **点睛阅读是叠在原文上的一层标记，不是新的排版模式。** 原文一个字都不改、不隐藏、不改写。它与打字机、歌词、听书等模式可以同时开。入口放在「阅读模式」面板顶部的开关。
2. **行内只放三种标记**：要句（朱色实线下划线）、概念（墨青色字加点线下划线，可以点开）、注（行尾小圆点角标，可以点开）。「要点」和「核心观点」不在行内画，分别放进章首的「要义」卡和「脉络」面板。三种标记靠线型和形状就能区分，不依赖颜色，所以色盲读者和墨水屏同样可用。
3. **标记要少。** 默认只标约 8% 的文字，上限 15%，密度分「少 / 标准 / 多」三档，拖动即时生效，不需要重新请求 AI。依据是：不当或过量的预标记会损害理解（Silvers & Kreiner 1997；Fowler & Barker 1974），限制划线数量反而能提升理解（Joshi & Vogel, CHI 2024）。
4. **每个标记都能说清楚为什么标它，也都能一键否掉。** 长按要句可以看到「为什么标」（不超过 20 字），选「不是重点」后这条消失；选「我也觉得」后它转成用户自己的划线，会进入笔记并参与同步。
5. **速读是点睛阅读里的一个视图，不是单独的模式。** 它按顺序列出各章要义和要句，点一下就回到原文里的对应位置。界面写明「适合预览和复习，不能代替细读」。速读的效果是帮人更快找到信息，并没有证据说明它能提升理解：Scim 让找信息的时间缩短约 20%，正确率没有变化。
6. **技术上不改 DOM。** 用 CSS Custom Highlight API 换颜色、画下划线，用 foliate overlayer 画角标和边线。双语译文和文化注通过给段落加属性、再用 `::after` 显示的方式插入，不插入节点、不拆分文本节点，所以 CFI、已有标注、听书、搜索都不受影响。做不到加粗或斜体，用线型和描边代替。
7. **句子由客户端编号，模型只返回编号。** 客户端用现有的 `splitSentences` 切句并编号，模型返回句号和不超过 12 字的术语原文，不复述整句。这样从结构上消除了「编造引文」，输出也比实测时短约 40%，打开一章后不到 3 秒就能看到第一批标记。
8. **默认走内置通道**：在 relay 上新增一个 `/v1/dianjing` 专用接口，提示词放在服务端，使用 SiliconFlow 的 `deepseek-ai/DeepSeek-V4-Flash`，并关闭思考（`enable_thinking:false`）。额度按「设备每天处理的字数」计，另设全站每日预算上限。用户也可以填自己的密钥或用本机 Ollama。一本 20 万字的中文书，全书点睛约花 ¥1（日间价，未复核）。
9. **结果缓存在本地。** 缓存按「书的 hash + 段落块 hash + 模型 + 提示词版本」索引，读过的部分离线也能用。MVP 只同步用户的反馈（转成划线的条目本来就会同步）；v2 再把缓存作为按内容寻址的文件同步。
10. **分期**：MVP 做行内三种标记、概念卡、密度、反馈、内置通道和缓存；v2 做章首要义、脉络面板、速读视图、双语和文化注、与打字机和听书联动；v3 做全书预读、学习回顾、PDF 论文接入，以及按读者水平调整解释。

## 1. 命名与边界

| 项 | 规定 |
|---|---|
| 功能名 | 点睛阅读（英文 Spotlight Reading）。不起别名；子功能使用通用词：要句、概念、注、要义、脉络、速读 |
| 英文名理由 | 名字描述的是「光打在要紧处」这个视觉效果；不和用户自己的 Highlights（划线）撞名，也不和 Focus（歌词、沉浸里的「聚焦」）撞名；macOS 的 Spotlight 是系统搜索，在阅读器里不会混淆。弃用 Key Points：它和「要点」重名，而且只说了内容，没说出呈现方式 |
| 撞名提醒 | 论文阅读器的 Agent 侧栏在界面上叫「AI 辅读」（`zh.ts` 中的 `paper.agentTitle`、`settings.paperAgentsTitle`），而这个词在需求表里曾被列为本功能的别名。**建议把论文侧的「AI 辅读」改名为「论文 Agent」**，与 `docs/paper-reading.md` 的用词一致，并把「AI 辅读」从命名表中划掉 |
| 与「AI 解读」的关系 | 划词「AI 解读」（`aiExplainSelection`）保留，用于用户自己选中文字的情况；点睛阅读里的概念卡是**预先算好的**，点开「展开」后进入同一个 AI 侧栏 |

## 2. 调研

证据评级沿用 `docs/reading-modes.md` §2.1：**A** 表示多项独立研究或综述且结论一致；**B** 表示少量同行评审研究，结论正向但效应小；**C** 表示间接证据、厂商说法或产品观察；**A−** 表示证据充分，但结论是无效或有害。

### 2.1 先例与竞品

| 产品 / 研究 | 做法 | 我们学什么 | 评级 |
|---|---|---|---|
| **Scim**（AI2 Semantic Reader，IUI 2023）[^scim] | 在论文原文里按目的、新意、方法、结果四个维度用四种颜色标出要句；标记在全文均匀分布，几乎每段至少一句；提供全局密度滑条和每段的 +/- 按钮；滚动条上有标记；侧栏列出全部要句，点击回到原文 | 实验室研究（N=19）：找信息用时 94 秒，普通阅读器 118 秒（p<.05）；但答案**不在**标记里时，两者用时没有显著差别；正确率 0.80 对 0.76，差异不显著。日记研究（N=12）中 70% 的会话认为有帮助，信任需要一段时间建立。设计上的教训：**下划线太淡，不容易被注意到；把其余文字压暗会分散注意力；颜色最多四种；大多数人第一天把密度调到合适后就不再动** | B |
| ScholarPhi / Paper Plain（Semantic Reader）[^sr][^plain] | ScholarPhi 点击术语即显示定义，而且是「按位置」给出最近一处的定义；Paper Plain 在章节旁提供白话摘要，并把关键问题做成索引 | ScholarPhi 让回答术语类问题更快。Paper Plain（N=24）让读者觉得更轻松、更有把握，**但答题正确率没有提升**：这正是「理解错觉」的风险。我们的概念卡同样按位置取义；所有 AI 内容都要标明是 AI 生成 | B |
| CiteSee（CHI 2023 最佳论文）[^citesee] | 按读者自己的阅读历史，对引文做个性化标记 | v3 可以借鉴：已经掌握的概念不再标注 | B |
| Kindle X-Ray / Word Wise / Recaps / 热门划线[^xray][^ww][^recaps][^pophl] | X-Ray 列出人物、术语索引；Word Wise 在难词上方显示释义，有「更少 / 更多提示」滑条；Recaps 用生成式 AI 加人工审核写系列前情；热门划线用点线下划线并显示人数 | 用滑条控制密度、释义写在原文旁边，这两点用户已经熟悉。X-Ray 一直有剧透问题，KOReader 社区专门提出了「无剧透 X-Ray」的需求[^koxray]。热门划线常被建议关掉[^aa]，说明**常驻的强调必须能一键关闭** | C |
| 微信读书 AI 问书 / AI 大纲 / 划线人数[^wxds] | 选中文字后问 AI；AI 大纲约 30 秒生成全书框架；划线显示有多少人划过，可以只读热门划线 | 「只读热门划线」就是速读的社交版。我们没有社交数据，由 AI 来选；大纲对应我们的「脉络」 | C |
| 得到 AI 学习助手、Kimi、豆包、NotebookLM[^nblm] | 针对整本书对话、总结，生成学习指南和思维导图 | 这些产品的产出**离开了原文**。我们的差异在于所有产出都锚定到原文位置，读者随时可以回到原文核对 | C |
| Readwise Reader Ghostreader[^ghost] | 对选中文字提供释义、百科、翻译、简化、提问，提示词可以自定义 | 概念卡里的动作（解释、翻译、展开）照这一套来；提示词开放给用户自定义放到 v3 | C |
| LiquidText / MarginNote / Heptabase[^mn] | 摘录卡片与原文双向链接，可以拼成导图 | 「脉络」面板里的每个节点都要能双向跳转；导出时附带位置 | C |
| Glasp / Snipd[^snipd] | 社交划线；播客自动分章、提取精华并导出到 Readwise | 导出的格式要能被笔记工具接收（Markdown，附章节和原句） | C |
| Speechify / ElevenReader[^eleven] | 朗读时高亮同步，面向读写障碍和 ADHD 人群 | 听书时强调要句（§5） | C |
| 沉浸式翻译[^imt] | 原文与译文逐段对照，可以生成双语 EPUB | 双语以段落对照为主；我们只翻译要句或用户点到的句子，不整本翻译 | C |
| LingQ[^lingq] | 生词蓝色、学习中的词黄色，点一下显示释义，翻页后没点过的词视为已认识 | 「点一下就看到解释」和「状态随阅读变化」：已经点开看过的概念，之后不再重复标注 | C |
| 评点本、研读本（金圣叹、脂砚斋、ESV Study Bible）[^pd][^qd][^esv] | 回前总评、眉批、夹批、旁批，加上圈点（「凡文之佳处用圆圈○，次则尖圈△，又次则旁点」；「观圈而知意之工，观点而知词之工」）；研读本则是书前导论、大纲，经文旁有交叉引用，页脚有注释 | **这是点睛阅读最直接的设计原型**：章首要义对应回前总评，行内标记对应圈点，概念卡和注对应夹批，脉络对应大纲。用朱色作为强调色也来自「朱批」的传统 | C（设计传统，不是效果证据） |

### 2.2 学习科学证据

| 主题 | 证据 | 评级 | 对设计的含义 |
|---|---|---|---|
| 提示（signaling / cueing）原则 | Richter, Scheiter & Eitel 2016 元分析：提示对理解和迁移有小到中等的效应（r≈.17），对**先备知识少**的读者效果最明显[^richter]；Lorch 1989 综述：几乎所有提示都能改善读者对**被提示内容**的记忆，对未被提示内容的记忆通常没有影响[^lorch] | A | 提示有用，但收益集中在被提示的内容上，所以选得准比标得多更重要。新手读者受益最多，可以默认开启；专家可以调低密度 |
| 预先存在的划线 | Silvers & Kreiner 1997：**不当划线**降低理解，事先警告读者也消除不了这种影响；恰当划线与没有划线相比无显著差异[^silvers]。Fowler & Barker 1974：划得越多，成绩越差；读者相信划线确实区分了重点与琐碎时才受益[^fowler] | A−（对不当或过量的标记） | **准确率是生死线**：宁可少标，也不能错标。要有「为什么标」和「不是重点」，保持读者的判断权 |
| 限制划线数量 | Joshi & Vogel, CHI 2024（N=127）：限定最多划 150 词的组，24 小时后的理解测验成绩高于不限组和不划组[^joshi] | B | 密度要设上限；把用户「采纳」AI 标记也做成一种主动选择（§4.8） |
| 划线作为学习策略 | Dunlosky 等 2013 把划线评为「低效用」[^dunlosky]；Yue 等 2015 发现划线有一定好处，且不损害对未划内容的记忆[^yue] | A（自己划线收益有限） | 不宣传「AI 划重点帮你学会」；产品定位是导读和帮人找到要处 |
| 先行组织者 / 预览 | Luiten 等 1980 元分析：学习 d≈0.21，保持 d≈0.26；Stone 1983 的结论一致，并指出书面形式有效[^ao] | A（效应小） | 在章首放「要义」卡（一段，不超过 120 字），给读者先搭一个框架 |
| 旁注与释义（glossing） | Yanagisawa, Webb & Uchihara 2020 元回归（42 项研究，N=3802）：释义对二语词汇学习的即时效果中等，延迟效果小[^gloss] | A（二语场景） | 外语书里的概念卡和译文有依据；母语书里的概念卡只解释书内专门含义，不当字典用 |
| 速读 | Rayner 等 2016 综述：速度和理解之间存在取舍，速读训练做不到它宣传的效果[^rayner] | A− | 速读视图只说「预览、复习、找信息」，不承诺提速 |
| 依赖 AI 与理解错觉 | Kreijkes 等 2025（N=405，随机实验）：只用 LLM 的组，理解和保持都不如记笔记组和「记笔记加 LLM」组，但学生更喜欢用 LLM[^kreijkes]。Joshi & Vogel 2025 的 AI 旁注实验：AI 参与程度对理解没有可测的影响，但 AI 参与越少，读者的心理所有感越强；读者也更喜欢旁注，而不是聊天窗口[^margin]。Paper Plain：读者信心上升，正确率没有变化 | B | 原文永远是主体；AI 内容嵌在原文旁边，而不是放在一个独立的聊天窗口；鼓励读者「采纳」并写想法；不能做「AI 读完代替你读」的功能 |

### 2.3 推导出的设计规则

- **R1 不碰原文**：不隐藏、不改写、不重新排序。速读视图只是原文的索引，每一项都附有回到原文的入口。
- **R2 密度有上限**：要句默认占文字的 8%，三档分别为 5%、8%、15%（按字数算）。每段最多 2 句，每章至少 1 句，并在全文均匀分布（学 Scim）。概念只标在每章第一次出现处和下定义处。
- **R3 不靠颜色单独传达信息**（WCAG 1.4.1[^wcag]）：类型靠线型和形状区分，颜色只是辅助。
- **R4 讲清原因、可以纠正**：每个标记都有原因，都能一键否掉；否掉的标记不再出现，并影响同一本书后续的提示（v2）。
- **R5 标明 AI 来源**：卡片里注明「AI · 依据本书上下文」；文化注如果涉及书外知识，要注明「书外补充」。
- **R6 不剧透**：概念解释、脉络、要义只使用读者当前位置之前的内容和当前这一块内容。叙事类书籍默认不预读后文的要义。
- **R7 少用 AI 的视觉权重**：AI 标记的视觉权重始终低于用户自己的划线。用户划线是实心色块，AI 标记只用线条和细小的符号。
- **R8 永远不阻塞阅读**：AI 失败、离线或额度用完时，正文照常显示，只在角落显示状态。

## 3. 视觉语言

### 3.1 层级

| 层 | 内容 | 位置 | 视觉形式（彩色主题） | 不靠颜色时的区分 |
|---|---|---|---|---|
| 篇 | 核心观点（全书 / 全章） | 脉络面板、章首要义卡 | 卡片，不进入正文 | — |
| 段 | 要点（段意，不超过 40 字） | 脉络面板；在速读视图中显示为段首边线 | overlayer 在段落左侧画一条 2px 竖线 | 竖线本身 |
| 句 | **要句**（睛） | 行内 | 朱色实线下划线，粗 0.1em；在速读视图中再加 10% 的朱色底 | 实线 |
| 词 | **概念**（可以点开） | 行内 | 文字改为墨青色，加 1px 点线下划线 | 点线 |
| 注 | 文化注、典故、译文锚点 | 行内末尾 | overlayer 在末字右上角画一个直径 0.3em 的圆点 | 圆点（墨水屏用空心圆） |

同一处的叠加规则：概念位于要句里面时，两种线都画（概念的点线比要句的实线细，位置相同，概念的颜色覆盖要句）；注的圆点不和其他标记冲突。

### 3.2 技术约束与取舍

- `::highlight()` 只能改 color、background-color、text-decoration 及其子属性、text-shadow、`-webkit-text-stroke-*`、`-webkit-text-fill-color`[^mdn]。text-underline-offset 是否在允许之列，规范里还没有定论[^csswg7101]，所以不依赖它。**不能用 font-weight 或斜体**：加粗会改变字宽、引发重排，斜体对读写障碍读者也不友好（BDA，见 `docs/reading-modes.md` §2.4）。
- 「加粗感」的替代办法是 `-webkit-text-stroke-width: 0.02em`（描边加粗，不改变字宽），只用于墨水屏上的概念，需要实测（与 `reading-modes.md` §5.4 的待测项合并）。
- 不支持 Highlight API 的旧 WebView（低于 Chrome 105 / Safari 17.2）：改用 overlayer 画要句的下划线（`Overlayer.underline`）和概念的下划线（自定义一个点线 drawFn）。概念不改文字颜色，只保留点线。
- **可以改 DOM 的情况，只有一种**：在已有块元素（如 `p`）上**设置属性**，例如 `data-lr-dj-tr="…"`，再由 `p[data-lr-dj-tr]::after{content:attr(data-lr-dj-tr);display:block}` 显示译文或注释。这样不增删节点、不拆分文本节点，CFI 和已有标注不会偏移，伪元素里的文字也不会被听书和搜索读到。代价是会重排，所以只在用户主动打开双语或注释时使用。**禁止**为了加粗、斜体或着重号去用 `span` 包裹正文：那会破坏 CFI、foliate 的搜索和 TTS 的块迭代器。
- Highlight 的优先级用 `highlight.priority` 设置：打字机的隐藏层 > 听书当前句 > 歌词聚焦 > 点睛（§5）。

### 3.3 各主题取值

把下面这组颜色加进 `READER_THEMES`，新增字段 `djKey`、`djTerm`、`djNote`、`djBand`。它们是正文主题的取值，不是外壳的令牌，所以写在 `getReaderCSS()` 里（规则与 `reading-modes.md` §4.2 相同）。括号里是相对正文底色的对比度，全部 ≥4.5，已用脚本计算核对。

| 主题 | 底 / 字 | 要句 `djKey`（朱） | 概念 `djTerm`（墨青） | 注 `djNote`（赭） | 速读底 `djBand` |
|---|---|---|---|---|---|
| 亮 light | #ffffff / #1d2129 | #c2410c (5.2) | #0f6e6e (6.0) | #9a6700 (4.9) | rgba(194,65,12,.10) |
| 护眼·米黄 sepia | #faf3e7 / #453c2c | #b03a12 (5.5) | #1d6560 (6.2) | #8a5a00 (5.4) | rgba(176,58,18,.10) |
| 护眼·绿 green | #c7edcc / #243528 | #9c2f0c (5.8) | #0b4f63 (7.1) | #6e4700 (6.4) | rgba(156,47,12,.10) |
| 夜间 dark | #17181a / #c5c8ce | #ff9466 (8.2) | #6fd3c6 (10.0) | #e3b65c (9.4) | rgba(255,148,102,.14) |
| 墨水屏（规划中） | #ffffff / #000000 | #000 实线 0.12em | #000 点线，描边 0.02em | 空心圆 | 不使用；速读时要句改用双实线 |

- 朱色与用户四种划线色（`HIGHLIGHT_COLORS`）的形态不同：用户划线是半透明的**色块**，AI 标记是**线**，同屏出现也能区分（R7）。
- 墨青不使用正文链接色（light 主题下是 #1664ff），避免被误认为超链接。
- 用色盲模拟检查过：在红绿色弱下，朱与墨青仍然对比明显；朱与赭会接近，但两者形状不同（线和圆点），可以区分。

```css
::highlight(lr-dj-key)  { text-decoration: underline solid var(--dj-key) 0.1em; text-decoration-skip-ink: none; }
::highlight(lr-dj-term) { color: var(--dj-term); -webkit-text-fill-color: var(--dj-term); text-decoration: underline dotted var(--dj-term) 1px; }
::highlight(lr-dj-band) { background-color: var(--dj-band); }   /* 只在速读视图启用 */
```

（`var()` 只是示意，实际由 `getReaderCSS` 按主题写入颜色字面量，与现有的 `readingModeCSS` 做法相同。）

## 4. 交互

### 4.1 入口与设置

- 「阅读模式」面板（`ReadingModePanel.vue`）在分页标签（自动翻页 / 打字机）**上方**新增一行「点睛阅读」开关，下面是副标题；开关打开后展开：密度分段控件「少 / 标准 / 多」（全局类 `.segmented`）、类型多选（要句 / 概念 / 注，默认全选）、「速读视图」按钮、本书状态（例如「已点睛 34% · 离线可用」）。
- 第一次打开时弹出同意说明（§6.7），有「本书开启」和「所有书开启」两个选项。
- 快捷键：`D` 开关点睛阅读，`[` / `]` 跳到上一个 / 下一个要句（实现时需在 `keyboardShortcuts.ts` 里核对是否冲突）。
- 设置项：`settings.dianjing = { enabled, density, kinds, perBook: Record<bookHash, boolean>, consent }`，按 CLAUDE.md 的约定添加到 `SettingsState` 和 `defaults`。

### 4.2 渐进出现

- 打开某章时，先查缓存，命中就立即显示。没命中时，**先请求当前可见位置所在的块**（而不是从章首开始），再按阅读方向往后预取。
- 标记逐条出现（按 NDJSON 一行一条），不做淡入动画；系统开了「减少动效」或在墨水屏上时，攒到下次翻页再一起画，避免墨水屏反复刷新。
- 状态显示在阅读器角落，是一个点：灰色表示「点睛中」，不打扰阅读；出错时变为可以点开的小图标。

### 4.3 点概念 → 释义卡

- 概念上覆盖一个可点击区域（overlayer 不接收指针事件，所以在 iframe 里监听 `click`，用 `caretPositionFromPoint` 命中某个 Range 后判断属于哪个概念）。
- 释义卡（不超过 40 字，预读时已经生成）立刻弹出，样式和位置与选中文字的工具条相同。卡片内容：词条、释义、来源（「AI · 依据本书第 3 章」）、「本书中首次出现」的跳转链接；按钮有「展开」（打开 AI 侧栏，带上原段落和此前各处的释义，调用 `sendAi`）、「翻译」、「不用标这个」。
- 释义按位置给出：如果同一概念在后文被重新定义，就取读者当前位置之前最近的一处定义（学 ScholarPhi），不剧透（R6）。

### 4.4 长按要句

弹出菜单：**为什么标**（不超过 20 字，例如「本章核心论点」）· 翻译 · 我也觉得（转为我的划线）· 不是重点 · 写想法。菜单复用现有的选中工具条，在上面新增一个分组。

### 4.5 章首要义卡（v2）

- 章节第一页正文上方显示一张可以收起的卡片：一段话说明本章讲什么（不超过 120 字），外加 3 个要点，每个要点都能点击跳转。卡片放在 overlayer 之外的阅读器外壳里，固定在页面顶部，不进入 iframe，所以不会重排正文。
- 生成方式：等本章各块的段意都生成之后，再做一次汇总调用。章节不超过 6,000 字时，直接一次调用完成。
- 叙事类书籍：「要义」只总结已经读过的部分，所以章首显示的是「上一章回顾」，读完一章后再生成本章要义（R6）。

### 4.6 脉络面板（v2）

- 在侧栏新增一个标签「脉络」，与目录、笔记并列，按「章 → 要点 → 要句」三级大纲排列，每个节点都能跳转到原文；概念单独列在「本书词表」里，按首次出现排序。
- 读到的位置在大纲中同步高亮，类似 Scim 的侧栏加上下文链接。导图视图放到 v3。

### 4.7 文化注与双语（v2）

- **注**：典故、历史背景、文化差异（比如英文书里的 Thanksgiving，中文书里的「郑人买履」）。点一下行尾的圆点，弹出注卡（不超过 80 字）。打开「展开注释」后，注改为在段落下方以脚注的形式显示（属性加 `::after`，见 §3.2）。
- **双语**：书的语言与界面语言不同时，在类型多选中出现「译文」。默认只为**要句**配译文，显示在段落下方；要整段对照，需要用户明确选择「整段对照」。整书翻译不在这个功能的范围内，引导用户使用沉浸式翻译这类工具。
- 「文化迁移」在提示词里是一项明确的任务：只有在文化差异会影响理解时才生成注，每 1,000 字不超过 1 条。

### 4.8 反馈与笔记

- **不是重点**：在本地记录 `{bookHash, chunkHash, itemId, action:'dismiss'}`，这条标记立即消失。v2 起，同一本书再生成时，会把被否掉的类型附进提示词（例如「读者不希望标注举例句」）。
- **我也觉得**：调用现有的 `AnnotationRec`，`kind:'highlight'`，颜色用用户最近一次用过的颜色，`note` 留空，再引导用户写想法（这是有学习证据支撑的主动加工，见 §2.2）。转过去之后，这一处就成了用户自己的划线，现有的同步、导出、笔记面板全都可以直接用。
- **导出**：「本章要义与要句」导出为 Markdown，内容包括章名、要义、要句原文、用户的想法，以及 `lightread://` 位置链接（v2）。

### 4.9 速读视图（v2）

- 一个全屏面板：按章列出要义，每章下面是这一章的要句（按密度档过滤）。点击任意一句，就回到原文的这个位置，并让这一句闪烁 1 秒。
- 正文里的「跳读」：在点睛阅读开启时，翻页按钮的长按菜单里加上「下一个要句」，快捷键是 `]`。
- 「淡化其余文字」只作为选项，默认关闭：Scim 发现把非重点文字压暗会分散注意力。
- 界面固定显示一行说明：「适合预览和复习，不能代替细读」。

## 5. 与其他阅读模式组合

**叠加优先级**（从高到低，一个位置上只显示最高的一层，低层只在不冲突时显示）：打字机的隐藏、淡显层 > 用户自己的划线 > 听书当前句 > 歌词聚焦行 > 点睛阅读 > 仿生阅读。**同一时间作用在正文字形上的强调系统最多两种。**

| 模式 | 组合方式 |
|---|---|
| 打字机 | 要句的出字速度为设定速度的 0.7 倍，「墨迹未干」用 `djKey` 色。在速读视图下打开打字机时，非要句立即以淡显色整句出现（跳过），只有要句逐字打出：这就是「跳读打字机」。光标之后还没出现的部分不画点睛标记（隐藏层优先） |
| 歌词 | 聚焦行内的要句下划线保持原样；聚焦行以外的标记随正文一起压暗。聚焦行停在要句上时，停留时间乘以 1.3 |
| 听书 | 读到要句前停顿 300ms，语速降低 8%（Edge 用 SSML 的 `prosody`，Kokoro 用 rate 参数，听感需要实测）。章首可以选择先朗读「本章要义」（v2）。全书读完一章后，可以选择生成一段「本章回顾」朗读（v3）。要句与听书使用同一套切句（`splitSentences`），编号一致，所以「跳到下一个要句」在听书中可以直接用 |
| 按词着色（原仿生阅读） | **已并入点睛阅读，成为基础版**（2026-10，`dianjing.level`）：本文档描述的 AI 点睛为智能版。两个版本在同一开关下二选一，同一时间只生效一个，不再有互斥提示；用户文案见 manual/05-点睛阅读.md |
| 大字 | 线宽用 em 作单位，随字号放大；密度不变（按字数比例计算） |
| 墨水屏 | 使用灰阶取值（§3.3），不做渐进出现，不显示底色，弹卡不加阴影 |
| 夜间 / 护眼 | 取 §3.3 中对应主题的值；`auto` 跟随外观，与正文主题的规则一致 |
| 沉浸 | 标记保留，状态点隐藏 |
| 自动翻页 | 不冲突；在速读视图下自动翻页时，跳过没有要句的页面放到 v3 再评估 |

## 6. 架构与成本

### 6.1 流水线

```
章节加载(load) → blocks.ts 取块 → 按段聚合为 chunk(800–1500 字, 不跨章, 段落完整)
  → splitSentences 编号 [p.s] → 缓存查找 → 未命中: 队列(当前块优先, 并发 3)
  → POST /v1/dianjing (流式 NDJSON) → 逐行校验/锚定 → Range 集合 → Highlight / overlayer
  → 写缓存 → 章内全部完成后 → 汇总调用(要义/脉络, v2)
```

模块划分（新增 `src/services/dianjing/`，纯函数与 DOM 分开，方便单测）：
- `chunker.ts`（纯函数）：分块、编号、chunkHash。
- `protocol.ts`（纯函数）：NDJSON 解析、字段校验、密度过滤。
- `anchor.ts`：把编号和术语转换成 Range，带模糊回退。
- `layer.ts`（DOM）：注册 Highlight、overlayer 的 drawFn、命中检测。
- `queue.ts`：调度预取、并发、取消。
- `cache.ts`：IndexedDB 存取。
- `prompt.ts`：提示词与版本号，与 relay 共用。

### 6.2 分块与预取

- 块大小默认 1,000 字；**打开章节后的第一块用 600 字**，让首条标记更快出现。并发 3 个请求。手机上并发 2 个，避免与听书抢网络。
- 预取窗口：始终保持当前位置之后有 2 块已经完成；读到本章 60% 时，开始预取下一章的前 2 块。
- 时间预算（按实测 45–50 字/秒）：每块输出约 400 字，需要约 8–9 秒，加上首字 1.3 秒，约 10 秒一块。按 400 字/分的阅读速度，读完 1,000 字要 2.5 分钟，生成速度大约是阅读速度的 15 倍，预取足够跟上。

### 6.3 输出协议与提示词

- 输入：书名、作者、章名、本块编号后的文本（`[3.2] 句子……`）、已知概念表（同书已经释义的词，最多 30 个，用来避免重复）、密度上限、输出语言。
- 输出：每行一个 JSON，**按句号顺序**输出，这样前端可以从上往下逐步渲染：

```json
{"t":"key","s":"3.2","r":2,"why":"提出本章核心论点"}
{"t":"term","s":"3.4","q":"边际效用","def":"每多得一单位物品带来的额外满足","first":true}
{"t":"note","s":"5.1","q":"郑人买履","k":"culture","text":"《韩非子》寓言，讽刺只信教条不信实际"}
{"t":"tr","s":"3.2","text":"…"}
{"t":"gist","p":3,"text":"本段区分总效用与边际效用"}
```

- 规则写在提示词里：`q` 必须是 `s` 句中**一字不差**的子串，长度不超过 12 字；没有把握就不输出；`r` 是重要度 1–3，客户端按密度档过滤，所以**生成一次，三档都能用**，拖动滑条不需要重新请求；每段最多 2 条 `key`；`why` 不超过 20 字，`def` 不超过 40 字，`note` 不超过 80 字；只有文化差异会影响理解时才写 note；叙事类不得提到本块之后的情节。
- 调用参数：`model: deepseek-ai/DeepSeek-V4-Flash`、`enable_thinking:false`、`temperature:0.2`、`stream:true`、`max_tokens:1500`。
- 语言：`def`、`why`、`note` 使用界面语言；书是外语时，另外输出 `tr`。文言文书籍的 `tr` 用白话（v2 实测）。

### 6.4 锚定

1. `key` 只用编号，一定能找到对应句子；编号不存在就丢弃这一条。
2. `term` 和 `note`：先在 `s` 句里精确查找 `q`；找不到时，做 NFKC 规范化、全半角与空白折叠后再查；还找不到，就在本段内查找；4 字以上的词允许编辑距离为 1。全部失败就丢弃这一条，并计数（指标「锚定丢弃率」）。
3. 句子到 Range 的转换复用打字机的 `blocks.ts` 中的 `locate(offset)`。在 foliate 重排或换章时，Range 会随文档卸载而失效，从缓存重新建立即可，不需要重新请求 AI。

### 6.5 缓存与同步

- 键：`bookHash : sectionIndex : chunkHash : model : promptVersion`。值是校验后的条目。Web 端和桌面端都存在 IndexedDB 库 `lightread-dianjing` 里（与同步基线 `lightread-sync` 的做法相同）。一本 20 万字的书约 80KB。
- 改了提示词就提升 `promptVersion`，旧缓存继续使用，直到用户点「重新点睛本章」。
- 同步：MVP 只同步通过「我也觉得」转成划线的条目（走现有的 annotations）；「不是重点」的记录先只存在本地。v2 把每本书的缓存打包成 `dianjing/<bookHash>.<promptVersion>.json.gz`，像书籍文件一样按内容寻址，WebDAV 和账号后端都可以存。这是派生数据，不含整段原文，但含有不超过 12 字的术语原文和要句编号。`docs/sync.md` 需要新增一节说明。

### 6.6 内置通道（relay）

现有的 relay 只放行智谱的免费模型，每个 IP 每分钟 10 次，每台设备每天 120 次。点睛阅读按块调用，一本书约 200 次请求，现有额度不够；而且换成收费模型之后，「免费白名单」这道防线也就没有了。方案如下：

- 新增路由 `POST /v1/dianjing`：请求体是 `{promptVersion, lang, book:{title,author}, chapter, chunk:{text, sentences}}`。**提示词放在服务端拼装**，客户端不能传任意消息，所以这个接口无法被当成免费的通用 DeepSeek 代理来用。单块不超过 3,000 字，`max_tokens` 不超过 1,500，强制设置 `enable_thinking:false`。
- 密钥：Worker 的 secret `SF_KEY`，值取自 `~/.config/tokenssh-ai/siliconflow.key`，不进入代码仓库。
- 额度按**字数**计算（D1 中现有的 `usage` 表增加 `kind='dj'`）：每台设备每天 10 万字（大约是每天读 2 小时并预取的量，最多约 ¥0.5），每个 IP 每天 30 万字；另设全站每日预算 `DJ_DAILY_BUDGET_CNY`（建议 ¥50），超出后返回 429，并在响应头 `x-dj-remaining` 里告诉客户端剩余额度。这些数值需要产品负责人拍板（§10）。
- 对 `/v1/dianjing` 放宽每分钟限速（例如每台设备每分钟 20 块），其他路由保持原样。
- 可选的服务端共享缓存（v3，需要单独征得同意）：以 `sha256(chunk 文本)+promptVersion` 为键存放结果。读同一本公版书的第二个人就不用再花钱。服务端只存派生结果，但这样做相当于暴露了「有人读过这一段」，所以默认关闭。

### 6.7 隐私与同意

- 第一次开启时，弹窗写明：「开启后，你正在读的这本书的正文会分段发送给 ___（内置通道：经轻阅服务器转发给硅基流动；或你自己配置的服务）用于生成标记，结果只保存在本机。轻阅不保存正文。」两个选项：仅本书 / 所有书。
- 选择本机 Ollama 时，提示「完全离线，速度取决于本机性能」。
- 关闭功能后可以选「清除本书的点睛缓存」。设置的「AI 助手」页中能看到缓存占用的空间，并提供清理入口。
- 不发送设备标识以外的任何用户信息（现有的 `x-device-id` 是一个随机 UUID）。

### 6.8 降级

| 情况 | 行为 |
|---|---|
| 离线 | 已缓存的部分照常显示；没缓存的部分显示状态点「离线」，不重试刷屏，联网后继续 |
| 内置额度用完 | 停止预取；状态点变为可以点开，提示「今日内置额度已用完 · 填入自己的密钥不限额」，并跳转到「设置 → AI 助手」 |
| 模型输出格式错误 | 坏行跳过，其余行照常使用；一块的丢弃率超过 50% 时重试 1 次 |
| V4-Flash 不可用 | relay 切换到备用模型（如 Qwen3.5-35B-A3B，或现有的 GLM-4.7-Flash），在 `promptVersion` 中带上模型名，以免混用缓存 |
| 不支持 Highlight API | 走 overlayer 回退（§3.2） |
| 固定版式 / CBZ / PDF | 开关置灰，说明「本格式暂不支持」 |

### 6.9 成本估算（20 万字中文书，全书点睛）

- 换算：DeepSeek 文档给出的经验值是 1 个中文字约 0.6 token，1 个英文字符约 0.3 token[^dstok]。
- 输入：200 块 ×（正文 1,000 字 + 编号 80 字 + 上下文 150 字 + 提示词 700 字）≈ 38.6 万字 ≈ 23 万 token，其中提示词约 8.4 万 token 可以命中缓存。输出：每块约 400 字，加上要义汇总，合计约 5.4 万 token。
- SiliconFlow 中国站的价格[^sfcn]（2026-10-04 网页抓取，**未复核**，以控制台为准）：V4-Flash 在 8–24 点和 0–2 点，输入 ¥3、缓存命中 ¥0.3、输出 ¥9（每百万 token）；2–8 点半价。据此估算：**日间约 ¥1.0 一本，夜间约 ¥0.5 一本**。国际站标价是 $0.14 / $0.028 / $0.28[^sfen]，折合约 $0.04 一本。英文书的 token 数更少。
- 时间：全书生成 200 块，并发 3，约 11 分钟；按阅读进度逐步生成时，读者感觉不到等待。

### 6.10 评测

- **样本集**：12 本书，每本 3 块，共 36 块，类型覆盖：中文社科、中文小说、文言、英文非虚构、英文小说、技术书。3 名标注者各自独立按 8% 的预算标出要句和概念。
- **指标**：
  - 要句准确率：以多数标注者的选择为准，看 AI 要句中有多少被选中；目标是不低于标注者两两之间的平均一致度，下限 0.55。
  - 「明显不当」率：至少 2 人判定为琐碎或错误的句子所占比例，必须 ≤5%（Silvers & Kreiner 说明这是生死线）。
  - 概念释义正确率 ≥95%。
  - 注中的事实错误 ≤2%。
  - 锚定丢弃率 ≤3%。
  - 叙事类剧透必须为 0。
- **延迟**（K30 Pro、4G 或 Wi-Fi，内置通道）：
  - 缓存未命中时，从打开章节到第一条标记出现：p50 <2 秒，p95 <3 秒。
  - 缓存命中时 <300ms。
  - 打开点睛阅读后，翻页耗时的 p95 增量 <5ms（写进 `docs/perf-ledger.md`）。
- **回归**：`scripts/test-dianjing.mjs` 覆盖分块、协议解析、锚定、密度过滤和叠加优先级。e2e 中模拟 relay 返回固定的 NDJSON，断言标记出现，并断言关闭后正文完全恢复。

## 7. 分期计划

| 期 | 范围 | 验收标准 |
|---|---|---|
| **MVP**（约 1 个迭代） | 开关和同意弹窗；分块、编号和锚定；行内的要句和概念（Highlight API，外加 overlayer 回退）；概念卡（预生成的释义，「展开」进入 AI 侧栏）；长按要句（为什么标、我也觉得、不是重点）；三档密度；本地缓存；relay 的 `/v1/dianjing` 路由和按字数的额度；自己的密钥、Ollama；4 种主题的取值；与打字机、仿生阅读的优先级和互斥；i18n | 纯函数测试与 e2e 通过；在样本集上达到 §6.10 的准确率和延迟目标；K70、K30 Pro 实机连续读 30 分钟，标记不错位、不卡顿；关闭后不残留任何 `lr-dj-*` Highlight；断网和额度用完时都不影响阅读 |
| **v2** | 章首要义卡；脉络面板（大纲和本书词表）；速读视图和跳读；注；双语要句；与听书联动（停顿、要义朗读）、打字机的「跳读」；墨水屏取值；反馈影响提示词；缓存同步；导出 Markdown | 10 人以上内测：速读视图的「找信息」任务用时比不开时短（目标 -20%，参照 Scim），理解测验成绩不低于不开时；被标「不是重点」的标记占已显示标记的比例 <5%；章首要义的生成在读完上一章前完成的比例 ≥90% |
| **v3** | 全书预读（用户主动发起，有进度条）；按读者掌握程度调整（已经点开过、写过想法的概念不再标）；本章回顾音频；脉络导图视图；提示词自定义；可选的服务端共享缓存；PDF 论文复用（文本层；论文的四个维度参照 Scim） | 每个功能单独立项，各自定验收标准 |

## 8. 成功指标（本地计算，不做追踪；内测时由用户主动导出诊断 JSON）

- 留存：开启点睛阅读的书，7 天后仍然开着的比例 ≥60%。
- 信任：「不是重点」次数 /（被看到的标记数）<3%；「我也觉得」的比例 ≥5%。
- 深读：开启后，每本书「写想法」的次数不下降。如果下降，说明出现了依赖 AI 的倾向，需要降低默认密度。
- 性能：§6.10 的延迟指标；内置通道的单本成本 ≤¥1.5。

## 9. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 错标、过度标注 | 降低理解（A− 级证据） | 默认 8% 加上限；`r` 分级；不当率门槛 ≤5%；一键否掉；按书学习偏好 |
| 理解错觉、依赖 AI | 读者只看标记，不读原文 | 速读视图写明「不能代替细读」；鼓励「我也觉得 + 写想法」；指标监测想法数是否下降 |
| 编造事实（注、释义） | 误导读者 | 编号锚定；注明「书外补充」；释义要求「依据本书」；评测设事实错误率门槛 |
| 剧透 | 叙事类书籍体验被破坏 | 只用当前位置之前的内容；叙事类默认不预读后文要义 |
| 成本失控、通道被滥用 | 产生费用 | 提示词放在服务端，固定 schema；按字数计额度，并设全站预算上限；自带密钥的用户不占内置额度 |
| 版权与隐私 | 正文离开设备 | 明确征得同意、按书授权；服务端不落盘正文；推荐本地 Ollama |
| 视觉噪音、与其他模式冲突 | 页面像被乱涂 | 只有三种行内标记；有优先级栈；同时最多两种强调系统；与仿生阅读互斥 |
| Highlight API 兼容性（Huawei WebView、旧 Safari） | 标记不显示 | overlayer 回退，并在「关于」里显示 WebView 版本 |
| 模型或价格变动 | 质量或成本波动 | 模型名进入缓存键；relay 可以切换备用模型；价格每个季度复核一次 |

## 10. 需要产品负责人拍板

1. **Q5 内置额度**：每台设备每天 10 万字、全站每天预算 ¥50，是否同意？超出后是否提示用户去 SiliconFlow 注册自己的密钥（使用现有的邀请链接）？
2. **默认开关**：新用户默认关闭（需要同意后才发送正文），只在阅读器里第一次打开某本书时轻提示一次。建议采用。
3. **论文侧改名**：把「AI 辅读」改为「论文 Agent」（§1）。
4. **叙事类的判断**：根据书籍元数据（subject）加上 AI 对第一块的判断，自动确定是否为叙事类，用户可以手动切换。建议采用。

## 参考

[^scim]: Fok, Kambhamettu, Lo 等 (2023). Scim: Intelligent Skimming Support for Scientific Papers. *IUI '23*. https://arxiv.org/abs/2205.04561 ；期刊扩展版 https://dl.acm.org/doi/full/10.1145/3665648
[^sr]: Lo, Chang 等 (2023). The Semantic Reader Project. https://arxiv.org/abs/2303.14334
[^plain]: August 等 (2023). Paper Plain. *ACM TOCHI*. https://arxiv.org/abs/2203.00130
[^citesee]: Chang 等 (2023). CiteSee. *CHI '23*. https://arxiv.org/abs/2302.07302
[^xray]: Amazon Kindle X-Ray：https://www.amazon.com/b?ie=UTF8&node=17717476011 ；https://en.wikipedia.org/wiki/X-Ray_(Amazon)
[^ww]: Kindle Word Wise：https://blog.the-ebook-reader.com/2014/11/16/kindle-word-wise-review-and-free-ebook-samples/
[^recaps]: Kindle Recaps（2025）：https://www.engadget.com/ai/amazon-will-use-ai-to-generate-recaps-for-book-series-on-the-kindle-170018503.html
[^pophl]: Kindle Popular Highlights：https://blog.the-ebook-reader.com/2018/02/15/viewing-popular-highlights-on-kindles/
[^aa]: https://www.androidauthority.com/kindle-popular-highlights-3634804/
[^koxray]: KOReader 关于无剧透 X-Ray 的需求：https://github.com/koreader/koreader/issues/13922
[^wxds]: 微信读书 AI 问书：https://36kr.com/p/2773806452423430 ；AI 大纲与划线：https://sj.qq.com/blog/1743567509000
[^nblm]: NotebookLM 学习功能：https://blog.google/technology/google-labs/notebooklm-studying-help/
[^ghost]: Readwise Ghostreader：https://docs.readwise.io/reader/docs/faqs/ghostreader
[^mn]: MarginNote：https://www.marginnote.com/en/index.html ；LiquidText 与 MarginNote 的对比：https://paperlike.com/blogs/paperlikers-insights/liquidtext-vs-marginnote
[^snipd]: Snipd：https://www.snipd.com/all-features
[^eleven]: ElevenReader：https://help.elevenlabs.io/hc/en-us/articles/51349952879889-What-is-ElevenReader
[^imt]: 沉浸式翻译 EPUB 双语：https://immersivetranslate.com/docs/features/epub/
[^lingq]: LingQ 阅读器：https://www.lingq.com/en/ios-app-support/
[^pd]: 评点的层级（回前总评、眉批、夹批、旁批、圈点）：https://news.gmw.cn/2026-07/04/content_38866782.htm ；https://baike.baidu.com/item/%E6%89%B9%E7%82%B9/647338
[^qd]: 明代圈点法：https://www.chinawriter.com.cn/n1/2022/0310/c442005-32371180.html
[^esv]: ESV Study Bible：https://www.crossway.org/articles/a-guide-to-esv-study-editions/
[^richter]: Richter, Scheiter & Eitel (2016). *Educational Research Review* 17, 19–36. https://www.researchgate.net/publication/287807075
[^lorch]: Lorch (1989). Text-signaling devices and their effects on reading and memory processes. *Educational Psychology Review* 1, 209–234. https://link.springer.com/article/10.1007/BF01320135
[^silvers]: Silvers & Kreiner (1997). *Reading Research and Instruction* 36(3), 217–223. https://eric.ed.gov/?id=EJ547175
[^fowler]: Fowler & Barker (1974). *Journal of Applied Psychology* 59(3), 358. https://www.semanticscholar.org/paper/39da598a53e6881e4ff4e218026b51ccfb1a1846
[^joshi]: Joshi & Vogel (2024). Constrained Highlighting in a Document Reader can Improve Reading Comprehension. *CHI '24*. https://dl.acm.org/doi/10.1145/3613904.3642314 ；https://nikhitajoshi.ca/constrained-highlighting
[^margin]: Joshi & Vogel (2025). Designing and Evaluating AI Margin Notes in Document Reader Software. https://arxiv.org/abs/2509.09840
[^dunlosky]: Dunlosky 等 (2013). *Psychological Science in the Public Interest* 14(1). https://www.whz.de/fileadmin/lehre/hochschuldidaktik/docs/dunloskiimprovingstudentlearning.pdf
[^yue]: Yue, Storm, Kornell & Bjork (2015). *Educational Psychology Review*. https://link.springer.com/article/10.1007/s10648-014-9277-z
[^ao]: Luiten, Ames & Ackerson (1980). *AERJ* 17(2). https://journals.sagepub.com/doi/abs/10.3102/00028312017002211 ；Stone (1983). https://eric.ed.gov/?id=EJ290791
[^gloss]: Yanagisawa, Webb & Uchihara (2020). *SSLA* 42(2), 411–438. https://eric.ed.gov/?id=EJ1251024
[^rayner]: Rayner 等 (2016). So Much to Read, So Little Time. *PSPI* 17(1). https://www.psychologicalscience.org/publications/speed_reading.html
[^kreijkes]: Kreijkes 等 (2025). Effects of LLM use and note-taking on reading comprehension and memory. *Computers & Education* 243. https://www.sciencedirect.com/science/article/pii/S0360131525002829
[^wcag]: WCAG 2 SC 1.4.1 Use of Color：https://www.w3.org/TR/UNDERSTANDING-WCAG20/visual-audio-contrast-without-color.html
[^mdn]: MDN `::highlight()`：https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::highlight
[^csswg7101]: https://github.com/w3c/csswg-drafts/issues/7101
[^dstok]: DeepSeek Token 用量计算：https://api-docs.deepseek.com/zh-cn/quick_start/token_usage
[^sfcn]: 硅基流动定价（中国站）：https://www.siliconflow.cn/pricing
[^sfen]: SiliconFlow 博客 DeepSeek-V4：https://www.siliconflow.com/blog/deepseek-v4-now-on-siliconflow-million-token-context-intelligence

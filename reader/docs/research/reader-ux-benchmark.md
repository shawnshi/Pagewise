# 阅读器体验对标：字节设计原则 × 听书 / 自动阅读 / 排版

> 2026-10-07 · 状态：调研稿（未改代码） · 范围：可重排书籍阅读器 `ReaderView`（听书、自动翻页/滚动、打字机、歌词、仿生阅读、排版面板）
> 前置文档：`docs/reader-panels.md`（排版与模式的分工）、`docs/reading-modes.md`（模式证据评级）、`docs/research/reading-modes-landscape.md`（定名）、`docs/continuous-scroll.md`、`docs/tts-research.md`
> 标注：**未核实** = 没拿到一手原文（只看到搜索摘要、第三方转述，或页面打不开）；【官方】= 官网、帮助中心、App Store 版本说明；【教程】= 写明版本号的百度经验等；【弱】= 疑似批量生成的内容，只当线索。

## 0. 结论

1. 字节公开的两套设计体系（Arco、Semi）对文案的要求高度一致：**用用户的话，同一件事只用一个名字，状态要看得见，能用设计防错就别靠报错，少弹提示，不夸大**。§1 把它们提炼成 8 条可以直接拿来检查轻阅的原则。
2. 听书方面，对标产品的共同做法有六点：
   - 从选中的地方开始读；
   - 当前句高亮；
   - **当前句保持在视线中部**（Voice Dream 的原话是 "always in the middle"）；
   - 用户自己滚走后**不把视图拉回去**，而是给出「回到朗读处 / 从这里读」两个去处（Readwise 的 return / jump）；
   - 有迷你播放条；
   - 定时关闭有「本章结束」选项，并显示几点停止或还剩多久。
3. 轻阅的听书**功能已经比较全**：从这里听、脱离后可回去、迷你胶囊、本章剩余时间、锁屏媒体键、断点续听都有。最大的问题在**滚动方式下的跟随位置**：每读一句都把当前句贴到视口顶部。其次，**手动滚动不算脱离**，下一句会把视图拽回去。这两条是 P0。
4. 速度类控件统一成「**很慢 / 慢 / 适中 / 快 / 很快**」五档滑条（自动翻页已在改）。**听书语速例外**：在音频场景里，「1.5 倍速」本身就是用户的说法，继续用 ×，但要给出档位，并在 1.0× 处标「正常」。
5. 现在面板文案的主要问题有三类：
   - **同一个概念有好几个叫法**：在线模型、在线语音、在线音色混用；中、适中混用。
   - **单位是给工程师看的**：字距 `0.05em`，定时只写 `15` 不带单位，歌词写 `≈ 3 秒/行`。
   - **说法绝对化**：仿生阅读强度有一档叫「最强」。

## 1. 字节跳动的设计原则

### 1.1 一手来源摘要

| 来源 | 要点（原文关键词） | 核实 |
|---|---|---|
| Arco 设计价值观 https://arco.design/docs/spec/values-of-arcodesign | **清晰**（「清晰的指向亦是效率的提升」，减少用户的判断次数）· **一致**（降低反复学习成本）· **韵律**（操作「仿佛本该如此」）· **开放**（在可配置范围内灵活调整）。总体设计语言叫「务实的浪漫主义」（https://arco.design/docs/spec/introduce） | 已核实 |
| Arco 设计原则 https://arco.design/docs/spec/philosophy | 及时反馈 · **贴近现实**（用用户的语言，不用系统术语）· 系统一致性 · **防止错误发生** · 遵从习惯（动作和选项可见，减少记忆负担）· **突出重点**（「用户的浏览动作不是读，不是看，而是扫」）· 错误帮助（用文字说明原因并给出办法）· **人性化帮助**（优先级：无需提示 → 一次性提示 → 常驻提示 → 帮助文档） | 已核实 |
| Arco 文案样式 https://arco.design/docs/spec/style-guideline | 24 小时制；省略号用「…」；中文与数字之间加空格；四位以上数字用千分位；操作文案用「动词+名词」，统计文案用「数字+单位+名词」；**入口文案与二级页标题一致**；用「你」不用「您」；默认状态下少用「不要 / 不能 / 请勿」，避免绝对化表述；中文行高 1.5–2，老年人可以更大 | 已核实 |
| Semi 文案规范 https://semi.design/zh-CN/experience/content-guidelines（源码 github.com/DouyinFE/semi-design） | 品牌声音三条：**直接清晰 · 真实友好（像人一样说话）· 乐于助人**。书写原则：开门见山、保持一致（有统一词表）、与用户平起平坐（不说教，只在严重时道歉）、**避免夸大**（不用「最好、绝对、总是」）、包容（不只靠颜色指代）。按钮、Toast、标题不加句号；进行中的状态用「…」；时长写成「2 天 1 时 50 分」并按最大单位截断；列表不超过 6 项，句式平行 | 已核实 |
| Semi 设计原则 https://semi.design | 「坚守优质且稳定的默认基础（不变），并在需要时充分开放自定义的灵活度（多变）」 | 已核实 |
| Semi 无障碍 https://semi.design/zh-CN/experience/accessibility | 正文对比度 ≥ 4.5:1；不只用颜色传达信息；关闭弹窗后焦点回到触发按钮；照顾认知负担，内容分块 | 已核实 |
| 字节范 https://www.bytedance.com/zh/ | **坦诚清晰**（「准确、简洁、直接，少用抽象、模糊、空泛的词」）· **求真务实**（「不自嗨，注重实际效果」） | 已核实 |
| 飞书 / 抖音 / 番茄小说 / 今日头条 | 没有找到官方公开的设计原则。「降低思考成本」「沉浸式」「长辈模式（大字、大点击区、高对比）」都只见于第三方分析，如优设 https://www.uisdc.com/feishu-design-details | **未核实** |

### 1.2 给轻阅的 8 条原则（每条附一个轻阅里的例子）

| # | 原则（出处） | 轻阅里的例子 |
|---|---|---|
| 1 | **说用户的话，不说实现**（Arco 贴近现实；Semi 像人一样说话） | 自动翻页速度显示「很慢 / 慢 / 适中 / 快 / 很快」，不显示「15 秒/页」；听书的「引擎：在线模型 / 本地模型」改成「声音：在线 / 离线 / 系统」 |
| 2 | **一个概念只有一个名字，入口名等于页面名**（Arco 系统一致性、入口与标题一致；Semi 统一词表） | 「在线模型 / 在线语音 / 在线音色」统一为「在线语音」；打字机的「中」和自动翻页的「适中」统一为「适中」；底栏「听书」打开的面板标题也叫「听书」（现状已做到） |
| 3 | **状态一眼可见**（Arco 及时反馈） | 迷你胶囊显示「朗读中 · 本章还剩约 12 分钟」；定时开着时显示「23:40 停止」；自动翻页运行时，迷你条上显示当前档位名「适中」 |
| 4 | **用设计防错，不靠事后提示**（Arco 防止错误发生） | 用户自己滚走后，朗读继续但不再拉回视图；同一时间只能运行一种带读模式，开新的时自动停掉旧的并说一句；自动滚动从当前屏第一行开始，避免番茄那样漏读 |
| 5 | **能不提示就不提示**（Arco 人性化帮助的优先级） | 「快捷键：M 打开面板 · Shift+T …」这类常驻长句收进快捷键面板（`?`）；「多听几句会按你的语速自动校准」只在第一次出现 |
| 6 | **突出重点，面板可以扫读**（Arco 突出重点；Apple Books 主层 / Customize 两层） | 听书面板第一屏只放进度、走带、语速、定时；声音来源和音色放在下面或「更多」里；排版面板保持「文字 / 配色 / 版式 + 更多」 |
| 7 | **默认值稳，档位有名，档位之间可以微调**（Semi「不变 + 多变」；Arco 韵律） | 所有速度类和强度类控件都用同一个 `LevelSlider`：五档命名，默认在正中的「适中」，可以拖到两档之间，刻度可点 |
| 8 | **平视、诚实、不夸大**（Semi 避免夸大、平起平坐；字节范坦诚清晰） | 仿生阅读写「部分读者觉得更容易聚焦」，不承诺提速（现状已做到）；强度档位里不出现「最强」；报错写原因和办法，不写错误码，用「你」不用「您」（`zh.ts` 里「您」出现 0 次，已达标） |

补充一条横向要求，**包容 / 无障碍**（Semi）：不只靠颜色传达状态；朗读高亮在 5 种正文主题下都要达到可辨对比度；遵守 `prefers-reduced-motion`；图标按钮必须有文字标签或 `aria-label`。

## 2. 竞品对标

### 2.1 听书 / 朗读

| 产品 | 入口与起点 | 正文高亮与跟随 | 滚走后怎么回来 | 迷你播放器 / 锁屏 | 语速表示 | 音色 | 定时关闭 | 进度 / 剩余 |
|---|---|---|---|---|---|---|---|---|
| 微信读书 | 轻点正文后出现「听」按钮【教程】https://jingyan.baidu.com/article/fd8044fa164f0b1131137a86.html | 「被读到的部分自动高亮」（少数派搜索摘要，**未核实**），粒度未知 | 「原文」按钮定位到当前朗读处（**未核实**） | 有播放页 | 滑条（数值**未核实**） | AI 男声 / 女声等 | 有。从滑块选时长改成了弹窗选项，10.1.1 版「听书定时关闭体验优化」【官方】https://apps.apple.com/cn/app/id952059546 | 未核实 |
| 番茄免费小说 | 轻点后出现「听」【教程】https://jingyan.baidu.com/article/f25ef25486195c092c1b82d5.html | 小说听书没有字幕（https://www.woshipm.com/evaluating/5903816.html） | 播放页可折叠，边听边看别处（**未核实**） | 有 | 「选择倍数」，0.5–3×【弱】 | 多情感、多角色音色【官方】https://apps.apple.com/cn/app/id1468454200 | 有 | 未核实 |
| 起点读书 | 底栏「听书」【弱】 | 「**听读跟随**：开启后播放进度随文字阅读自动更新」【官方】 | 播放页「快捷跳转至最新文字阅读进度开始播放」【官方】https://apps.apple.com/cn/app/id534174796 | 通知栏 / 锁屏卡片【弱】 | 0.5–3× 滑块【弱】 | 标准 / 情感男女声【弱】 | 15 / 30 / 60 分钟、「当前章节结束」【弱，**未核实**】 | 未核实 |
| QQ 阅读 | — | 「**点击高亮原文，即可快捷暂停/开始播放**」【官方 8.3.81】 | — | 「小播放器支持贴边收起」【官方 8.5.51】https://apps.apple.com/cn/app/id487608658 | 未核实 | 「高品质音色」 | 未核实 | — |
| 掌阅 | — | 未核实 | — | — | 未核实 | 「20 种音色…方言音色」【官方】https://apps.apple.com/cn/app/id463150061 | 「定时停止和分集停止」（旧版）https://www.ifanr.com/app/386249 | — |
| Kindle App | `Aa → More → Assistive Reader`；**长按一个词 → Play**，从这里开始读【官方】https://www.amazon.com/gp/help/customer/display.html?nodeId=TqLHvK6eo6O7DJVQoZ | 实时高亮（`Real-time Text Highlighting`），粒度**未核实** | **打开导航或做标注时自动暂停** | 底部播放条，可「后退 30 秒」 | 未核实 | 用系统 TTS | 未核实 | — |
| Apple 朗读屏幕 / 朗读选中内容 | 双指下滑，或选中后点 `Speak` | 可选 Words / Sentences / Words and Sentences；样式可选下划线或背景色【官方】https://support.apple.com/guide/iphone/spoken-content-iph96b214f0/16.0/ios/16.0 | — | 悬浮控制器，可缩小 | 控制器上点按在 ½× / 1× / 1.5× / 2× 间循环（第三方教程） | 系统音色 | — | — |
| Apple 辅助阅读器 | 全屏阅读视图，可 `Autoplay` | 高亮可开关，可设样式和颜色 | 进度滑条可跳到指定时间 | 控件可隐藏 | 点 `Speaking Rate` **从列表里选一档** | — | — | 进度条【官方】https://support.apple.com/guide/iphone/read-listen-text-apps-accessibility-reader-iph406a46ab8/ios |
| Google Play 图书 | `Menu → Read aloud`，只支持流式文本 | 未核实 | — | — | **走系统设置**（反例） | 走系统设置 | 电子书朗读未核实 | — 【官方】https://support.google.com/googleplay/answer/11938821 |
| Speechify | **点任意词就从那里读**【官方】https://help.speechify.com/en/articles/5298980-listening-features | **词、句双层高亮**；`Auto Scroll` 开关【官方】https://help.speechify.com/en/articles/15146946 | 未核实 | Mac 迷你播放器；网页版 `Pill Player` | **倍速加 WPM**，0.5×（100）到 4.5×（900）；滑条加 `+/-`；可选「自动提速」https://help.speechify.com/en/articles/4943669 | 音色库分类、试听，**选中后立即切换** | 5–60 分钟；**顶部显示剩余时间，点一下取消**【官方】https://help.speechify.com/en/articles/9555697 | 有 |
| Voice Dream Reader | — | 高亮可选词 / 行 / 句；**专注模式下正在读的词和行始终在屏幕中间**（AFB 评测 https://afb.org/aw/14/8/15662；官网帮助页已 404） | — | — | 50–500 WPM | — | 有（细节**未核实**） | — |
| Readwise Reader | — | — | 滚离后，15 秒跳转按钮换成 **`return`（视图回到朗读处）和 `jump`（朗读跳到当前视图）**【官方】https://docs.readwise.io/reader/docs/faqs/text-to-speech | 播放条 | `,` / `.` 调速 | — | — | — |
| Audible（定时参照） | — | — | — | — | — | — | 预设时长加自定义；**到点前淡出**；结束提醒可「再延长同样时长」；摇一摇续时；支持**播完本章 / 本集**【官方】https://help.audible.com/s/article/use-timer?language=en_US | — |

### 2.2 自动翻页 / 自动滚动

| 产品 | 速度怎么表示 | 运行中的控件 | 暂停与退出 |
|---|---|---|---|
| 微信读书 | 状态胶囊「**自动阅读中·常速**」，用名字表示档位，点开是拖动滑块（https://news.qq.com/rain/a/20211206A06U7D00） | 胶囊点开即可调速 | 「关闭自动阅读」；「长按暂停、轻点快进、滑动干预」（**未核实**，知乎 403） |
| 掌阅 | 预设档位，依次选择（https://www.woshipm.com/pd/2017613.html） | 一条横线从上扫到下，扫完翻页，**能看出离翻页还有多久** | 退出键叫「停止」，评测指出有歧义 |
| 百度阅读 | 「从非常慢到非常快」连续可调 | 半透明小三角当计时器 | 退出引导醒目 |
| 华为阅读 | 「10 个档位」【官方】https://consumer.huawei.com/cn/support/content/zh-cn15383858/ | — | 轻触中间暂停；只支持上下滑动的书（限制写明了） |
| 番茄 | 未核实 | — | 反例：开始位置不是本页首行，会漏读（https://www.woshipm.com/evaluating/4421922.html） |
| 起点 | 未核实 | 自动阅读时可以点开段评，不用退出【官方】 | — |
| Kindle Word Runner | 100–900 WPM，遇到标点放慢；是否已下线**未核实**（Kindle 现在的 More 列表里已经没有它） | 滑动快退快进 | — |
| Kindle、Apple Books、Play 图书 | 都没有无声的自动滚动 | — | — |

### 2.3 翻页 / 滚动与设置面板的结构

| 产品 | 主层 | 二级 | 模式类功能放在哪 |
|---|---|---|---|
| Apple Books | `Themes & Settings`：大 A / 小 A、翻页方式 `Curl / Fast Fade / Scroll`、背景、亮度、主题 | `Customize`：字体、粗体；行距、字距、词距、边距要**再开一个总开关**才出现（被批藏得太深）https://support.apple.com/guide/iphone/read-books-iphc1af7c57/ios | 朗读走系统辅助功能 |
| Kindle | `Aa` 下四个页签：Font / Layout（含 `Continuous Scrolling`、页面颜色）/ Themes（预设，可**命名保存**）/ More | More：Assistive Reader、高亮、Reading Ruler、Word Wise https://www.amazon.com/gp/help/customer/display.html?nodeId=TABlJ4ot69emTO8jJG | 混在 `Aa` 的 More 里 |
| Google Play 图书 | `Display options`：Text / Lighting 两个页签 https://support.google.com/googleplay/answer/9755756 | — | Read aloud 在 Menu 里 |
| 微信读书 | 进度、自动阅读、背景、亮度、字号、边距行距、字体 | 横屏、深色、音量键翻页在「我 / 设置」里（位置深） | 自动阅读放在设置面板里（旧版在「…」里，被评为难找） |
| 番茄 | 字号、行距、背景（护眼 / 夜间 / 经典）、翻页（仿真 / 覆盖 / 滑动）【弱】 | 「我的 - 阅读设置」管全局 | — |
| 掌阅 | — | 翻页方式和自动翻页都在「设置第二页」 | — |
| Apple 辅助阅读器 | 先选主题，再点 Edit 改 | 行距、词距、字距**各只有 3 个图标档**，不用滑条 | — |

### 2.4 专注辅助与强度控制

| 产品 | 做法 | 强度怎么调 |
|---|---|---|
| Bionic Reading | 加粗词的前半部分 | 三个参数：`Fixation`（加粗多少，1–5 档）、`Saccade`（加粗点的间隔，10–50）、`Opacity`（明显程度）https://bionic-reading.com/br-method/。档位数值出自非官方 API 客户端，**未完全核实** |
| 微软沉浸式阅读器 | 行聚焦 | 1 / 3 / 5 行，图标切换 https://support.microsoft.com/en-gb/topic/use-line-focus-in-immersive-reader-for-office-for-the-web-and-onenote-815d5ae2-9291-4d57-b6d5-780280da27c7 |
| Apple Books Line Guide | 引导线，其余部分压暗 | 压暗程度可调；点上方或下方移动 |
| Kindle Reading Ruler | 阅读尺 | 颜色、透明度、样式、尺寸；Android 上要求同时开连续滚动（两个功能被绑在一起） |
| Speechify | 词、句双层高亮 | 可设光标颜色，可开关句高亮 |

### 2.5 值得照搬的做法

1. **点哪读哪**：Kindle 长按后点 Play，Speechify 点任意词，QQ 阅读点高亮句暂停 / 继续。
2. **当前句停在视线中部**（Voice Dream），只在它快离开视野时才滚动。
3. **滚走后给两个去处**：「回到朗读处」把视图带回朗读位置，「从这里听」把朗读带到当前视图（Readwise）。
4. **用名字表示状态和速度**：「自动阅读中·常速」（微信读书），速度用档位名，不显示数字。
5. **定时关闭**：用预设选项，不用滑块（微信读书改版的教训）；要有「本章结束」；显示剩余时间或停止时刻，点一下能取消；结束前淡出，可一键续时（Audible）。
6. **两层设置**：主层放最常用的 3–5 项，次要的放二级；**但不能藏到要先开总开关才出现**（Apple 的坑）。
7. **强度用少量档位**：1 / 3 / 5 行、5 档、3 个图标档，比连续数值好理解。
8. **迷你播放器可以收起或贴边**（QQ 阅读），面板收起后朗读继续（番茄）。
9. **能看出离自动翻页还有多久**（掌阅的扫描线、百度的小三角）。
10. **换了音色或语速立即生效**（Speechify）。

### 2.6 坑

1. 语速和音色要去系统设置里改（Play 图书），体验割裂。
2. 定时用滑块选时长，不好用（微信读书已经改掉）。
3. 自动阅读从页面中间开始，会漏读（番茄）。
4. 退出按钮只写「停止」，有歧义（掌阅）；应写成「退出自动翻页」。
5. 断句和加速时吞字（番茄、掌阅都专门发版修过），标点停顿要测。
6. 功能有使用限制却不说，静默失效（华为只支持上下滑；Play 图书只支持流式文本）。
7. 两个功能强制绑定（Kindle 的阅读尺必须配连续滚动）。
8. 自动阅读的入口藏在「…」或「更多」里，评测普遍认为不直观。

## 3. 轻阅现状与差距

以下根据 2026-10-07 工作区代码整理（含未提交的速度档位改动）。

| 方面 | 现状（代码位置） | 对标结论 | 差距 |
|---|---|---|---|
| 听书入口 | 顶栏或底栏「听书」打开面板；选中文字后弹「从这里听」；面板提示「将从本页开始朗读 · 选中文字可从任意位置开始」；有断点续听「上次听到 …」（`ReaderView.vue` 约 2721、2834 行） | 达到 Kindle / Speechify 水平 | 少了「点朗读句暂停 / 继续」（QQ 阅读） |
| **听书跟随位置** | `highlightListen()` 每句都调用 `renderer.scrollToAnchor(range)`。foliate 在滚动方式下执行 `#scrollTo(rect.top - margin)`（`paginator.js` 919 行），**当前句被贴到视口顶边**，每句跳一次，上文看不到；翻页方式下只在跨页时翻页，没有问题 | Voice Dream：始终居中；轻阅自己的歌词模式锚在 40% | **P0**：滚动方式需要一个「舒适区」 |
| **滚走与回来** | 只有翻页、跨章滑动、目录 / 搜索 / 标注跳转会设置 `listenDetached`（`interruptTTSForReposition`，738 行）。**滚动方式下用滚轮或手指自由滚动不算脱离**，下一句会把视图拽回顶部（看代码得出的结论，需实机确认）；脱离后面板里有「回到朗读位置」「从这页开始听」，和 Readwise 的 return / jump 对应得很好；胶囊上只有一个准星图标 | Readwise：滚走就换按钮，并配文字 | **P0**：自由滚动也应算脱离；胶囊上要有带文字的「回到朗读处」 |
| 迷你胶囊 | 面板收起后显示圆点、「朗读中 · 本章还剩约 N 分钟」、暂停、（脱离时）准星、停止；可拖动，双击复位 | 和 QQ 阅读、Speechify 相当 | 停止键紧挨暂停键，容易误触；提示「双击回到顶部」意思不清 |
| 锁屏与耳机 | `navigator.mediaSession`：上一段 / 下一段、快退快进按句 | 起点、Kindle 有通知栏卡片 | Android Tauri WebView 能否显示通知栏媒体卡片、熄屏后能否继续播放：**未核实**，需要真机验证 |
| 语速 | 滑条 0.5–2.0，步长 0.1，显示「1.0x」 | 业界通行倍速，上限 2–3×（Speechify 4.5×）；Apple 辅助阅读器是选档 | 没有命名档位，也没有「正常」锚点；用的是字母 x 而不是 ×；上限偏低（取决于引擎） |
| 定时 | 分段控件 `关 | 15 | 30 | 60 | 90 | 本章`；顶部徽标「23:40 停止」或「听完本章后停止」 | 起点、Audible 有「本章结束」；Speechify、Audible 能续时或取消 | **数字没有单位**；「本章」有歧义；到点直接停，没有淡出，也不能续时 |
| 声音来源 | 「引擎：在线模型 / 本地模型 / 系统」；提示语里又写「在线音色」「在线语音」「离线语音包」 | Speechify 叫 Voice Library，用户不需要知道「模型」 | 叫法不一致，「引擎 / 模型」是技术词 |
| 改设置何时生效 | 「改了语速或音色，当前这段读完后生效。」 | Speechify 立即切换 | P1：从当前句重新合成 |
| 朗读高亮色 | 写死 `#4f7cff` 叠加在 overlayer 上（1268 行） | Apple、Speechify 可设样式和颜色 | 违反项目「语义令牌」约定；夜间、米黄主题下的对比度未验证 |
| 自动翻页 / 滚动速度 | 正在改为 `LevelSlider` 五档：很慢 / 慢 / 适中 / 快 / 很快（30 / 20 / 15 / 10 / 6 秒），不显示秒数；迷你条显示档位名 | 与微信读书「常速」一致，方向正确 | 主按钮在暂停时显示「开始」还是「继续」要确认；看不出离翻页还有多久 |
| 打字机 / 歌词速度 | 滑条加数字输入「300 字/分」，预设「慢 200 · 中 300 · 快 450」；歌词另显示「≈ 3 秒/行」 | — | **和自动翻页的五档用词不一致**（中 / 适中）；秒数又出现了 |
| 仿生阅读强度 | 正在改为五档：柔和 / 标准 / 醒目 / 强烈 / 最强，默认在第 2 档（0.65），青色强调 | Bionic 5 档 | 「最强」是绝对化用词；五个词不成序列；默认不在中间，和速度滑条「默认 = 适中 = 正中」的规律不一致 |
| 排版面板 | 文字（字号带数字、行距 `1.6`、边距 `6%`）· 配色 · 版式；「更多」里的字距显示 `0.05em` | Apple 用大小 A，辅助阅读器只给 3 档 | `em` 是 CSS 单位，普通用户看不懂 |
| 排版和模式的关系 | 分工清楚（`reader-panels.md`）；场景可以跳到排版，排版可以「管理」场景 | 比 Kindle 把所有东西塞进 `Aa` 更清楚 | 用户在排版里找听书或自动翻页时没有去处（P2，一次性提示） |

## 4. 改进清单

### P0（下一版必须做）

**P0-1　听书跟随：当前句保持在视线上部 1/3 附近**
- 行为（只在滚动方式下）：
  - 当前句完全落在**舒适区**（视口高度 15%–70%）时不滚动。
  - 句子越出舒适区时，平滑滚动，让句首落在视口约 **35%** 处。这个位置和歌词的「偏上 0.4」同一水平，略高，以便多露出下文。
  - 一句比视口还长时，按句首对齐到 15%。
  - 开启「减少动态效果」时直接跳转，不做动画。
- 翻页方式不变，当前句跨页时才翻页。
- 实现提示：不再调用 `renderer.scrollToAnchor`，改为自己计算 `getClientRects()` 后调用 `renderer.scrollBy` 或 `#scrollTo` 的等价公开方法。歌词跟读时仍由歌词负责定位。

**P0-2　滚走 = 脱离跟随，且有带文字的回来入口**
- 行为：朗读中，用户用手指、滚轮、键盘或拖动滚动条自己滚动，就设置 `listenDetached`，后续句子只画高亮，不再滚动视图。
- 当朗读句被用户自己滚回视口内时，自动重新跟随。这一条不计时，避免「过几秒突然被拉走」。
- 胶囊在脱离时把准星图标换成**文字按钮**「回到朗读处」。工具栏可见时，同时在胶囊旁出现「从这里听」，即 Readwise 的 return / jump。
- 文案：
  - `tts.detached`：「你翻到了别处，朗读仍在继续」→ **「朗读还在继续，不在这一页」**（先说状态，再说位置）
  - `tts.backToListening`：「回到朗读位置」→ **「回到朗读处」**（更短，适合放进胶囊）
  - `tts.listenFromHere`：「从这页开始听」→ **「改听这一页」**（说清楚会替换当前进度）

**P0-3　定时关闭：选项带单位、说清楚、能续时**
- 选项：`不定时 | 15 分 | 30 分 | 1 小时 | 本章完`。把 90 分钟去掉，换成后面的「自定义」入口（P2）。手机一行最多放 5 个。
- 运行中：顶部徽标显示「**23:40 停止**」，点它取消。按章定时显示「**本章读完停止**」。
- 到点前 10 秒逐渐降低音量，停止后 Toast：「已按定时停止」，带操作按钮「**再听 15 分钟**」（Audible）。
- 文案：
  - `tts.sleep`：「定时」→ **「定时关闭」**（与微信读书、起点一致）
  - `tts.sleepOff`：「关」→ **「不定时」**
  - `tts.sleepChapter`：「本章」→ **「本章完」**
  - `tts.sleepAfterChapter`：「听完本章后停止」→ **「本章读完停止」**
  - `tts.sleepAtClock`：保持「{clock} 停止」
  - `tts.sleepDone`：「已按定时停止朗读」→ **「已按定时停止」**（Toast 不加句号）

**P0-4　所有「带读速度」统一用五档词表，不显示秒数**
- 自动翻页、自动滚动（进行中）、打字机、歌词（自动推进）一律用 `LevelSlider`，档位为 **很慢 / 慢 / 适中 / 快 / 很快**，默认在正中的「适中」。
- 打字机、歌词的「字/分」降为次要信息：滑条下方灰字写「约 300 字/分」，数字输入框收进「更多」。
- 删除歌词的「≈ 3 秒/行」。
- 预设芯片「慢 200 · 中 300 · 快 450」删除，档位刻度已经覆盖它们的作用。
- 迷你条的速度文案统一为「速度：适中」（`reader.speedLevel`）。

**P0-5　仿生阅读强度：五档成序列，默认在中间，青色，当场预览**
- 档位改为 **很淡 / 淡 / 适中 / 明显 / 很明显**，与速度档的构词方式一致（程度副词加形容词），默认为正中「适中」。
- 数值映射建议：0.5 / 0.58 / 0.65 / 0.8 / 1.0，这样旧默认值 0.65 正好落在「适中」。
- 标签：`readingMode.strength`「强度」→ **「明显程度」**。
- 滑条填充和刻度都用青色（`guideAccent`，浅色和深色主题各一套），只用于这个控件，不污染全局 `--brand`。
- 面板里放一行示例文本（「轻阅让读书这件事更轻一点。」加一句英文），拖动时实时变化，不用关面板回正文看效果。

### P1（紧随其后）

**P1-1　听书语速：保留倍速，加上档位**
- 「1.5 倍速」本身就是用户的说法（音频、视频 App 的通用语言），所以**不改成很慢 / 很快**。
- `LevelSlider` 档位：0.75× / **1.0× 正常** / 1.25× / 1.5× / 2.0×，可以拖到两档之间，步长 0.05。
- 显示「1.0×」，用乘号 × 而不是字母 x。
- 引擎实测能撑住的话，上限放到 3.0×（番茄、起点的口径；未核实），各引擎分别验证吞字情况（番茄的坑）。

**P1-2　声音来源用人话，名字统一**
- 「引擎」→ **「声音」**；选项「在线模型 / 本地模型 / 系统」→ **「在线 / 离线 / 系统」**。
- 全文统一用「在线语音 / 离线语音 / 系统语音」，「模型」只出现在下载包大小这类技术细节里。
- 在线音色也提供「试听」（目前只有离线有）。
- 改音色或语速后**从当前句开始立即生效**。删除 `tts.hintApply`；如果做不到立即生效，改为「下一句开始生效」。

**P1-3　点朗读句暂停 / 继续**（QQ 阅读）
- 朗读中，轻点高亮的那一句切换暂停 / 继续，点其他位置照旧呼出工具栏。
- 不在朗读中打开目录或划线时自动暂停：轻阅已经决定「听书时可以划线」，这一点保持不变，这是轻阅优于 Kindle 的地方。

**P1-4　朗读高亮随主题取色，可选样式**
- 取消写死的 `#4f7cff`，改为由 `READER_THEMES[theme]` 提供 `ttsMark` 颜色（白、米黄、护眼绿、夜间、墨水屏各一套，墨水屏用下划线）。
- 「更多」里提供「高亮样式：底色 / 下划线」（Apple）。
- 验收：5 个主题下，高亮区域内的文字对比度 ≥ 4.5:1。

**P1-5　排版数值换成用户语言**
- 字距：`0.05em` → 档位 **标准 / 稍宽 / 宽 / 很宽**（参照 Apple 辅助阅读器的 3 档思路）。
- 行距、边距：保留数字，旁边加档位名，例如「行距 1.6 · 适中」，或直接改为「紧凑 / 适中 / 宽松」三档加微调。
- 字号的数字保留，方便精确对齐，A− / A+ 不变。

**P1-6　自动翻页：能看出离翻页还有多久，按钮写清楚**
- 翻页方式下，页脚放一条 2px 细进度线，从左往右走满就翻页（掌阅扫描线的克制版）；开启「减少动态效果」时隐藏。
- 面板主按钮的三种状态：未运行时「开始」，运行中「暂停」，暂停后「**继续**」。退出按钮保持「退出自动翻页」或「退出自动滚动」（掌阅的教训）。

**P1-7　迷你胶囊防误触**
- 「停止」挪到最右，并和暂停键拉开 8px；停止后 Toast「已停止听书」带「继续听」操作，断点续听已经有数据，可以直接用。
- `tts.miniHint`：「点按展开听书面板，可拖动位置，双击回到顶部」→ **「点按展开听书面板；可拖动，双击放回原处」**

**P1-8　Android 锁屏、通知栏与熄屏播放的真机验证**
- 在 K70 和 K30 Pro 上验证：`mediaSession` 能否出现在通知栏；熄屏 10 分钟后是否仍在播放。不行就记为已知限制，评估加原生前台服务。

### P2（有余力再做）

- **P2-1　词级高亮**：在线语音带词边界事件时，在句高亮之上叠一层词高亮（Speechify、Apple）。默认关闭。
- **P2-2　自定义定时**：「自定义…」选项，输入分钟数。
- **P2-3　排版 → 模式的一次性指引**：用户在排版面板里停留超过 N 秒且没有改任何值时，只提示一次：「听书、自动翻页在『模式』里」。
- **P2-4　速度自适应建议**：连续两次点「快一档」，提示「要不要默认用『快』？」，只提示不自动改。`reading-modes.md` 里已有同样的设计，没有落地。
- **P2-5　命名保存排版方案**（Kindle Themes），优先级低，场景卡片已经覆盖大部分需求。
- **P2-6　「仿生阅读」英文名**：中文名已经定下来了；英文是「Word-start emphasis」，不对应中文着色的含义，建议改为 **「Word guide」**。在中国使用「仿生阅读」这个说法有没有商标风险：**未核实**。
- **P2-7　快捷键长句收起**：`readingMode.keysHint`、`lyricKeysHint` 从面板里移除，归入快捷键面板（`?`），面板底部只留一行「快捷键 ?」。

## 5. 文案对照（现文案 → 建议）

只列建议修改的条目。中文按 Arco / Semi 的规则处理：用「你」；按钮和 Toast 不加句号；数字和单位之间加空格（「15 分」「300 字/分」；倍速「1.0×」照惯例紧贴）。项目里已有「{n} 分钟」这类写法，和这条规则一致。

| key | 现在 | 建议 | 理由（原则编号） |
|---|---|---|---|
| `tts.engine` | 引擎 | 声音 | 1 |
| `tts.engineEdge` | 在线模型 | 在线 | 1、2 |
| `tts.engineLocal` | 本地模型 | 离线 | 1、2（和「离线语音包」一致） |
| `tts.engineLocalTitle` | 使用本机算力，无需联网；电脑较慢时可能卡顿 | 不用联网；电脑较慢时可能卡顿 | 1（「算力」是技术词） |
| `tts.hintEdge` | 在线音色更自然，需要联网；连不上时会自动改用系统语音。 | 在线语音更自然，需要联网；连不上时自动改用系统语音。 | 2 |
| `tts.localSlow` | 本机算力跟不上实时朗读，推荐改用在线模型 | 这台设备合成太慢，会断断续续，建议改用在线语音 | 1、2 |
| `tts.switchToOnline` | 改用在线模型 | 改用在线语音 | 2 |
| `tts.hintApply` | 改了语速或音色，当前这段读完后生效。 | （立即生效后删除）否则：下一句开始生效 | 3、5 |
| `tts.rate` 显示 | `1.0x` | `1.0×`，1.0 处标「正常」 | 1 |
| `tts.sleep` | 定时 | 定时关闭 | 2（与对标产品的叫法一致） |
| `tts.sleepOff` | 关 | 不定时 | 1 |
| 定时选项 | 15 / 30 / 60 / 90 | 15 分 / 30 分 / 1 小时 | 1（数字必须带单位） |
| `tts.sleepChapter` | 本章 | 本章完 | 1 |
| `tts.sleepAfterChapter` | 听完本章后停止 | 本章读完停止 | 精简 |
| `tts.sleepDone` | 已按定时停止朗读 | 已按定时停止（操作按钮：再听 15 分钟） | 4 |
| `tts.detached` | 你翻到了别处，朗读仍在继续 | 朗读还在继续，不在这一页 | 3（先说状态） |
| `tts.backToListening` | 回到朗读位置 | 回到朗读处 | 精简，适合放进胶囊 |
| `tts.listenFromHere` | 从这页开始听 | 改听这一页 | 4（说清楚会替换进度） |
| `tts.miniHint` | 点按展开听书面板，可拖动位置，双击回到顶部 | 点按展开听书面板；可拖动，双击放回原处 | 1（「回到顶部」有歧义） |
| `tts.etaLearning` | 按常见语速估算，多听几句会按你的语速自动校准 | 先按常见语速估算，听几句后会更准 | 5（只出现一次） |
| `readingMode.autoHint` | 读完一页自动翻到下一页，跟不上或嫌慢就换一档；轻点正文中间暂停 / 继续。 | 到时间自动翻页。太快或太慢就拖一下速度；轻点正文中间暂停 / 继续。 | 1、8（「嫌慢」偏口语，暗含评判） |
| `readingMode.autoScrollHint` | 正文缓缓上移，眼睛跟着读就好，跟不上或嫌慢就换一档；轻点正文暂停 / 继续，手指按住可以自己拖。 | 正文缓缓上移，跟着读就好。太快或太慢就拖一下速度；轻点暂停 / 继续，按住可以自己拖。 | 同上 |
| 自动翻页主按钮（已暂停时） | 开始 | 继续 | 3 |
| `readingMode.presetMedium` | 中 | （删除芯片；若保留则写「适中」） | 2 |
| `readingMode.secPerLine` | ≈ {n} 秒/行 | 删除 | 1 |
| `readingMode.strength` | 强度 | 明显程度 | 1 |
| `readingMode.intensitySoft` / `Normal` / `Clear` / `Strong` / `Max` | 柔和 / 标准 / 醒目 / 强烈 / 最强 | 很淡 / 淡 / 适中 / 明显 / 很明显 | 2、7、8（成序列；不说「最强」） |
| en 同上 | Soft / Standard / Clear / Strong / Max | Very light / Light / Medium / Strong / Very strong | 与速度档 Very slow…Very fast 同构 |
| `readingMode.modeWordGuide`（en） | Word-start emphasis | Word guide | 2（中文着色不是词首强调） |
| 字距显示 | 0.05em | 标准 / 稍宽 / 宽 / 很宽 | 1 |
| `readingMode.keysHint`、`lyricKeysHint` | 面板里常驻的长快捷键说明 | 移到快捷键面板，面板只留「快捷键 ?」 | 5、6 |
| `readingMode.guideExclusive` | 自动翻页、打字机、歌词、听书同一时间只运行一个。 | 一次只能开一种：开新的会自动停掉正在运行的那个。 | 4（说清楚后果） |
| `readingMode.wordGuideUnsupported` | 需要更新系统 WebView 才能使用。 | 系统浏览器组件版本太旧，更新系统后可用。 | 1（WebView 是技术词） |

保持不变（已经符合原则，作为正例）：「从这里听」「将从本页开始朗读」「上次听到」「继续听」「本章还剩约 12 分钟」「预计 23:40 听完」「退出自动翻页」「全书读完了」「这本书是固定版式（如漫画），暂不支持听书」，以及仿生阅读的说明「研究显示它不会让大多数人读得更快…」。

## 6. 验收要点（给实现者）

- 滚动方式下听书 5 分钟：当前句始终在视口 15%–70% 之间；滚动次数明显少于句数；上文至少保留 2 行。
- 朗读中用滚轮、手指各滚走一次：视图不被拉回；胶囊出现「回到朗读处」；把朗读句滚回视野后自动恢复跟随。
- 定时选「本章完」：读到章末停止，徽标显示正确，Toast 里的「再听 15 分钟」可用。
- 五种正文主题下，朗读高亮和仿生阅读青色的对比度都 ≥ 4.5:1。
- 打开「减少动态效果」：跟随滚动不播动画，没有进度细线。
- e2e 依赖的选择器语义不变（`CLAUDE.md`「边界」一节、`reader-panels.md` §5）。

## 7. 来源

- Arco Design：https://arco.design/docs/spec/introduce · https://arco.design/docs/spec/values-of-arcodesign · https://arco.design/docs/spec/philosophy · https://arco.design/docs/spec/style-guideline
- Semi Design：https://semi.design/zh-CN/experience/content-guidelines · https://semi.design/zh-CN/experience/accessibility · https://github.com/DouyinFE/semi-design
- 字节范：https://www.bytedance.com/zh/
- 微信读书：https://apps.apple.com/cn/app/id952059546 · https://jingyan.baidu.com/article/fd8044fa164f0b1131137a86.html · https://jingyan.baidu.com/article/0320e2c1c7ad045a87507b89.html · https://news.qq.com/rain/a/20211206A06U7D00 · https://tech.wmzhe.com/article/96533.html
- 番茄：https://apps.apple.com/cn/app/id1468454200 · https://jingyan.baidu.com/article/f25ef25486195c092c1b82d5.html · https://www.woshipm.com/evaluating/5903816.html · https://www.woshipm.com/evaluating/4421922.html
- 起点：https://apps.apple.com/cn/app/id534174796 · QQ 阅读：https://apps.apple.com/cn/app/id487608658 · 掌阅：https://apps.apple.com/cn/app/id463150061 · https://www.ifanr.com/app/386249 · 自动翻页对比：https://www.woshipm.com/pd/2017613.html · 华为阅读：https://consumer.huawei.com/cn/support/content/zh-cn15383858/
- Kindle：https://www.amazon.com/gp/help/customer/display.html?nodeId=TqLHvK6eo6O7DJVQoZ · https://www.amazon.com/gp/help/customer/display.html?nodeId=TABlJ4ot69emTO8jJG · https://www.amazon.com/gp/help/customer/display.html?nodeId=GLD8QTCF6CVEPT34 · Word Runner：https://blog.the-ebook-reader.com/2015/10/06/kindle-word-runner-review-and-video-demo/
- Apple：https://support.apple.com/guide/iphone/spoken-content-iph96b214f0/ios · https://support.apple.com/guide/iphone/read-listen-text-apps-accessibility-reader-iph406a46ab8/ios · https://support.apple.com/guide/iphone/read-books-iphc1af7c57/ios
- Google Play 图书：https://support.google.com/googleplay/answer/11938821 · https://support.google.com/googleplay/answer/9755756
- Speechify：https://help.speechify.com/en/articles/5298980-listening-features · https://help.speechify.com/en/articles/4943669 · https://help.speechify.com/en/articles/9555697 · https://help.speechify.com/en/articles/15146946 · https://help.speechify.com/en/articles/4942866
- Voice Dream：https://afb.org/aw/14/8/15662（官网帮助页 404） · Readwise Reader：https://docs.readwise.io/reader/docs/faqs/text-to-speech · Audible：https://help.audible.com/s/article/use-timer?language=en_US
- Bionic Reading：https://bionic-reading.com/br-method/ · 微软行聚焦：https://support.microsoft.com/en-gb/topic/use-line-focus-in-immersive-reader-for-office-for-the-web-and-onenote-815d5ae2-9291-4d57-b6d5-780280da27c7

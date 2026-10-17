# 阅读环境音（轻音乐 / 白噪音）调研（2026-10-05）

> 需求（TODO 2026-10-05）：阅读时可以放背景声，包括适合读书的轻音乐和白噪音，素材优先选无版权的（CC0 / 公有领域）。
> 范围：竞品、研究证据、可合法分发的素材来源与首批素材清单、Web Audio 实时合成方案，以及 LightRead 的落地建议。
> 方法：用 WebSearch/WebFetch 查官方页面和论文摘要；Freesound 条目逐页抓取，核对许可、时长、格式和体积；Internet Archive 用 metadata API 列出文件。标 **〔二手〕** 的来自评测站或媒体转述，没有在官方页面核实；标 **〔估算〕** 的没有实测。本次没有下载或试听任何素材，也没有改代码。
> 项目许可：LightRead 代码是 **AGPL-3.0**（仓库 `LICENSE`）。音频素材是独立作品，许可要逐个看，见第 3 节。

---

## 0. 结论速览

1. **主流电子书阅读器基本没有内置「阅读环境音混音器」。** 能做到多层混音、定时、和其他音频混合的，都是专注、助眠类应用，比如 Noisli、myNoise、A Soft Murmur、潮汐、Forest。iOS 系统级的「背景声音」可以和其他媒体同时播放，媒体播放时会自动压低背景声。这一点是 LightRead 做差异化的空间：环境音直接放在阅读器里，并且和自带的听书 TTS 联动。
2. **研究证据要点：** 有歌词的音乐和听得懂的人声对阅读理解伤害最大；快、响的音乐也会伤害理解；轻柔、慢速的纯音乐和平稳的噪声影响小，但大多不是正向。白噪声、粉噪声对 ADHD 人群有小幅帮助，对普通人有小幅负面作用；棕噪声目前**没有**同行评审的研究。所以产品上应该做到：默认关闭；曲库里不放有歌词的内容；默认音量低；「咖啡馆」里的人声要选听不懂的语言，并做低通处理；文案不写「提升专注力」这类功效承诺。
3. **素材许可：** 只用 **CC0 / 公有领域**，或者加上署名的 **CC BY**。**不用** Pixabay：它的许可禁止「以 Standalone 形式分发」，而开源仓库或 CDN 上放的原始音频文件就属于这种情况。也不用 BBC RemArc（仅限非商用）、YouTube Audio Library 的标准许可、任何 NC/ND 许可。Freesound 的 CC0 筛选结果量大，录音质量也够用，第 3.3 节给出了核实过的 10 条首批素材。钢琴曲选 Musopen 的肖邦全集（Internet Archive 标注 CC0）和 Wikimedia Commons 上 CC0 的萨蒂《裸体歌舞曲》第 1 号（Gymnopédie No.1）。
4. **推荐的落地方式（三层）：**
   - **(a) 本地实时合成，0 字节素材：** 白、粉、棕三种噪声，合成雨声，合成柔和铺底音（pad）。离线可用，首发就能上线。
   - **(b) 少量内置：** 可以不内置；如果要内置，只放 1–2 段 ≤600KB 的录音循环。
   - **(c) 按需从 R2 下载：** 8 段左右的录音环境音加 3 首钢琴曲，Opus 64–96kbps，总共约 15–18MB。下载后缓存在本地，离线也能用。
   - 环境音走单独的混音总线：朗读开始时自动降低约 12dB，暂停后恢复；接入现有的睡眠定时器，停止时淡出；默认音量 30%。
   - UI 是一个「环境音」底部面板：上面是场景预设卡片，下面可以展开逐层调音量的混音器。

---

## 1. 竞品调研

### 1.1 阅读类应用

| 应用 | 有没有阅读环境音 | 说明 |
|---|---|---|
| **微信读书** | 没有内置的阅读环境音混音器 | 「有声书」频道里有白噪音、颂钵、助眠类**音频专辑**，可以当普通音频播放（[人人都是产品经理](https://www.woshipm.com/it/4068559.html)）。听书支持定时关闭（[百度经验](https://jingyan.baidu.com/article/fd8044fa164f0b1131137a86.html)）。有声书播放页有「去除背景音」开关，用来去掉有声书自带的配乐（[优设](https://www.uisdc.com/hunter/0221567118.html)，页面 403，信息来自搜索摘要）。可见用户对「人声+配乐」的混合是有意见的。 |
| **番茄小说** | 没找到 | 官方听书指南只写了音色（2–3 种）、语速 0.5–3.0x、定时 15/30/60/90 分钟/自定义（[番茄小说 PC 指南](https://fanqiepc.ijinshan.com/pages/guides/audiobook/index.html)），没有提到背景音。 |
| **掌阅 / 多看** | 没找到公开资料 | 听书有多种音色（[3DM](https://shouyou.3dmgame.com/gl/71293.html)）。没有找到背景音或白噪音功能的说明，**没有在 App 里实测**。 |
| **Moon+ Reader（静读天下）** | 没找到 | 功能介绍里没有环境音（[MobileRead Wiki](https://wiki.mobileread.com/wiki/Moon%2B_Reader)）。 |
| **Legado（阅读 3.0，开源）** | 没找到 | 只有 TTS 朗读引擎的扩展。 |
| **Kindle** | 没有 | 有 Immersive Reading，即有声书和电子书同步（[Android Authority](https://www.androidauthority.com/kindle-app-immersive-reading-3643858/)），没有环境音。 |
| **Apple Books** | 没有，但 iOS 系统层面有 | iOS 15 起「辅助功能 → 背景声音」提供 Balanced/Bright/Dark Noise、Ocean、Rain、Stream、Night、Fire、Babble、Steam、Airplane、Boat、Bus、Train、Rain on Roof、Quiet Night 等声音。**「播放媒体时使用」开关加上单独的「媒体播放时音量」**：有其他媒体播放时，背景声默认变得很轻（[Apple 支持](https://support.apple.com/guide/iphone/play-background-sounds-iphb2cfa052c/ios)，[MacRumors](https://www.macrumors.com/how-to/ios-15-accessibility-background-sounds/)）。**这就是我们要做的「朗读时自动降低」的现成设计参照。** |
| **Booktrack**（2011–） | 有（另一种思路） | 给具体书目配同步的配乐和音效，按阅读速度推进（[Wikipedia](https://en.wikipedia.org/wiki/Booktrack)）。需要逐本书制作内容，不适合本地优先的通用阅读器，可以作为远期参考。 |

**结论：** 国内外主流阅读器都没有把环境音当作阅读体验的一部分，最接近的是 iOS 的系统级背景声音。所以这个方向有空间，但没有现成的成熟模式可以照搬，交互要我们自己设计。

### 1.2 专注 / 助眠类应用（声音类型、混音、定时、价格）

| 应用 | 声音类型 | 混音 | 定时 | 和其他音频的关系 | 价格 / 免费内容 |
|---|---|---|---|---|---|
| **Noisli** | 雨、雷、风、森林、咖啡馆、火、水、白/粉/棕噪等 | 多层叠加，每层单独音量；Pro 有 Oscillation（音量缓慢起伏）和 Shuffle | 免费版是简单定时，Pro 是高级定时 | 网页版内置文本编辑器 | 免费网页版 16 种声音，每天 1.5 小时；Pro 28 种，约 $10–12/月（[slonoise 对比](https://slonoise.com/resources/best-focus-sound-apps-2026/)，[getseam](https://getseam.app/blog/noisli-alternative)）〔二手〕 |
| **myNoise** | 几百个生成器：噪声、雨、咖啡馆、88 Keys 生成式钢琴等 | 每个生成器 10 个频段/声部滑块，「Animate」让滑块自动缓慢漂移 | 有 | — | 网页全部免费，靠捐赠（$5/月或一次性 $10–30）；有 iOS/Android 版（[mynoise.net](https://mynoise.net/)） |
| **A Soft Murmur** | 雨、雷、海浪、风、火、鸟、虫、咖啡馆、颂钵、白噪声，共 10 种 | 每层单独音量，可保存和分享混音 | 有 | 播放无缝 | 网页免费；App 里 4 种免费，另外 6 种一次性买断（[Book Riot](https://bookriot.com/ambient-sound-mixers/)，[App Store](https://apps.apple.com/us/app/a-soft-murmur/id1175522255)）〔二手〕 |
| **Rainy Mood** | 以雨为主，样本库有 400+ 雷声、虫鸣、雨打不同表面的声音 | 场景混音 | 睡眠定时 | — | App $2.99（[App Store](https://apps.apple.com/us/app/rainy-mood/id566752651)），网页免费 |
| **Forest** | 雨、咖啡馆、森林、草地等，可以叠在专注计时上 | 叠加 | 跟随专注计时 | — | 单个声音用专注攒的金币解锁；Plus 订阅解锁全部 Mindful Space 声景（[forestapp.cc](https://forestapp.cc/)） |
| **潮汐 Tide** | 海浪、雨、森林、冥想、咖啡厅 5 种免费；会员声音更多 | 早期单选，后来支持混音 | 番茄钟、心流计时 | — | 「声音卡」只解锁白噪音，Plus 会员额外解锁冥想等内容（[应用宝](https://sj.qq.com/appdetail/io.moreless.tide)，[小众软件](https://www.appinn.com/tide-pomodoro-technique-timer/)） |
| **小睡眠** | 30+ 种：海浪、溪流、雷雨、风、蛙、鸟、心跳等；还有脑波和疗愈曲 | 支持组合、一键创作，有「专注/放松/助眠」等随机模式 | 有 | — | 免费加会员（[App Store](https://apps.apple.com/us/app/%E5%B0%8F%E7%9D%A1%E7%9C%A0-%E5%8A%A9%E7%9C%A0-%E7%99%BD%E5%99%AA%E9%9F%B3-%E7%9D%A1%E7%9C%A0%E7%9B%91%E6%B5%8B-%E5%86%A5%E6%83%B3-%E6%AD%A3%E5%BF%B5-hrv%E5%8E%8B%E5%8A%9B-%E5%BF%83%E7%8E%87/id1194338569)） |
| **Endel** | AI 生成式声景，跟随时间、天气、心率变化 | 不能混音，按模式选（Focus/Relax/Sleep） | 有 | — | 约 $6.99/月或 $49.99/年，另有终身版（[slonoise 评测](https://slonoise.com/resources/endel-review/)）〔二手，各地区价格不同〕 |
| **Brain.fm** | 功能性音乐，宣称「neural phase locking」 | 不能混音，可以调节「强度」 | 有 | — | 没有永久免费档，只有 3–14 天试用；约 $6.99–14.99/月（[toolsbytask](https://toolsbytask.com/brain-fm/pricing)）〔二手〕。功效研究主要是自家做的小样本研究 |
| **Calm / Headspace** | 声景（雨、海、森林）、专注音乐、lo-fi | 基本不能混音 | 有 | — | 约 $69.99/年（[carepaths](https://carepaths.com/calm-app-vs-headspace/)）〔二手〕 |

**开源先例（和我们最相关）：**
- **Blanket**（GNOME，GPL-3.0，约 2.1k star）：14 种声音，Ogg Vorbis，合计约 **17.6MB**；许可是 CC0、CC BY、CC BY-SA 和「Public Domain」（来自 SoundBible）的混合，逐条列在 [SOUNDS_LICENSING.md](https://github.com/rafaelmardojai/blanket/blob/master/SOUNDS_LICENSING.md)。[CONTRIBUTING](https://github.com/rafaelmardojai/blanket/blob/master/CONTRIBUTING.md) 里规定了**响度规范**：理想值是 Integrated -27 LUFS，最大 -23；True Peak ≤ -6 dBTP。可以直接沿用。
- **Moodist**（MIT，84 种声音，PWA，有混音、睡眠定时淡出、预设、URL 分享、番茄钟）：素材来自 **Pixabay 许可 + CC0**，而且没有逐文件标出来源（[GitHub](https://github.com/remvze/moodist)）。我们不应该照这样做（原因见 3.1 节）。

**可以借鉴的交互模式：**
- 场景预设加多层混音器（Noisli、A Soft Murmur、Moodist）；
- 「Animate / Oscillation」：音量或频谱缓慢漂移，减少听觉疲劳（myNoise、Noisli）；
- 「媒体播放时使用另一个音量」（iOS）；
- 定时结束时淡出（Moodist）；
- 混音可以保存，也可以分享。

---

## 2. 研究证据：背景声对阅读和专注的影响

| 结论 | 证据 | 强度 |
|---|---|---|
| **听得懂的人声和有歌词的音乐对阅读干扰最大**；噪声、纯音乐也有**小而稳定**的负面影响 | Vasilev, Kirkby & Angele 2018，*Perspectives on Psychological Science* 13(5)：对 65 项研究做贝叶斯元分析（[论文 PDF](https://eprints.bournemouth.ac.uk/29995/9/1745691617747398.pdf)，[数据仓库](https://github.com/martin-vasilev/reading_sounds)） | **强**（元分析） |
| 背景音乐总体效应接近零，但**对阅读有干扰**，对记忆有小幅负面作用；总体为零是因为不同方向的效应互相抵消了 | Kämpfe, Sedlmeier & Renkewitz 2011，*Psychology of Music* 39(4)（[PDF](https://gwern.net/doc/psychology/music/distraction/2010-kampfe.pdf)） | **强**（元分析） |
| **又快又响**的纯音乐会伤害阅读理解，慢而轻的影响不显著 | Thompson, Schellenberg & Letnic 2012，*Psychology of Music* 40(6)，n=25（[ERIC](https://eric.ed.gov/?id=EJ982853)） | 中（单项小样本） |
| 有歌词的音乐，不管喜不喜欢，都比纯音乐更干扰阅读 | Perham & Currie 2014，*Applied Cognitive Psychology* 28(2)（[Wiley](https://onlinelibrary.wiley.com/doi/abs/10.1002/acp.2994)） | 中 |
| **歌词语言和正文语言相同时干扰最大**（中文歌配中文文本）；**平时习惯边听歌边学习的人受干扰小得多** | 2024 年 *Frontiers in Psychology*，90 名中国大学生（[PMC11027201](https://pmc.ncbi.nlm.nih.gov/articles/PMC11027201/)） | 中（和中文用户直接相关） |
| 白噪声、粉噪声对 **ADHD** 青少年有**小幅正面**作用（g≈0.25）；对**非 ADHD** 人群有**小幅负面**作用（g≈-0.21）；**没有找到任何棕噪声研究** | Nigg 等 2024，JAACAP，13 项随机研究的元分析（[摘要](https://www.jaacap.org/article/S0890-8567(24)00074-1/abstract)，[BPS 解读](https://www.bps.org.uk/research-digest/does-pink-noise-really-help-you-focus)）；另见 [PMC11585357](https://pmc.ncbi.nlm.nih.gov/articles/PMC11585357/)（临床 ADHD 中哪些人受益） | 中（小效应，样本有限） |
| 棕噪声「助专注」的说法目前只有个人经验支持 | [Cleveland Clinic](https://health.clevelandclinic.org/brown-noise)；ADDA 也承认证据不足（[add.org](https://add.org/brown-noise-adhd/)） | 证据缺失 |
| 中等环境噪声（约 70dB）对**创意任务**有帮助，85dB 有害 | Mehta, Zhu & Cheema 2012，*J. Consumer Research*（[JSTOR](https://www.jstor.org/stable/10.1086/665048)）。这里测的是创造性任务，**不能推到阅读理解上** | 中，适用范围有限 |
| 人能快速记住重复出现的随机噪声片段 | Agus, Thorpe & Pressnitzer 2010，*Neuron* 66:610（[PubMed](https://pubmed.ncbi.nlm.nih.gov/20510852/)）。工程含义：**短噪声循环会被听出来是重复的** | 强（基础研究） |

**对产品的含义：**
1. **曲库里一律不放有歌词的音乐**，「轻音乐」限定为慢速、柔和的纯器乐（钢琴、pad）。
2. **默认关闭，默认音量低**。安静的环境本来就是阅读理解的最好条件，不打扰不想听的人。
3. 环境音的主要实际价值是**用平稳的声音盖住不可预测的环境噪声**（比如旁边有人说话），另外是营造氛围和仪式感。这条是推理，没有找到直接针对阅读场景的实验证据。文案写「营造氛围 / 盖住嘈杂」，**不写「提升专注力、提高效率」**。
4. 「咖啡馆」场景要选**听不懂的语言**的人声底噪（比如丹麦语、捷克语），再做低通处理让人声听不清。另外要试听排查背景里有没有放版权音乐。
5. 个体差异大（ADHD、平时的听音习惯），所以要提供多种声音加混音器，让用户自己选。
6. 听觉安全：默认音量低，没有响度骤变（循环接缝淡入淡出，雷声单独做开关）。

---

## 3. 合法素材来源

### 3.1 来源与许可对照

判断标准有三条：① 能不能放进开源仓库或应用安装包里分发；② 能不能放在我们自己的 R2/CDN 上让应用下载；③ 和「任何人都可以再分发、包括商用」的 AGPL 仓库放在一起会不会出问题。

| 来源 | 许可 | 署名 | 打包进应用 / 放 R2 | 质量与格式 | 结论 |
|---|---|---|---|---|---|
| **Freesound**（CC0 筛选） | 由上传者逐条选择 CC0 / CC BY / CC BY-NC（[FAQ](https://freesound.org/help/faq/)） | CC0 不要求署名，CC BY 必须署名 | CC0、CC BY 可以；**NC 不行**（下游可以商用再分发，和 NC 冲突） | 很多 24bit/48–96kHz 的 WAV/FLAC 现场录音；下载原文件要登录 | **主力来源**。风险在于上传者不一定拥有全部权利，比如混进了别人的素材，或者咖啡馆背景里有音乐。要挑录音说明可信、亲自录制的条目，并逐条存档许可截图。 |
| **Pixabay**（音乐 / 音效） | Pixabay Content License，**不是 CC0**。禁止「以 Standalone 形式出售或分发」，Standalone 的定义是没有施加创造性加工、和网站上的形态基本相同（[terms](https://pixabay.com/service/terms/)，[license summary](https://pixabay.com/service/license-summary/)）。另外部分曲目注册了 Content ID（[FAQ](https://pixabay.com/service/faq/)） | 不要求 | **不建议**。开源仓库和 CDN 上的原始音频文件，任何人都能单独拿走，很接近 Standalone 分发；条款里也没有说应用内分发算不算 | 质量好 | **不用**（Moodist 用了，我们不跟） |
| **OpenGameArt**（CC0 标签） | 逐条标注；有 CC0 合集，比如 [CC0 Calm/Relaxing Music](https://opengameart.org/content/cc0-calm-relaxing-music) | CC0 不要求，作者通常希望署名 | 可以 | 多为 MP3、游戏配乐风格 | 备选。注意有的作品是用 GarageBand/Apple Loops 制作的（比如 TAD 的 [lofi Compilation](https://opengameart.org/content/lofi-compilation)），用 Apple Loops 做出的作品能不能整体按 CC0 再授权，有一些不确定性，**优先不用** |
| **Musopen** | 录音分 CC0、PD、CC BY-SA 几种（[Wikipedia](https://en.wikipedia.org/wiki/Musopen)）；[Internet Archive 上的 Complete Chopin Collection](https://archive.org/details/musopen-chopin) 标注的是 **CC0 1.0** | CC0 不要求 | 可以 | Ogg/MP3/ALAC，录音质量专业 | **钢琴曲首选**。使用前到 musopen.org 对应页面再核对一次单曲许可 |
| **Internet Archive**（其他内容） | 由上传者自己标注，可靠性参差不齐 | — | 只用来源可靠的条目，比如 Musopen 官方上传的 | — | 逐条核实 |
| **Free Music Archive** | 逐曲 CC 许可；FMA 自己不授权（[License Guide](https://freemusicarchive.org/License_Guide)） | CC BY 要署名 | CC0、CC BY 可以；NC/ND 不行 | MP3 | 备选，比如 [HoliznaCC0 *Background Music*](https://freemusicarchive.org/music/holiznacc0/background-music)（全部 CC0，作者声明「completely Public Domain」） |
| **Incompetech（Kevin MacLeod）** | CC BY 4.0；也可以付费买免署名许可 | **必须**写「Title Kevin MacLeod (incompetech.com) / Licensed under CC BY 4.0」，并放在容易找到的地方（[FAQ](https://incompetech.com/music/royalty-free/faq.html)） | 可以（带署名） | MP3，曲库大 | 可选。署名义务加上他的作品辨识度很高，**首批不用** |
| **Wikimedia Commons** | 逐文件标注（CC0 / PD / CC BY / CC BY-SA） | 看具体许可 | 可以（避开 NC，Commons 本来也不收 NC） | Ogg/FLAC，有转码版本 | 可以用，比如 [Gymnopédie No.1（CC0）](https://commons.wikimedia.org/wiki/File:Gymnopedie_No._1..ogg)。逐文件核实 |
| **BBC Sound Effects** | **RemArc 许可：只限个人、教育、研究用途**，商用要另外通过 Pro Sound Effects 购买（[Gearspace](https://gearspace.com/board/new-product-alert-2-older-threads/1212518-bbc-sound-effects-library-avail-non-commercial-use.html)，[Production Expert](https://www.production-expert.com/home-page/2018/4/23/free-sound-effects-download-16000-bbc-sound-effect-samples-from-bbc-archive)；官网 bbcrewind 这次没抓取成功） | — | **不行** | 质量极好 | **不用** |
| **NASA 音频** | 一般不受版权保护，但要标注来源，部分素材含有第三方版权内容（[NASA Audio](https://www.nasa.gov/audio-and-ringtones/)） | 要写 NASA | 可以 | 太空、火箭类，和阅读不搭 | 不相关 |
| **YouTube Audio Library** | 大多数是「YouTube 标准许可」，**只能用在 YouTube 视频里**；少数是 CC BY 4.0（[vidIQ](https://vidiq.com/blog/post/royalty-free-music-youtube-audio-library/)，[licenseorg](https://www.licenseorg.com/guide/music-audio/youtube-audio-library)） | — | 标准许可**不行** | — | **不用** |
| **SoundBible「Public Domain」** | 网站自己标注，来源可疑（Blanket 用过） | — | 有风险 | MP3/WAV | 不用 |
| **自己录、自己合成** | 我们自己定（建议 CC0） | — | 可以 | 看设备 | 合成噪声 / 雨 / pad 就属于这一类（第 4 节） |
| **用户导入自己的音频** | 用户自己负责 | — | 不分发，只存在本地 | — | **很适合本地优先**：「添加我的声音」，可以作为第二期功能 |

**合规做法：**
- 每个素材在 manifest 里写明 `source`、`author`、`license`、`licenseUrl`、`retrievedAt`、`sha256`。
- 应用里提供「声音来源与许可」页面。CC0 素材也写上作者，作为礼貌致谢。
- 原始下载文件和许可页截图存档到私有 R2，作为来源证明。
- 仓库里放 `public/ambient/CREDITS.md`，或者干脆不进仓库、只放 R2。
- CC BY-SA 素材可以作为独立文件分发，但会增加义务，首批不选。

### 3.2 首批素材清单（逐页核实过许可）

以下 Freesound 条目都在 2026-10-05 逐页抓取过，页面许可栏都是 **「Creative Commons 0」**。体积是原文件大小，最终会截取 45–90 秒，编码成 Opus。「循环」一列是页面上的说明，**没有试听验证**。

| # | 场景 | 素材（链接） | 作者 | 原文件 | 页面说明 / 是否循环 | 备注 |
|---|---|---|---|---|---|---|
| 1 | 小雨（默认雨） | [Soft Rain Loop](https://freesound.org/people/_lynks/sounds/595717/) | _lynks | Ogg，0:22.5，419KB，44.1k 立体声 | 「Distracting drips removed and **seamlessly looped**」 | 只有 22 秒，单独循环容易听出重复，要叠第 2 条或合成雨 |
| 2 | 绵长雨声铺底 | [Rain Slowly Passing TREATED LOOP](https://freesound.org/people/speakwithanimals/sounds/525046/) | speakwithanimals | WAV，13:52，228.5MB，48k 立体声 | 「**loop-able**…compression…volume level doesn't change too much」 | 截取 90 秒，做交叉淡化循环 |
| 3 | 窗边 / 屋内听雨 | [Rain Indoor Cabin (loop)](https://freesound.org/people/PhilllChabbb/sounds/232731/) | PhilllChabbb | WAV，0:16.3，4.1MB，44.1k 立体声 | 「Steady rain pouring on the cabin roof… **This clip loops on itself**」 | 太短，适合作为第二层 |
| 3b | （备选）林中木屋暴雨，无雷 | [Forest Rainstorm 02](https://freesound.org/people/rifualk/sounds/648475/) | rifualk | WAV，11:59，131.6MB，48k 立体声 | 「from the front window of a cabin… **No thunder**」 | 有阵风啸声，要挑平稳的一段 |
| 3c | （备选）屋顶天窗小雨 | [Soft rain on roof window](https://freesound.org/people/Metadex/sounds/235827/) | Metadex | WAV，3:16，53.8MB，48k 立体声 | 有鸟叫、远处的雷 | 雷声会有响度骤变，要剪掉 |
| 4 | 咖啡馆 | [People talking at cafe ambience](https://freesound.org/people/priesjensen/sounds/482990/) | priesjensen | WAV，2:17，34.7MB，44.1k 立体声 | 哥本哈根户外咖啡馆，丹麦语，下载量 2.2 万 | 中文用户听不懂丹麦语，正好合适；还是要做低通，并试听排查背景音乐 |
| 4b | （备选）咖啡馆 | [coffee shop ambience](https://freesound.org/people/waweee/sounds/370973/) | waweee | WAV，4:56，40.7MB，单声道 | 捷克连锁咖啡店 | 单声道 |
| 5 | 壁炉 | [fireplace](https://freesound.org/people/martats/sounds/138018/) | martats | WAV，2:50，28.7MB，44.1k 立体声 | 下载量 1.6 万 | 噼啪声的峰值要限幅到 ≤ -6 dBTP |
| 6 | 森林鸟鸣 | [sfx_amb_forest_spring_afternoon-01](https://freesound.org/people/bajko/sounds/385280/) | bajko | WAV，2:17，113MB，48k 立体声 | 「Heavy birdy forest ambiance」 | 鸟叫偏密，混音时调低 |
| 7 | 海浪 | [Waves at Baltic Sea shore](https://freesound.org/people/pulswelle/sounds/339517/) | pulswelle | WAV，26:04，394.8MB，44.1k 立体声 | 「Nice stereo panorama」，下载量 4.9 万 | 波罗的海的浪比较温和，适合阅读；截取 60–90 秒 |
| 8 | 溪流 | [Stream River Water Up Close](https://freesound.org/people/jackthemurray/sounds/433589/) | jackthemurray | WAV，1:08.9，18.9MB，48k 立体声 | 「Soft stream flowing water」，下载量 2 万 | — |
| 9 | 夏夜虫鸣 | [Night Crickets Back Porch](https://freesound.org/people/hdfreema/sounds/333221/) | hdfreema | AIFF，3:40，40.3MB，48k 立体声 | 「edited (trimmed only)」 | — |
| 10 | 轻钢琴 A | 肖邦《夜曲》Op.9 No.2 降 E 大调，[Musopen Complete Chopin Collection](https://archive.org/details/musopen-chopin) | Musopen | Ogg 2.7MB / MP3 5.4MB，4:36 | 整个合集是 CC0 1.0（`archive.org/metadata/musopen-chopin` 的 licenseurl） | 文件名 `Nocturne Op. 9 no. 2 in E flat major.ogg`；合集里还有 Op.15 No.1、Op.32 No.1、Op.55 No.2、Op.62 No.2 等 20 首夜曲，可以做「夜曲」歌单（不循环，顺序播放） |
| 11 | 轻钢琴 B | 萨蒂 [Gymnopédie No.1](https://commons.wikimedia.org/wiki/File:Gymnopedie_No._1..ogg) | 上传者 Teknopazzo（own work） | Ogg FLAC 6.2MB，3:25；有 Vorbis 76kbps 转码 | **CC0 1.0** | [直链](https://upload.wikimedia.org/wikipedia/commons/b/b7/Gymnopedie_No._1..ogg)。慢速、稀疏，最贴合「阅读轻音乐」 |
| 12 | 轻钢琴 C（备选） | [Drifting Piano](https://freemusicarchive.org/music/holiznacc0/background-music/drifting-piano/) | HoliznaCC0 | 1:50 | **CC0 1.0** | 短，可以和 A、B 一起轮播 |
| 13 | 氛围 pad（备选） | [Calm Ambient 2 (Synthwave 15k)](https://opengameart.org/content/calm-ambient-2-synthwave-15k) | cynicmusic | MP3 8.3MB | CC0（作者希望署名「The Cynic Project / cynicmusic.com」） | 也可以完全用第 4 节的生成式 pad 代替 |

**体积估算〔估算〕：** Opus 64kbps 约 8KB/s，96kbps 约 12KB/s。
- 环境音 8 段，每段 60–90 秒，64–96kbps 立体声：每段 0.5–1.1MB，合计约 **6–9MB**。
- 钢琴 3 首，96kbps：合计约 **7–9MB**。
- 加起来约 **15–18MB**，作为一次可选下载。Blanket 内置 14 段的总量是 17.6MB，可以作为参照。

**音频后期规范（沿用 Blanket）：**
- 每段统一到 Integrated **-27 LUFS**（±2），True Peak ≤ **-6 dBTP**；
- 剪掉人声、关门声、雷击这类突发事件；
- 用 2–4 秒等功率交叉淡化，把尾部叠到开头，在文件里做成无缝循环；
- 统一 48kHz（避免运行时重采样）。

---

## 4. 实时合成方案（零版权、零下载）

### 4.1 噪声

- **白噪声**：`Math.random()*2-1`。
- **粉噪声（-3dB/oct）**：
  - Paul Kellet 的 7 抽头 IIR 加权和，在 9.2Hz 以上和理想 1/f 的误差在 ±0.05dB 以内，计算量很小（[Csound pinkish](https://csound.com/docs/manual/pinkish.html)，[noisehack](https://noisehack.com/generate-noise-web-audio-api/)，[AudioWorklet 实现示例](https://whoisryosuke.com/blog/2025/generating-pink-noise-for-audio-worklets/)）；
  - 也可以用 Voss-McCartney：按八度分层，以 fs/2^i 的频率刷新随机值后求和（[dsprelated](https://www.dsprelated.com/showcode/216.php)）。
- **棕噪声（-6dB/oct）**：带泄漏的积分器 `out = (last + 0.02*white) / 1.02`，再乘约 3.5 补偿增益（[noisehack](https://noisehack.com/generate-noise-web-audio-api/)）。也可以用白噪声加低通近似，更省，但斜率不准。
- **调色**：再接 lowshelf/highshelf，提供「明亮 ↔ 温暖」一个滑块。加 0.03–0.1Hz 的慢速 LFO 调制截止频率和增益，做出类似 myNoise「Animate」的呼吸感，减少疲劳。
- **实现**：
  - 首选 **AudioWorklet** 实时生成：没有循环，内存几乎为零。
  - 回退方案是预先生成 ≥30–60 秒的 AudioBuffer，用 `loop=true` 播放。但 Agus 2010 的研究说明人能记住重复的噪声片段，所以**不要用几秒长的短噪声循环**。
  - 60 秒、48kHz 单声道的 Float32 buffer 约 11.5MB。
  - AudioWorklet 要求安全上下文。Tauri 的 `tauri.localhost` 和 `https` 站点都满足，但旧版 Android WebView 要用项目里的 `test:compat` 检查一下。

### 4.2 雨、风、海浪、壁炉

可以参考 Andy Farnell 的 *Designing Sound*（[MIT Press](https://mitpress.ublish.com/book/designing-sound)），以及 [Audiokinetic 的纯合成雨声](https://blog.audiokinetic.com/generating-rain-with-pure-synthesis/)。

- **雨**分三层：
  1. 远处的雨幕：粉噪声 → 带通（约 0.8–6kHz），LFO 缓慢调制上限截止频率，模拟雨势起伏；
  2. 近处的密集雨点：泊松分布触发的 1–5ms 高通噪声颗粒；
  3. 个别清晰的水滴：5–20ms 的正弦，频率指数上扬，对应 Minnaert 气泡共振，约 1–4kHz，随机触发并随机声像。
  - 「雨打窗」场景再加带通和轻微混响。
  - Farnell 的经验是，听感好坏主要取决于噪声的滤波。
- **风**：棕或粉噪声 → 带通，中心频率和 Q 值随机游走，增益也随机游走。
- **海浪**：棕或粉噪声 → 低通，叠加 8–14 秒随机周期的起落包络（起浪时截止频率上升）。
- **壁炉**：低频棕噪声的「呼呼」声，加稀疏随机的「噼啪」声（短促的脉冲经过带通滤波），再加偶尔的「爆裂」。

### 4.3 柔和铺底音（生成式 pad）

- 3–4 个略微失谐的 sine/triangle 振荡器 → 低通（800–2000Hz）→ 4–8 秒的慢起慢落包络；
- 和弦从五声音阶或大七、加九和弦里每 10–20 秒随机游走一次；
- 混响用程序生成的指数衰减噪声当 ConvolverNode 的冲激响应（IR 2–3 秒），不需要任何文件；
- 也可以做 Eno《Music for Airports》式的**互质周期循环**：几个音符各自按 17s、23s、29s 的周期重复，组合几乎不会重复。

### 4.4 质量取舍

| 维度 | 实时合成 | 录音循环 |
|---|---|---|
| 版权 / 体积 | 零 / 约 5–15KB 代码 | 要审核 / 每段约 0.5–1MB |
| 噪声类 | **和录音几乎没有区别**，而且永远不重复 | 有接缝，可能被听出重复 |
| 雨、风、海浪 | 「像」，细听偏电子，近处细节不够 | 真实、有空间感 |
| 咖啡馆、森林鸟鸣、虫鸣、钢琴 | **做不好**（人群、鸟叫、真实乐器都很难合成） | 必须用录音 |
| 可调性 | 强度、明暗可以连续调，也可以随时间变化 | 只能调音量和 EQ |

### 4.5 手机 CPU / 电量〔估算，未实测〕

- 一个 AudioWorklet 噪声源加几个 Biquad，在现代手机上每个声源大约占单核 CPU 的 1%以内。
- 播放解码好的 buffer 更省。
- 电量的大头是「音频输出链路一直开着，设备进不了深度休眠」，这和放任何音乐一样，跟用合成还是用录音关系不大。
- ConvolverNode 用长 IR 时开销中等，IR 控制在 3 秒以内，或者改用反馈延迟网络。
- 建议在 K30 Pro 上用 `adb shell dumpsys batterystats` 和 Chrome DevTools Performance，对比「只开 TTS」和「TTS + 3 层环境音」各跑 30 分钟。

---

## 5. LightRead 落地建议

### 5.1 分层交付

| 层 | 内容 | 体积 | 离线 | 时机 |
|---|---|---|---|---|
| **A. 本地合成**（P0） | 白 / 粉 / 棕噪声（带明暗调节）、合成雨、合成风、生成式 pad | 0 素材，约 10–20KB 代码 | 完全离线 | 首发 |
| **B. 内置**（可选） | 最多 1–2 段 ≤600KB 的核心循环（比如「雨打窗」） | ≤1.2MB | 完全离线 | 只有在合成雨效果不满意时才加 |
| **C. R2 按需下载**（P1） | 8 段录音环境音和 3 首 CC0 钢琴曲（3.2 节），manifest 加内容哈希 | 约 15–18MB，可以逐个下载 | 下载后离线可用 | 第二期 |
| **D. 用户导入**（P2） | 「添加我的声音」：本地 mp3/ogg/m4a，存进藏书存储层 | — | 离线 | 第三期 |

**R2 部署：**
- 路径例如 `ambient/v1/manifest.json` 和 `ambient/v1/<id>.<hash>.opus|.m4a`。
- 下载后缓存：网页版放 Cache Storage 或 IndexedDB，桌面和 Android 放 Tauri 应用数据目录。
- 素材不进 git 仓库，避免 AGPL 仓库里混入非代码资产，也减小安装包。
- **编码：** 主格式用 **Opus**（Ogg 或 WebM 封装），环境音 64–96kbps，钢琴 96kbps。另备一份 **AAC-LC .m4a**（96–128kbps）作为回退：Safari/WKWebView 直到 **iOS 18.4 / macOS 15.4** 才支持 Ogg Opus，而且据报道还有 bug（[frequal](https://frequal.com/java/OggOpusStillNotWorkingInSafari18_4.html)，[issue](https://github.com/bricedupuy/Songverse/issues/185)）。所以 macOS 桌面版旧系统要走 m4a；Linux WebKitGTK 不一定装了 AAC 解码插件，要走 Opus。运行时用 `canPlayType` 加一次试解码来选格式。

### 5.2 播放与循环

- **环境音层**：`fetch → decodeAudioData → AudioBufferSourceNode`。
  - 素材本身已经在文件里做成无缝循环，运行时**再加一层保险**：两个 source 在接缝处做 2–3 秒等功率交叉淡化。这样不依赖各浏览器对 MP3/AAC 编码延迟的处理。
  - 解码后的内存 = 时长 × 采样率 × 声道数 × 4B。60 秒、48k 立体声约 **23MB**，所以每层控制在 **45–60 秒**，同时最多 4–5 层。
  - 低端机可以把单声道素材读两遍、错开偏移量、分别放到左右声道，得到伪立体声，省一半内存。
- **防止听出重复**：
  - 各层循环长度取互质，比如 47s / 59s / 61s；
  - 随机点缀：每 20–90 秒随机放一次鸟叫或杯碟声，随机声像（第二期再做）；
  - 每层加很慢的音量漂移（±1.5dB，周期 30–90 秒）。
- **钢琴曲**：时长 3–5 分钟，解码成 buffer 太占内存，改用 `HTMLAudioElement` 流式播放，接 `MediaElementAudioSourceNode` 进入同一条总线；顺序或随机播放歌单，曲间淡入淡出。
- **启动**：AudioContext 只能在用户手势里创建或恢复，沿用 `readingModes/sound.ts` 的 `warm()` 做法。开始时淡入 3 秒，停止时淡出 1.5 秒。

### 5.3 和 TTS 混音（自动闪避）

现状：`listenPlayer.ts` 有自己的 AudioContext，每块音频单独接一个 gain 再连到 `destination`；系统 `speechSynthesis` 不经过 Web Audio。

建议：
- 新建 `services/ambient/engine.ts`，内部总线是 `layers → ambientBus(Gain) → [speech EQ] → master → destination`。
- **按会话闪避，不按句子闪避**：
  - 听书处于播放状态时，`ambientBus` 用 `setTargetAtTime` 降到 duckLevel，攻击约 0.3 秒；暂停或停止时 1.5 秒内恢复。
  - 默认 duckLevel 是 **-12dB（×0.25）**，设置里叫「朗读时环境音音量」，就像 iOS 的「媒体播放时音量」。
  - 按句子起落会产生「抽吸」感，所以不做。系统语音引擎也只能拿到状态，只能按会话闪避。
- **可选的语音频段让位**：朗读时在环境音总线上加一个 peaking EQ，2kHz 附近 -4~-6dB，Q≈1，让语音更清楚，又不用把环境音整体压得太低。
- **实现方式**：listenPlayer 暴露 `onStateChange(playing|paused|stopped)`（现在已经有会话状态），ambient engine 订阅这个事件。两边各用各的 AudioContext 也没关系，不需要合并。

### 5.4 定时与生命周期

- **复用现有的睡眠定时**（`ReaderView.vue` 里的 `sleepMode`：分钟数、本章结束、指定时钟）：
  - 听书定时触发时，环境音**一起淡出**，淡出 30–60 秒，比听书停止慢，更适合入睡。
  - 环境音也可以单独定时（15/30/60/90 分钟），在环境音面板里设置。
- **切到后台**：
  - 桌面继续播放。
  - Android 和 PWA：如果 TTS 正在播放，就跟着 TTS 的后台策略走；如果只有环境音在播，默认在 `visibilitychange → hidden` 时淡出暂停，回来后恢复。这和阅读计时、阅读模式的行为一致，也避免在 WebView 后台被系统杀掉时出现半截声音。**这一条是假设**，用户如果希望「锁屏继续放白噪音」，需要另做前台服务或 MediaSession，单独评估。
- 退出阅读器：淡出并停止，释放 buffer。可以加一个开关：在书架上保持播放。

### 5.5 设置项（`SettingsState` 增加字段，不需要迁移）

```ts
ambient: {
  scene: 'rain-study',            // 最近一次使用的预设或自定义 id
  layers: Record<string, number>, // 声音 id → 0..1 音量 (0 = 关)
  master: 0.3,                    // 默认 30%, 滑块按对数 / 感知曲线映射
  duckWithVoice: true,
  duckLevel: 0.25,                // -12 dB
  timerMin: 0,
  keepInLibrary: false,
}
```

- 默认**不自动播放**，`scene` 只是记住上次的选择。
- 不自动跟随书籍。「按书记住场景」放到第二期，作为可选功能。

### 5.6 UI 概念：「环境音」面板

- **入口**：阅读器工具栏加一个内联 SVG 图标（声波或耳机），`aria-label="环境音"`。播放中图标有轻微的动效或圆点，长按可以快速开关。手机上放在底部工具栏的「更多」里。
- **底部面板**，自上而下：
  1. **场景卡片**，横向滑动，每个场景是 2–3 层的预设：
     - 「雨夜书房」：小雨、壁炉
     - 「街角咖啡馆」：咖啡馆低通、钢琴（轻）
     - 「林间溪畔」：森林、溪流
     - 「海边」：海浪、风
     - 「夏夜」：虫鸣、远处细雨
     - 「专注噪音」：棕噪或粉噪，带明暗滑块
     - 「夜曲」：Gymnopédie 加肖邦夜曲歌单
     - 未下载的卡片显示大小，比如「1.2MB」，点一下下载，下载完自动播放。
  2. **主音量** 加 **定时** 分段控件（关 / 15 / 30 / 60 / 本章）。用全局 `.segmented`，不要改成 `role="radio"`。
  3. 开关：**「朗读时自动降低」**。
  4. 折叠区 **「自定义混音」**：每层一行，图标、名称、音量滑块、开关，可以「保存为我的场景」。
  5. 底部小字链接：「声音来源与许可」。
- **样式**：只用语义令牌，适配深色；触屏上不依赖 hover；所有文案走 `t()`，中英两份字典都加。
- **首次使用引导**：一句话即可，例如「环境音默认很轻；朗读时会自动压低」。

### 5.7 实施分期与工作量〔估算〕

| 期 | 内容 | 主要文件 |
|---|---|---|
| P0（约 2–3 天） | 合成引擎（噪声 3 种加明暗、雨、风、pad）、总线、闪避、定时联动、环境音面板、设置、i18n、node 单测（调度和闪避状态机用假时钟测） | `src/services/ambient/{engine,synth,scenes}.ts`、`src/components/AmbientSheet.vue`、`ReaderView.vue` 入口、`stores/settings.ts`、`i18n/*` |
| P1（约 2 天加素材后期 1 天） | R2 manifest、下载和缓存（三端）、录音层、钢琴歌单、许可页；用 ffmpeg 做后期流水线（`loudnorm=I=-27:TP=-6`、交叉淡化、opus/m4a 双编码）并写成脚本 | `scripts/ambient-build.mjs`、R2 `ambient/v1/*` |
| P2 | 用户导入音频、随机点缀、按书记住场景、混音分享 | — |

### 5.8 待用户确认的问题（先按推荐方案做）

1. 首发只上合成音（P0），录音包放到 P1？**推荐：是。** 先验证使用率，零版权风险。
2. 「轻音乐」限定为古典钢琴（肖邦、萨蒂）加生成式 pad，不做 lo-fi 电台？**推荐：是。** lo-fi 的 CC0 来源大多不稳定（Apple Loops、Pixabay）。
3. 只有环境音在播时，Android 切到后台是否继续播？**推荐：默认暂停。** 锁屏继续播放放进 P2 评估。
4. R2 用哪个域名？建议沿用江树的 R2 账号，新建一个公开桶或路径，例如 `assets.jiangshu.ai/lightread/ambient/v1/`。需要主会话或用户决定。

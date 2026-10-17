# 背景音：声音来源与许可

轻阅「背景音」里的声音来自两处：

1. **本机合成。** 雨夜书房、林间风声、专注噪音、夜曲铺底这四个场景由应用在你的设备上实时生成（白噪、粉噪、棕噪，雨，风，柔和的铺底音，远处的轻响），没有用到任何录音文件。合成代码在 `src/services/ambient/dsp.ts`，随轻阅一起以 AGPL-3.0 发布。它生成的声音本身不主张任何权利，可以当作 CC0 使用。
2. **录音包（按需下载）。** 窗边雨、咖啡馆、壁炉、林间鸟鸣、海边、夏夜虫鸣、钢琴夜曲这七个场景使用下面列出的录音。所有录音都是 **CC0 1.0（公有领域贡献）**，可以自由使用和再分发，不要求署名。这里仍写明作者，以示感谢。

我们只收 CC0、公有领域或 CC BY 许可的声音，不收 NC（禁止商用）、ND（禁止演绎）、Pixabay 许可和 BBC RemArc 许可的素材，原因见 `docs/research/reading-ambient-audio.md` §3。

## 录音清单

许可均在 2026-10-04 逐页重新核对过（Freesound 页面的许可栏、Wikimedia Commons 的文件信息、Internet Archive 的 `licenseurl` 元数据）。

| 场景 | 素材 | 作者 / 来源 | 许可 | 我们做了什么 |
|---|---|---|---|---|
| 窗边雨 | [Rain Slowly Passing TREATED LOOP_Edgewater_06192020](https://freesound.org/people/speakwithanimals/sounds/525046/) | speakwithanimals（Freesound） | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 截取 60 秒 |
| 咖啡馆 | [People talking at cafe ambience](https://freesound.org/people/priesjensen/sounds/482990/) | priesjensen（Freesound），哥本哈根户外咖啡馆 | CC0 1.0 | 截取 60 秒；1.3 kHz 双重低通（像隔着一面墙），交谈声只剩语调、听不清字句 |
| 壁炉 | [fireplace](https://freesound.org/people/martats/sounds/138018/) | martats（Freesound） | CC0 1.0 | 截取 60 秒；限制噼啪声的峰值 |
| 林间鸟鸣 | [sfx_amb_forest_spring_afternoon-01](https://freesound.org/people/bajko/sounds/385280/) | bajko（Freesound） | CC0 1.0 | 截取 60 秒 |
| 海边 | [Waves at Baltic Sea shore](https://freesound.org/people/pulswelle/sounds/339517/) | pulswelle（Freesound） | CC0 1.0 | 截取 60 秒 |
| 夏夜虫鸣 | [Night Crickets Back Porch](https://freesound.org/people/hdfreema/sounds/333221/) | hdfreema（Freesound） | CC0 1.0 | 截取 60 秒 |
| 钢琴夜曲 | 埃里克·萨蒂《裸体歌舞曲》第 1 号（[Gymnopédie No. 1](https://commons.wikimedia.org/wiki/File:Gymnopedie_No._1..ogg)） | Teknopazzo 演奏并上传（Wikimedia Commons，own work） | CC0 1.0 | 去掉首尾静音 |
| 钢琴夜曲 | 肖邦《夜曲》Op. 9 No. 2，降 E 大调（[Musopen — The Complete Chopin Collection](https://archive.org/details/musopen-chopin)） | Musopen（Internet Archive，由 Musopen 官方账号上传） | CC0 1.0 | 去掉首尾静音 |

作曲家萨蒂（1866–1925）和肖邦（1810–1849）的作品早已进入公有领域，上面两份**录音**也由演奏者或发布方以 CC0 放弃了权利。

## 后期处理

所有录音经过同一套处理，参照 GNOME Blanket 的响度规范：

- **选段：** 从原录音里自动挑出响度最平稳的一段，避开关门、雷声这类突发声音。
- **无缝循环：** 环境音把片段末尾 3 秒和开头做等功率交叉淡化，循环时不会出现接缝。播放时还会再做一次 2.5 秒交叉淡化作为保险。
- **响度：** 统一到 Integrated −27 LUFS，True Peak ≤ −6 dBTP。
- **编码：** Opus 80 kbps（`.ogg`），另备一份 AAC 96 kbps（`.m4a`），给不支持 Opus 的系统（旧版 Safari / macOS）使用。应用会自动选择其中一种下载。

| 素材 | 时长 | Opus | AAC | 响度 / 真峰值 |
|---|---|---|---|---|
| 窗边雨 | 60 秒（循环） | 537 KB | 737 KB | −27.0 LUFS / −7.3 dBTP |
| 咖啡馆 | 60 秒（循环） | 548 KB | 735 KB | −27.0 LUFS / −10.8 dBTP |
| 壁炉 | 60 秒（循环） | 707 KB | 743 KB | −27.1 LUFS / −9.6 dBTP |
| 林间鸟鸣 | 60 秒（循环） | 583 KB | 744 KB | −27.0 LUFS / −9.9 dBTP |
| 海边 | 60 秒（循环） | 508 KB | 741 KB | −27.1 LUFS / −7.0 dBTP |
| 夏夜虫鸣 | 60 秒（循环） | 570 KB | 741 KB | −27.0 LUFS / −15.9 dBTP |
| 萨蒂《裸体歌舞曲》第 1 号 | 3 分 24 秒 | 2.3 MB | 2.5 MB | −26.9 LUFS / −8.4 dBTP |
| 肖邦《夜曲》Op. 9 No. 2 | 4 分 32 秒 | 3.2 MB | 3.3 MB | −27.0 LUFS / −7.1 dBTP |
| **合计** | | **9.0 MB** | **10.3 MB** | |

## 托管与校验

- 录音不放进代码仓库，托管在 `https://lightread-assets.jiangshu.ai/ambient/v1/`，清单是同目录下的 `manifest.json`（格式见 `src/services/ambient/pack.ts`，应用内也内置了一份）。
- 文件名里带内容哈希的前 8 位，清单里记录完整 SHA-256，下载后会逐个校验。
- 下载后存在本机（浏览器的 Cache Storage，不可用时用 IndexedDB），之后离线也能播放。在背景音面板里可以随时删除。

## 想贡献声音？

欢迎推荐或提供新声音，要求如下：

- 许可是 CC0、公有领域或 CC BY，并附上能核实许可的页面链接；
- 不能有听得清内容的人声，也不能有可辨认的版权音乐（咖啡馆这类录音尤其要注意背景音乐）；
- 没有关门声、雷击这类突然的大声；
- 原始录音质量至少 44.1 kHz，立体声。

# 打字机模式的打字声：来源与许可

打字机模式的「打字声」有四种音色。每种音色是从一段 CC0 录音里切出的 6 条单发击键声（播放时轮换，不会连着两次同一条，并带 ±3% 音高、±2 dB 音量的随机变化），打字机和机械键盘另有一条段落末的点缀声。素材随应用一起发布，放在 `public/sounds/typewriter/<音色>/`，清单是同目录的 `manifest.json`（含每条的切点和测量数据），26 条声音 × 两种格式共 52 个文件，合计约 95 KB（播放时只加载所选音色、一种格式的 7 个文件，约 8–19 KB）。录音解不了时（例如很旧的 WebView），应用会改用本机合成的击键声（`src/services/readingModes/soundPresets.ts` 的 `synthHit`）。

许可在 2026-10-04 逐页核对过（Freesound 页面的许可栏均为 Creative Commons 0）。

| 音色 | 素材 | 作者 / 来源 | 许可 | 用了什么 |
|---|---|---|---|---|
| 老式打字机 | [Typewriter snippet 01 mono [loop]](https://freesound.org/people/cabled_mess/sounds/360603/) | cabled_mess（Freesound），便携式机械打字机，Clippy EM172 话筒 + Zoom H5 | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 6 条击键，各 90 ms |
| 老式打字机（段落末） | [Typewriter bell & carriage reset](https://freesound.org/people/knufds/sounds/345955/) | knufds（Freesound），古董打字机的边距铃与回车 | CC0 1.0 | 只取回车滑架停住的那一下（340 ms，没有铃声），比击键低 4 dB |
| 机械键盘 | [Keyboard typing sounds: Unidentified Technics keyboard](https://freesound.org/people/zrrion/sounds/665075/) | zrrion（Freesound），Gateron 黄轴（线性），轴心用蜡和 Krytox 205g0 润过 | CC0 1.0 | 6 条击键，各 70 ms；段落末用同一段录音里的一下空格键（120 ms，比击键低 2 dB） |
| 轻柔触键 | [Laptop Keyboard](https://freesound.org/people/bassboybg/sounds/346589/) | bassboybg（Freesound），笔记本键盘慢速打字 | CC0 1.0 | 6 条击键，各 60 ms |
| 钢笔书写 | [Fountainpen_Write_1_Texture](https://freesound.org/people/hanasmusic/sounds/841413/) | hanasmusic（Freesound），钢笔在笔记本纸上书写，AKG C414 XLII 话筒 | CC0 1.0 | 6 段笔划，各 100 ms |

处理方法：

- **选段：** 自动找出前后都没有别的按键声、起音干净的击键（钢笔是找最平稳、没有「咔」声的一段笔划），再看波形和频谱图人工剔除带回弹声或串音的。
- **修整：** 起音前留 5 ms 并淡入，末尾 5 ms 淡出（钢笔 8 ms 淡入、20 ms 淡出），余音按指数收短，避免和下一声叠在一起。按音色做了轻度均衡，把刺耳的高频压低：打字机 8 kHz 低通、4 kHz 以上 −4 dB，并在 260 Hz 补一点机身共鸣；机械键盘 7 kHz 低通、3.5 kHz 以上 −3 dB；轻柔触键 5.5 kHz 低通；钢笔 500 Hz–7 kHz，4 kHz 以上 −3 dB。
- **响度：** 每一条的 K 加权能量（120 ms 窗口）都对齐到同一值，四种音色听起来一样响；峰值不超过 −6 dBFS。应用里的默认音量是 40%。
- **编码：** Opus 64 kbps（`.ogg`），另备一份 AAC 96 kbps（`.m4a`），给不支持 Opus 的系统用。

| 音色 | 单条时长 | 频谱重心 | −40 dB 衰减 | 峰值 | Opus 合计 | AAC 合计 |
|---|---|---|---|---|---|---|
| 老式打字机 | 90 ms | 2.9–3.5 kHz | 51–57 ms | −10.1 ~ −7.2 dBFS | 10.8 KB | 19.2 KB |
| 机械键盘（默认） | 70 ms | 1.0–1.5 kHz | 28–41 ms | −9.7 ~ −6.0 dBFS | 8.0 KB | 15.3 KB |
| 轻柔触键 | 60 ms | 1.2–1.3 kHz | 37–43 ms | −11.4 ~ −6.6 dBFS | 7.6 KB | 11.2 KB |
| 钢笔书写 | 100 ms | 1.1–1.7 kHz | 90–96 ms | −17.1 ~ −15.0 dBFS | 9.7 KB | 14.8 KB |

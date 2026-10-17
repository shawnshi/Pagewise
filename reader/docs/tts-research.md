# 听书 TTS 方案调研（2026-10-04）

> 范围：给「听书」找更好的**本地离线、中文友好**的语音合成方案，并与在线方案对比。
> 现状：Edge 在线神经语音（`src-tauri/src/edge_tts.rs`）+ 系统 speechSynthesis + 桌面离线 sherpa-onnx 1.13.3 + Kokoro multi-lang v1.1（`src-tauri/src/local_tts.rs`，约 310–347MB，103 个音色，Android/iOS 编译为 stub）。
> 说明：数据来自官方仓库、模型卡、sherpa-onnx 发布页和 `gh` 查询。标 **〔未核实〕** 的是二手资料或社区数字，没有在本机验证。本次没有下载模型，也没有实测。
> **2026-10-05 补充**：第 7–9 节增加「本地优化部署版本」「长文本听书的分块建议」「推荐矩阵与评测协议」。最终推荐以第 9 节为准；第 1 节保留首轮结论，其中 OmniVoice 已因权重许可改为 NC 而移出候选。

---

## 1. 结论与推荐

1. **桌面主力继续用 sherpa-onnx + Kokoro v1.1-zh，暂不换。** 在「中文质量 / 体积 / CPU 实时 / 许可 / 现成 Rust 运行时」这几项上，目前没有哪个方案能全面超过它。Kokoro 是 Apache-2.0 许可，有 100 个中文音色（55 女 45 男）。sherpa-onnx 直接支持 Kokoro，不用另写推理代码。2025–2026 年中文质量明显更好的模型（CosyVoice 3、IndexTTS-2.5、VoxCPM2、Qwen3-TTS、Fish S2、OmniVoice）都在 0.5B–4B 参数量级，普通笔记本 CPU 上大多跑不到实时，有几个许可还不能商用。
2. **先做几项低成本改进，收益最大：**
   - **补上 `rule_fsts`。** sherpa-onnx 官方 APK 配置给 Kokoro multi-lang 传了 `phone-zh.fst,date-zh.fst,number-zh.fst`（[generate-tts-apk-script.py](https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/apk/generate-tts-apk-script.py) 第 585 行），用来朗读数字、日期和电话号码。LightRead 的 `build_engine()` 没有设置这一项。改动只有一行，书里年份、数字的读法会明显改善。要先确认 v1_1 压缩包里有这三个文件。
   - **升级到 sherpa-onnx 1.13.8**（2026-09-11）。新版带 onnxruntime 1.28.2，Rust 支持 Windows arm64，校验 Kokoro 的 voices 文件，并修复了异步 TTS 回调的 use-after-free（[CHANGELOG](https://github.com/k2-fsa/sherpa-onnx/blob/master/CHANGELOG.md)）。
   - **提供 int8 精简包作为可选项。** `kokoro-int8-multi-lang-v1_1` 是 140MB（fp32 版 347MB），适合低配 Windows（GitHub #8）和以后的手机端。但有报告说 int8 Kokoro 会有高频音调伪影，在部分 CPU 上反而比 fp32 慢（[YAAH #298](https://github.com/elboaf/YAAH/issues/298)），所以先 A/B 试听，不要直接换掉默认包。
3. **Android 离线听书现在可以做了，这是本次最重要的发现。** sherpa-onnx 1.13.5 给 `sherpa-onnx-sys` 加了 Android 共享链接（#3739）。1.13.7 发布了官方 Tauri 示例，Linux/macOS/Windows/**Android arm64 APK**/iOS 都能跑（[tauri release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tauri)，[示例源码](https://github.com/k2-fsa/sherpa-onnx/tree/master/tauri-examples/hello_world)）：`build.rs` 自动下载 `.so` 放进 `jniLibs`，`cargo tauri android build --target aarch64` 就能出包。`local_tts.rs` 里写的「sherpa-onnx 无移动端预编译库」已经过时。建议在 K70 / K30 Pro 上先做 PoC，依次测 Kokoro int8 → Piper zh_CN（13MB int8）→ Matcha zh-en。
4. **第二梯队（桌面实验，「高品质 / 克隆」可选包）：**
   - **MOSS-TTS-Nano**（OpenMOSS，2026-04）：参数约 0.1B，Apache-2.0，支持中文在内 20 种语言。有官方 ONNX CPU 版，支持流式，4 核 CPU 能实时（官方说法），自带音色并支持克隆，还有官方 Android ORT 示例和「Reader」浏览器插件。它是目前最像「下一代 Kokoro」的候选。缺点是不在 sherpa-onnx 里，要用 Rust `ort` crate 自己写自回归推理和音频 tokenizer 解码，工作量中等。
   - **Qwen3-TTS-0.6B**（Apache-2.0）：中文质量好，有 9 个预置音色（中文 5 个，含京味、川味），支持克隆。CPU 上 int4 量化后 RTF 约 0.5（M1），GGUF 方案 RTF 约 1.3〔未核实〕。只适合高配机器，暂缓。
   - ~~OmniVoice~~（k2-fsa 自家，0.6B）：**2026-10-05 更正：权重已于 2026-07-03 改为 CC-BY-NC**（[模型卡 License 节](https://huggingface.co/k2-fsa/OmniVoice#license)，原因是 Emilia 训练数据），不能随应用分发，已移出候选。
5. **不建议采用：** F5-TTS、MaskGCT、Spark-TTS、OmniVoice 的权重是 NC（非商用）许可；Fish S2 是研究许可，模型 4.4B；ChatTTS 是 AGPL 加 NC。Kyutai TTS、Pocket TTS、KittenTTS、Supertonic 3、Dia、VibeVoice-Realtime 都**不支持中文**。CosyVoice 3、IndexTTS-2.5、VoxCPM2、MOSS-TTS 大模型、Step-Audio-EditX 需要 GPU，不适合阅读器内置。
6. **在线：** Edge 继续作为默认在线引擎，免费，中文音色多。可以考虑加一个「自带 API Key」的云引擎（豆包 Seed-TTS 2.0 / MiniMax Speech 2.8 / 阿里百炼 CosyVoice、Qwen-TTS），给想要顶级音质的用户用，作为 Edge 接口失效时的备选。

---

## 2. 对比表（本地 / 离线候选）

| 方案 | 中文质量 | 中文音色 | 体积 | CPU 速度 | 手机 arm64 | 流式 | 许可 | 运行时 | 克隆 |
|---|---|---|---|---|---|---|---|---|---|
| **Kokoro v1.1-zh**（现用） | 中上，自然；多音字靠词典+jieba，偶有误读；可中英混读 | 100（55F/45M）+3 英文 | 347MB / int8 140MB | 桌面远快于实时〔未在本机测〕；Pi4 上 v1.0 4 线程 RTF 3.2 | 可行（sherpa 有 Android TTS Engine APK）；高端机约实时〔未核实〕 | 句级（回调） | Apache-2.0 | **sherpa-onnx ✅** | 否 |
| **Piper zh_CN chaowen / xiao_ya**（2026-04 新增） | 中等，VITS 偏机械；拼音 + G2PW 词典，多音字处理有改进 | 2（男/女）+ huayan | int8 13MB / fp16 27MB / 57MB | 极快 | **很适合** | 句级 | 来自 rhasspy piper-voices，单个音色的许可需核实〔未核实〕 | sherpa-onnx ✅ | 否 |
| **Matcha zh-en / zh-baker** | 中等，单人；zh-en 只有 16kHz | 1 | 72MB + vocoder 51MB | Pi4 4 线程 RTF 0.39 | 很适合 | 句级 | baker **非商用**；zh-en 数据来源未核实 | sherpa-onnx ✅ | 否 |
| MeloTTS zh_en（vits-melo） | 中等 | 1 | 159MB | 快 | 可行 | 句级 | MIT | sherpa-onnx ✅ | 否 |
| **ZipVoice distill zh-en** | 好（零样本） | 只能克隆（需参考音频+逐字文本） | int8 104MB / fp32 455MB | 多步 flow matching，比 Kokoro 慢〔未核实〕 | 勉强 | 否 | 代码 Apache；Emilia 数据，权重许可需核实 | sherpa-onnx ✅ | 是 |
| **MOSS-TTS-Nano** | 好（官方说法）〔未实测〕 | 内置若干 + 克隆 | 0.1B；ONNX 仓库 641MB + tokenizer 86MB（可能含多种精度） | 4 核流式实时；M4 单核流畅（官方） | 有官方 Android ORT 示例 | **是** | Apache-2.0 | ONNX Runtime（不在 sherpa 里） | 是 |
| Qwen3-TTS 0.6B | 很好，有方言音色 | 9 预置（中文 5）+ 克隆 | 约 2.4GB（bf16） | M1 int4 RTF 0.52；GGUF CPU 约 1.3〔未核实〕 | 否 | 是（GPU 首包 97ms） | Apache-2.0 | PyTorch / GGUF / 纯 C 移植 | 是 |
| OmniVoice | 很好（主打克隆） | 克隆 / 音色设计 | 0.6B，3.1GB | GPU RTF 0.025；社区 ONNX CPU 约 0.5–0.6〔未核实〕 | 否 | 否（NAR 32 步） | 代码 Apache；**权重 CC-BY-NC（2026-07-03 起）** | PyTorch / omnivoice.cpp / audio.cpp；sherpa 接入中（#3651） | 是 |
| Fun-CosyVoice3 0.5B | 顶级，18+ 方言 | 克隆 + 指令 | 仓库 9.3GB | CPU 远低于实时 | 否 | 是（GPU 150ms） | Apache-2.0 | PyTorch / TensorRT | 是 |
| IndexTTS-2.5（2026-08） | 顶级；能用拼音纠正多音字 | 克隆 + 情感 | 5.2GB | 需 GPU（约 6GB 显存） | 否 | 否 | bilibili 模型协议（可商用，MAU 超 1 亿需另行授权） | PyTorch | 是 |
| VoxCPM2 | 顶级，9 种方言 | 克隆 / 设计 | 2B，4.7GB | GPU RTF 0.3（8GB） | 否 | 是 | Apache-2.0 | PyTorch / GGUF | 是 |
| Fish Audio S2-Pro | 顶级 | 克隆 | 4.4B | GPU | 否 | 是 | Fish Research License（**非商用**） | SGLang | 是 |
| F5-TTS / MaskGCT / Spark-TTS | 好 | 克隆 | 0.3–1B | GPU 为主（F5 有 ONNX 版） | 否 | 否 | 权重 **CC-BY-NC(-SA)** | PyTorch | 是 |
| MegaTTS3 | 好（中英） | 克隆受限（WaveVAE 编码器未公开） | 0.45B | GPU | 否 | 否 | Apache-2.0 | PyTorch | 受限 |
| Chatterbox Multilingual | 支持中文，质量〔未核实〕 | 克隆 | 约 0.5B | CPU 偏慢 | 否 | 否 | MIT（带水印） | 社区 ONNX 版 | 是 |
| 不支持中文 | Kyutai TTS 1.6B（英/法）、Pocket TTS（欧洲语言）、KittenTTS（英）、Supertonic 3（31 种语言不含中文，已归档，OpenRAIL-M）、Dia（英）、VibeVoice-Realtime（无中文）、Inflect（英） | | | | | | | | |

### 在线 / 云端（对比用）

| 方案 | 中文 | 价格 | 备注 |
|---|---|---|---|
| Edge 在线（现用） | 很好；`src/` 里列了 10 个中文 Neural 音色，含方言 / 港台 | 免费 | 非官方接口（Sec-MS-GEC 签名），随时可能失效或限流 |
| 豆包 Seed-TTS 2.0（火山引擎） | 顶级，有情感、克隆 | 约 5 元 / 万字符〔未核实〕 | 国内首选商用 API |
| MiniMax Speech 2.8 | 顶级 | HD 约 3.5 元、Turbo 约 2 元 / 万字符（阿里云渠道）〔未核实〕 | 也有海外端点 |
| 阿里百炼 CosyVoice / Qwen-TTS API | 很好，有方言 | 按量计费 | 同系模型有开源版 |
| Azure Speech | 和 Edge 同一批声音 | 付费，有官方 SLA | Edge 的正规替代 |

---

## 3. 各方案要点

- **Kokoro v1.1-zh**（[HF](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)）：82M 参数，StyleTTS2 架构，2025-02 发布，之后官方没有出新的中文版本（hexgrad 仓库最后推送 2025-08）。中文音色来自龙猫数据的 100 人专业数据集。已知问题：ONNX 版个别词（如「质量」）发音和 PyTorch 版不一致（[kokoro-onnx #101](https://github.com/thewh1teagle/kokoro-onnx/issues/101)，未解决）。多音字靠 sherpa 的 `lexicon-zh.txt` 加 jieba 词典处理，没有上下文模型。sherpa 文档：[kokoro-multi-lang-v1_1](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)。
- **sherpa-onnx 当前的 TTS 家族**（[tts-models 发布页](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)，共 644 个文件）：VITS（Piper / MMS / icefall / MeloTTS / 各种 zh-hf 角色音）、Matcha、Kokoro（en v0.19、multi-lang v1.0/v1.1 及 int8 版）、Kitten v0.8（英）、ZipVoice（中英克隆）、PocketTTS（欧洲语言克隆）、Supertonic 1/3（无中文）、Inflect（英）、Nabra（阿拉伯语，基于 Kokoro 运行时）。中文可用的是 Kokoro、Piper zh_CN、Matcha zh、MeloTTS zh_en、ZipVoice、aishell3（174 人，音质较老）和各种 vits-zh-hf 角色音。
- **Piper zh_CN 新音色**（[PR #3546](https://github.com/k2-fsa/sherpa-onnx/pull/3546)，2026-04）：拼音音素化，配 G2PW 词典（`lexicon-zh-g2pw.txt`）和规则 FST，处理数字、日期、电话。int8 版只有 13MB，适合 Android 的保底方案和低配 Windows。
- **MOSS-TTS-Nano**（[GitHub](https://github.com/OpenMOSS/MOSS-TTS-Nano)）：纯自回归的「音频 tokenizer + LLM」结构，输出 48kHz 立体声。2026-04-17 推出独立的 ONNX CPU 版，导出了 prefill / decode_step / local_decoder 等多个图，要自己写解码循环。官方另有 [MOSS-TTS-Nano-Reader](https://github.com/OpenMOSS/MOSS-TTS-Nano-Reader)，场景和听书一致。README 的 License 一节写着「以根目录 LICENSE 为准」，GitHub 识别为 Apache-2.0，HF ONNX 权重也标了 apache-2.0。
- **Qwen3-TTS**（[GitHub](https://github.com/QwenLM/Qwen3-TTS)，2026-01）：0.6B / 1.7B 两档，有 CustomVoice（预置音色）、Base（克隆）、VoiceDesign（1.7B）三种。社区有 [GGUF](https://github.com/HaujetZhao/Qwen3-TTS-GGUF)、[纯 C](https://github.com/gabriele-mastrapasqua/qwen3-tts)、[ONNX Runtime](https://github.com/zhangluoyang/qwen3-tts-onnxruntime) 等移植。
- **OmniVoice**（[GitHub](https://github.com/k2-fsa/OmniVoice)，2026-04）：Qwen3-0.6B 骨干，非自回归掩码解码，支持 600+ 种语言和中文方言，可以用带声调的拼音纠正读音。sherpa 维护者起初质疑它「能在端侧实时」的说法，现在有新的接入 issue（#3651）。**权重 2026-07-03 起为 CC-BY-NC，排除。**
- **Fun-CosyVoice3**（[HF](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)，2025-12）、**IndexTTS-2.5**（[HF](https://huggingface.co/IndexTeam/IndexTTS-2.5/blob/main/README.md)，2026-08）、**VoxCPM2**（[arXiv 2606.06928](https://arxiv.org/html/2606.06928v1)）、**Fish S2**（[博客](https://fish.audio/blog/fish-audio-open-sources-s2/)）：中文质量第一梯队，适合服务端或 GPU，不适合阅读器内置。如果以后做「自建服务器听书」，可以考虑 CosyVoice 3 或 VoxCPM2（都是 Apache）。
- **许可陷阱**：F5-TTS 权重是 CC-BY-NC（Emilia 数据，[README](https://github.com/swivid/f5-tts)）；Spark-TTS 改成了 CC-BY-NC-SA（[HF](https://huggingface.co/SparkAudio/Spark-TTS-0.5B)）；MaskGCT 改成了 CC-BY-NC；Supertonic 权重是 OpenRAIL-M，且没有中文（[HF](https://huggingface.co/Supertone/supertonic-3)）；VibeVoice 的长文本 TTS 代码在 2025-09 因被滥用而撤下。
- **Android 实测参考**〔未核实〕：有资料说 Pixel 级手机上 Kokoro int8 用 4 线程约 RTF 1；骁龙 8 Gen3 每分钟能生成 20–40 秒音频，中端 8 核机每分钟 60–90 秒。数字之间互相矛盾，必须在 K70 / K30 Pro 上自己测。第三方 sherpa Android TTS 引擎可参考 [VoxSherpa-TTS](https://github.com/CodeBySonu95/VoxSherpa-TTS)。

---

## 4. 接入路线（LightRead）

**P0：桌面小改（可随 v1.5.x 发）**
1. 在 `local_tts.rs` 的 `build_engine()` 里设置 `OfflineTtsConfig.rule_fsts = "<root>/phone-zh.fst,<root>/date-zh.fst,<root>/number-zh.fst"`，前提是文件存在，缺文件时跳过。补一个「2026年10月4日 / 3.14 / 13800138000」的朗读用例。
2. `sherpa-onnx = "1.13.8"`。这个 crate 没有声明 rust-version，要用 CI 的 Rust 最低版本门禁（项目是 1.87.0）验证能否编译；再跑 `cargo test agent` 和本地 Kokoro 测试（`KOKORO_MODEL_DIR`）。
3. 语音包增加「精简版（int8，140MB）」选项，供低配机器使用。下载 URL 和目录名做成按包名的常量（目前写死成 `kokoro-multi-lang-v1_1`）。需要试听并测 RTF 后再决定默认用哪个。
4. 加一个用户发音词典，用来纠正多音字和专有名词：sherpa 的 `lexicon` 支持逗号分隔多个文件，可以把用户词典放在最前面。冲突时以哪个文件为准还需要验证〔未核实〕。

**P1：Android PoC（最大收益）**
1. 按官方 Tauri 示例的做法，把 `Cargo.toml` 里 sherpa-onnx 的 `cfg(not(android/ios))` 限制放开到 Android，由 `build.rs` 把 `libsherpa-onnx-c-api.so` 和 `libonnxruntime.so` 拷进 `gen/android/app/src/main/jniLibs/arm64-v8a`。只做 arm64，和现有发布门禁一致。要确认 APK 体积增量〔未核实，onnxruntime arm64 大约十几 MB〕，以及 `check-release.mjs` 的 ABI 检查。
2. 模型继续在应用内下载，不打进 APK。手机上优先测 Kokoro int8（140MB）。如果 RTF 超过 0.7，就改用 Piper zh_CN int8（13MB，2 个音色）或 Matcha zh-en，同时保留系统 TTS 和 Edge。
3. 在 K70 / K30 Pro 上记录 RTF、首句延迟、发热和耗电，以及播放时 WebView 是否卡顿（线程数要比桌面更保守，建议 2）。

**P2：多模型目录**：sherpa 的 `OfflineTtsModelConfig` 已经统一了 Kokoro、VITS/Piper、Matcha、ZipVoice 的配置。可以做一个模型目录（id、家族、URL、文件、音色表、体积、平台），让用户在设置页挑语音包，前端 `localTts.ts` 只多一个 `modelId` 参数。

**P3：高品质实验（桌面，可选）**：用 `ort` crate 做一个 MOSS-TTS-Nano 原型；或者等 sherpa-onnx 的 ZipVoice 新版。OmniVoice 权重已改为 NC，不再考虑。Qwen3-TTS（GGUF）只作为「高配机器 / 克隆」的附加包评估。在线方面可以加 BYOK 云引擎（豆包 / MiniMax / 百炼），复用现有的 Edge 分段与预取调度。

---

## 5. 风险

- **许可**：很多「开源」TTS 的权重受训练数据（如 Emilia）限制，只能非商用。LightRead 是开源应用，但会分发安装包，引入前要逐个核对权重许可，不能只看代码仓库的 LICENSE。Piper zh_CN 和 Matcha zh-en 的许可也要核实。
- **质量**：Kokoro 的 ONNX / int8 有已知的发音和伪影问题。中文多音字目前只靠词典，没有上下文模型。换模型前做盲听对比，素材用同一组含多音字、数字、中英混排的书摘。
- **Android 构建**：sherpa 的 Android Rust 支持是 2026-08 才加的，比较新，和 Tauri gradle、固定 debug 签名、ABI 门禁之间可能有兼容问题。手机 CPU 和电池压力也大，低端机可能达不到实时。
- **MSRV / 依赖**：升级 sherpa-onnx 会连带 onnxruntime 版本变化，Windows 上要回归 #8 的卡顿修复。
- **模型下载**：模型托管在 GitHub Releases，国内下载慢。sherpa 文档提供了国内镜像，应用内可以加镜像地址，并沿用代理设置。
- **Edge 在线接口**：非官方协议，随时可能失效，需要一个离线或付费云的兜底方案。
- **机器资源**：本次没有做任何实测，上面的速度数字都要在目标设备上重新测。

---

## 6. GitHub 项目一览（`gh` 查询于 2026-10-04；★ = stars，「更新」= 最近一次 push）

| 仓库 | ★ | 更新 | 许可（代码） | 中文 | 本地 / 离线运行时 |
|---|---|---|---|---|---|
| [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 15.1k | 2026-09-22 | Apache-2.0 | ✅（Kokoro / Piper / Matcha / Melo / ZipVoice） | ONNX，C/Rust/Kotlin/Swift…，含 Android / iOS / Tauri |
| [hexgrad/kokoro](https://github.com/hexgrad/kokoro) | 9.2k | 2025-08-06 | Apache-2.0 | ✅ v1.1-zh | PyTorch；ONNX 见下 |
| [thewh1teagle/kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | 2.8k | 2026-09-01 | MIT | ✅ | ONNX Runtime |
| [lucasjinreal/Kokoros](https://github.com/lucasjinreal/Kokoros) | 0.8k | 2026-08-04 | - | ✅ | Rust + ONNX |
| [OpenMOSS/MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano) | 4.4k | 2026-09-06 | Apache-2.0 | ✅ | ONNX CPU，Android ORT 示例 |
| [OpenMOSS/MOSS-TTS](https://github.com/OpenMOSS/MOSS-TTS) | 4.2k | 2026-09-06 | Apache-2.0 | ✅ | PyTorch（1.7B–8B，GPU） |
| [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | 13.6k | 2026-03-17 | Apache-2.0 | ✅ 优 | PyTorch；社区 GGUF / C / ORT |
| [HaujetZhao/Qwen3-TTS-GGUF](https://github.com/HaujetZhao/Qwen3-TTS-GGUF) | - | - | - | ✅ | llama.cpp |
| [k2-fsa/OmniVoice](https://github.com/k2-fsa/OmniVoice) | 14.2k | 2026-09-28 | Apache-2.0（**权重 CC-BY-NC**） | ✅ 优 | PyTorch；社区 ONNX |
| [k2-fsa/ZipVoice](https://github.com/k2-fsa/ZipVoice) | 1.1k | 2025-12-02 | Apache-2.0 | ✅ | PyTorch；sherpa-onnx |
| [QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice) | 23.8k | 2026-05-25 | Apache-2.0 | ✅ 顶级 | PyTorch / TensorRT（GPU） |
| [index-tts/index-tts](https://github.com/index-tts/index-tts) | 24.3k | 2026-09-29 | bilibili 协议 | ✅ 顶级 | PyTorch（GPU） |
| [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM) | 38.3k | 2026-09-30 | Apache-2.0 | ✅ 顶级 | PyTorch；GGUF |
| [fishaudio/fish-speech](https://github.com/fishaudio/fish-speech) | 32.9k | 2026-09-16 | 研究许可 | ✅ 顶级 | PyTorch / SGLang（GPU） |
| [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 62.3k | 2026-10-04 | MIT | ✅ | PyTorch（需微调，GPU 为主） |
| [2noise/ChatTTS](https://github.com/2noise/ChatTTS) | 39.9k | 2026-04-10 | AGPL-3.0 | ✅ 对话风 | PyTorch |
| [SWivid/F5-TTS](https://github.com/SWivid/F5-TTS) | 15.3k | 2026-09-21 | MIT（权重 NC） | ✅ | PyTorch；[DakeQQ/F5-TTS-ONNX](https://github.com/DakeQQ/F5-TTS-ONNX) |
| [SparkAudio/Spark-TTS](https://github.com/SparkAudio/Spark-TTS) | 11.0k | 2025-04-09 | Apache（权重 NC-SA） | ✅ | PyTorch |
| [bytedance/MegaTTS3](https://github.com/bytedance/MegaTTS3) | 6.1k | 2026-06-15 | Apache-2.0 | ✅ | PyTorch |
| [open-mmlab/Amphion](https://github.com/open-mmlab/Amphion)（MaskGCT） | 10.3k | 2026-03-25 | MIT（权重 NC） | ✅ | PyTorch |
| [myshell-ai/MeloTTS](https://github.com/myshell-ai/MeloTTS) | 7.7k | 2024-12-24 | MIT | ✅ | PyTorch；sherpa-onnx |
| [rhasspy/piper](https://github.com/rhasspy/piper) → [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) | 11.3k / 5.8k | 2025-08 / 2026-09-28 | MIT → GPL-3.0 | ✅（3 个 zh_CN） | ONNX；sherpa-onnx（只用模型，不链接 GPL 代码） |
| [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) | 26.7k | 2026-07-21 | MIT | ✅（多语言版） | PyTorch；社区 ONNX |
| [zai-org/GLM-TTS](https://github.com/zai-org/GLM-TTS) | 1.1k | 2026-04-10 | Apache-2.0 | ✅ | PyTorch（GPU） |
| [netease-youdao/Confucius4-TTS](https://github.com/netease-youdao/Confucius4-TTS) | 0.8k | 2026-09-03 | 自定义 | ✅ | PyTorch |
| [studio-dots-ai/dots.tts](https://github.com/studio-dots-ai/dots.tts) | 1.4k | 2026-09-28 | Apache-2.0 | ✅ 多语言克隆 | PyTorch；MLX 移植 |
| [stepfun-ai/Step-Audio-EditX](https://github.com/stepfun-ai/Step-Audio-EditX) | 1.0k | 2026-04-09 | Apache-2.0 | ✅ | PyTorch（3B，GPU） |
| [FireRedTeam/FireRedTTS2](https://github.com/FireRedTeam/FireRedTTS2) | 1.4k | 2025-10-26 | Apache-2.0 | ✅ 对话 | PyTorch |
| [Soul-AILab/SoulX-Podcast](https://github.com/Soul-AILab/SoulX-Podcast) | 3.6k | 2025-12-11 | Apache-2.0 | ✅ 方言播客 | PyTorch |
| [boson-ai/higgs-audio](https://github.com/boson-ai/higgs-audio) | 8.4k | 2026-06-05 | Apache-2.0 | ✅ | PyTorch（GPU） |
| [canopyai/Orpheus-TTS](https://github.com/canopyai/Orpheus-TTS) | 6.3k | 2025-12-05 | Apache-2.0 | ⚠️ 中文研究预览版 | PyTorch / vLLM（3B） |
| [HuiResearch/FlashTTS](https://github.com/HuiResearch/FlashTTS) | 0.6k | 2025-05-18 | - | ✅ | Spark / Orpheus 推理服务 |
| [PaddlePaddle/PaddleSpeech](https://github.com/PaddlePaddle/PaddleSpeech) | 12.7k | 2026-08-12 | Apache-2.0 | ✅（FastSpeech2 等） | Paddle；有 ONNX 导出 |
| [DakeQQ/Text-to-Speech-TTS-ONNX](https://github.com/DakeQQ/Text-to-Speech-TTS-ONNX) | 70 | 2026-09-04 | Apache-2.0 | ✅（多模型 ONNX 导出） | ONNX Runtime |
| [CodeBySonu95/VoxSherpa-TTS](https://github.com/CodeBySonu95/VoxSherpa-TTS) | - | - | - | ✅ | Android 系统 TTS 引擎（sherpa） |
| [DrewThomasson/ebook2audiobook](https://github.com/DrewThomasson/ebook2audiobook) | 20.3k | 2026-10-02 | Apache-2.0 | ✅（多引擎） | 电子书转有声书，可参考 |
| [readest/readest](https://github.com/readest/readest) | 24.9k | 2026-10-04 | AGPL-3.0 | - | 同类阅读器，可参考其 TTS 交互 |
| [rany2/edge-tts](https://github.com/rany2/edge-tts) | 12.2k | 2026-03-22 | 其他（见仓库） | ✅ | 在线（Edge 协议参考） |
| 不支持中文（参考）：[KittenML/KittenTTS](https://github.com/KittenML/KittenTTS) 15.5k、[kyutai-labs/pocket-tts](https://github.com/kyutai-labs/pocket-tts) 9.8k、[supertone-oss-archive/supertonic](https://github.com/supertone-oss-archive/supertonic) 13.8k（已归档）、[nari-labs/dia](https://github.com/nari-labs/dia) 19.4k、[kyutai-labs/delayed-streams-modeling](https://github.com/kyutai-labs/delayed-streams-modeling) 3.0k、[microsoft/VibeVoice](https://github.com/microsoft/VibeVoice) 54.6k、[neuphonic/neutts](https://github.com/neuphonic/neutts) 6.3k | | | | ❌ | |

> 表中 `-` 表示没有查询。stars 和更新时间会随时间变化，以链接页面为准。

---

## 7. 本地优化部署版本（2026-10-05 补充）

> 目标：让「更好的中文模型」在用户自己的机器上跑起来。RTF = 生成耗时 ÷ 音频时长，**< 1 才能边合成边播放**；听书要稳定不卡，单路 RTF 最好 ≤ 0.6（要给预取和 UI 留余量）。下面的速度数字都**来自各项目自己的说明**，本机没有实测。

### 7.0 关键发现：2026 年出现了通用的本地推理底座

| 底座 | ★ / 更新 | 许可 | 覆盖的中文模型 | 形态 |
|---|---|---|---|---|
| [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（现用） | 15.1k / 2026-09-22 | Apache-2.0 | Kokoro、Piper zh、Matcha、MeloTTS、ZipVoice | ONNX；Rust crate 进程内调用；支持 Android / iOS / Tauri |
| [0xShug0/audio.cpp](https://github.com/0xShug0/audio.cpp) | 3.3k / 2026-10-04（v0.9.0） | Apache-2.0（代码） | **Qwen3-TTS、CosyVoice3、IndexTTS-2/2.5、VoxCPM1/2、MOSS-TTS-Nano、Kokoro、Fish S2、FireRedTTS3、MagpieTTS、Confucius4、GLM-TTS、ZipVoice** 等 80+ 个模型家族 | ggml 纯 C++，后端支持 CPU / CUDA / Vulkan / Metal / HIP；提供 CLI、OpenAI 兼容 HTTP server（`/v1/audio/speech`，支持 SSE 流式）和 **C API**（`libaudiocpp`）；可以只编译需要的模型（`--model-set custom`）；GGUF 预转换包在 [audio-cpp/audio.cpp-gguf](https://huggingface.co/audio-cpp/audio.cpp-gguf)；每个模型的权重许可见 [model_licenses.md](https://github.com/0xShug0/audio.cpp/blob/main/docs/model_licenses.md) |
| [Blaizzy/mlx-audio](https://github.com/Blaizzy/mlx-audio) | 8.0k / 2026-10-03 | MIT | Kokoro、Qwen3-TTS、VoxCPM2（4/8bit）、MOSS-TTS-Nano、Spark、LongCat-AudioDiT、Ming-omni-tts | 只支持 Apple Silicon，依赖 **Python**，打进桌面应用成本高 |
| [vllm-project/vllm-omni](https://github.com/vllm-project/vllm-omni) | 7.0k / 2026-10-04 | Apache-2.0 | Qwen3-TTS（官方首日支持）、VoxCPM2 | 面向 GPU 服务端，不适合内置到桌面应用 |

结论：除了 sherpa-onnx，**audio.cpp 是第二个可以「一次接入、多模型复用」的本地运行时**。它的 server 或 C API 能让 LightRead 用同一套接口试听 Qwen3-TTS、CosyVoice3、VoxCPM2、MOSS-TTS-Nano。它的风险是项目很新（2026-06 才开始发版）、迭代快，CPU 路径上没有公开的中文模型 RTF 数据〔未核实〕。

### 7.1 逐个候选

**Kokoro v1.1-zh（int8 / fp32）**，现用
- 移植版本：sherpa-onnx（现用，347MB / int8 140MB）、[kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx)（2.8k，2026-09-01）、[Kokoros](https://github.com/lucasjinreal/Kokoros)（Rust，828，2026-08-04）、mlx-audio（4/6/8bit）、audio.cpp（GGUF Q8 180MB）。注意 audio.cpp 和 mlx-audio 移植的是 v1.0（54 个音色），**不是 v1.1-zh**。
- 速度：(a) x86 笔记本 CPU 远快于实时，LightRead 已在线上验证（低配 2 核 Windows 曾卡顿，#8 已缓解）。(b) M 系列更快。(c) 不需要 GPU。(d) 手机 int8 4 线程约 RTF 1〔未核实〕。另有 sherpa 文档数据：树莓派 4、4 线程时 v1.0 的 RTF 为 3.2。
- 内存：约 0.5–1GB〔未核实〕。流式：按句生成，有回调，首句延迟取决于句长。
- 中文证据：不是零样本克隆模型，没有 Seed-TTS-eval 数据。实际听感自然但平，句与句之间没有语境；多音字靠词典，偶尔读错；ONNX 版个别词发音有偏差（kokoro-onnx #101）。
- 许可：代码和权重都是 Apache-2.0。接入：已接入（Rust 进程内调用）。

**Piper zh_CN（chaowen / xiao_ya）、MeloTTS zh_en、Matcha zh**
- 移植版本：sherpa-onnx 自带。体积 13–160MB，各平台都比实时快很多，**手机首选保底**。音质是 VITS 一代，韵律比较机械。许可：MeloTTS 是 MIT；Matcha baker 不可商用；Piper zh_CN 音色许可需逐个核实〔未核实〕。

**MOSS-TTS-Nano（0.1B）**
- 移植版本：
  - 官方 ONNX CPU 版（仓库内置）。
  - [MOSS-TTS-Nano-Reader](https://github.com/OpenMOSS/MOSS-TTS-Nano-Reader)（61，2026-05-07，浏览器朗读插件 + 本地服务）。
  - [MossTTS-Nano.c](https://github.com/kdrkdrkdr/MossTTS-Nano.c)（19，2026-04-14，单个 dylib/dll，权重内嵌，308MB）。
  - audio.cpp `moss_tts_nano`（GGUF Q8 184MB）、mlx-audio。
  - [MOSS-TTS-Nano-Android](https://github.com/cdyUuu/MOSS-TTS-Nano-Android)（4，2026-09-01，模型约 700MB）。
- 速度：
  - (a) 官方称「4 核 CPU 能流式实时」〔官方说法，未实测〕。
  - (b) M4 单核流畅（官方）；C 移植版在 M1 上预热后 RTF 0.33，冷启动 0.70。
  - (c) 不需要 GPU。
  - (d) 有社区 Android 应用，没有 RTF 数据〔未核实〕。
- 流式：支持 Realtime Streaming Decode。输出 48kHz 立体声。
- 中文证据：模型卡没有公布 Seed-TTS-eval 成绩，中文博客反馈「自然、无电音」〔非正式评测〕。同家族的大模型 MOSS-TTS 在 test-zh 上 CER 1.20。
- 许可：代码 Apache-2.0，ONNX 权重仓库标注 apache-2.0。但 HF 主模型卡写着「not yet licensed for redistribution」，**分发前要向官方确认**。
- 接入：方案 ① Rust `ort` 自己写 prefill / decode_step 循环和音频 tokenizer 解码，工作量中等；方案 ② 通过 FFI 调 MossTTS-Nano.c 的动态库；方案 ③ 走 audio.cpp。安装增量约 200–700MB，取决于精度。
- 主要用法是克隆，内置音色数量没有查清〔未核实〕。要做固定朗读音色，需要随包附带有授权的参考音频。

**Qwen3-TTS（0.6B / 1.7B）**
- 移植版本：
  - [gabriele-mastrapasqua/qwen3-tts](https://github.com/gabriele-mastrapasqua/qwen3-tts)（纯 C，115，2026-09-25，MIT）：int8 / int4，带 HTTP server（兼容 OpenAI 接口），支持流式，可选 Metal / CUDA。
  - [HaujetZhao/Qwen3-TTS-GGUF](https://github.com/HaujetZhao/Qwen3-TTS-GGUF)（llama.cpp + ORT，190，2026-09-19，MIT）：支持 Vulkan / DirectML。
  - [predict-woo/qwen3-tts.cpp](https://github.com/predict-woo/qwen3-tts.cpp)（GGML，244，2026-07-18，MIT）。
  - audio.cpp（0.6B Base 的 GGUF Q8 1.9GB；1.7B 有 Base / CustomVoice / VoiceDesign，**没有 0.6B CustomVoice**）。
  - mlx-audio（mlx-community 的 0.6B CustomVoice 8bit，1.9GB）、vLLM-Omni（GPU）。
  - ONNX 版：[ElBruno.QwenTTS](https://github.com/elbruno/ElBruno.QwenTTS)（43）、[qwen3-tts-onnxruntime](https://github.com/zhangluoyang/qwen3-tts-onnxruntime)（2）。
  - Rust 版：[darkautism/qwen3-tts](https://github.com/darkautism/qwen3-tts)（11）。
- 速度（纯 C 版自测，0.6B，见其 [performance.md](https://github.com/gabriele-mastrapasqua/qwen3-tts/blob/main/docs/performance.md)）：
  - (a) **x86 笔记本 Ryzen 7 6800H 最好只有 RTF 2.02**（int4、4 线程，受内存带宽限制，跑不到实时）。EPYC Zen5（AVX-512）为 0.95。官方 PyTorch 在 Ryzen 9 7950X 上是 4.5–5.8。GGUF 方案在 CPU / 核显上都是 1.3。
  - (b) M1 int8 0.69 / int4 0.52；M4 int4 0.32；M4 Metal 0.28。
  - (c) RTX 4090（PyTorch）0.38；RTX 5050（GGUF，1.7B）0.35；纯 C CUDA（1.7B）约 0.44。
  - (d) Neoverse-N1 为 1.28，Graviton3 为 0.66；**手机基本不可行**〔推断〕。
- 内存：0.6B bf16 约 3GB（mmap）；GGUF 1.7B 约 1.4GB（Q5_K talker + Q8 predictor + fp16 decoder）。
- 流式与首包：M1 int8 流式首包 0.46–0.50s；GGUF 版首包约 300ms；官方 GPU 端到端 97ms。
- 中文证据：Seed-TTS test-zh CER 0.6B-Base 0.92、1.7B-Base 0.77（[官方 README](https://github.com/QwenLM/Qwen3-TTS)）；VoxCPM 的表里 1.7B 为 1.22（评测口径不同）。CustomVoice 有 5 个中文预置音色（Vivian、Serena、Uncle_Fu，以及京味 Dylan、川味 Eric），会根据文本语义调整语气，「语境贴合」能力明显强于 Kokoro。
- 许可：代码和权重都是 Apache-2.0。
- 接入：建议做成 **sidecar**：Tauri `externalBin` 运行纯 C 版 `--serve`，或运行 audio.cpp server，前端用 HTTP 流式拉 PCM。安装增量：程序约十几 MB〔未核实〕，加上 int8 权重约 1–2GB。

**CosyVoice 2 / Fun-CosyVoice3（0.5B）**
- 移植版本：
  - 官方仓库的 vLLM（CosyVoice2/3）和 **TensorRT-LLM + Triton**（`runtime/triton_trtllm`，CosyVoice2 的 LLM 部分约提速 4 倍），以及 JIT / TRT 加载选项。
  - [Lourdle/cosyvoice.cpp](https://github.com/Lourdle/cosyvoice.cpp)（GGML，56，2026-10-03，MIT）：支持 CPU / CUDA / Metal / Vulkan / SYCL，流式（DiT KV cache），带 OpenAI 兼容 server 和量化工具，**没有公布 RTF**。
  - audio.cpp `cosyvoice3`（GGUF Q8 2.15GB）。
- 速度：(a) CPU 上 PyTorch 远低于实时〔社区说法〕，ggml 版没有数据〔未核实〕。(b) 没有数据。(c) GPU 流式首包 150ms（官方）。(d) 不可行。
- 中文证据：Fun-CosyVoice3-0.5B-2512 的 test-zh CER 1.21，**RL 版 0.81**，test-hard 5.44（[模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)）；CosyVoice2 为 1.45。支持 18+ 种方言，可以用拼音纠正读音（inpainting），不需要文本前端也能读数字。
- 许可：代码和权重都是 Apache-2.0。
- 接入：sidecar（cosyvoice-server 或 audio.cpp）。**需要参考音频**：要随包附带有授权的朗读音色，或者让用户自己录。

**IndexTTS-2 / 2.5**
- 移植版本：官方 vLLM recipe、[Ksuriuri/index-tts-vllm](https://github.com/Ksuriuri/index-tts-vllm)（1.2k，2026-04-13）、audio.cpp `index_tts2`（2.5 的 Q8 3.3GB）、SubtitleEdit 打包的 audio.cpp IndexTTS-2.5 引擎（2026-10-04）、[vra/indextts-onnx](https://github.com/vra/indextts-onnx)（0★，实验性）。
- 速度：(c) RTX 4090 上 2.5 bf16 RTF 0.21、2.0 fp16 0.33（官方）；显存约 6GB。(a)(b)(d) 不现实〔推断〕。不支持流式（README 没提）。
- 中文证据：IndexTTS2 的 test-zh CER 1.03；支持用 `<行|XING2>` 这种写法逐字纠正多音字。2.5 的 README 明确说长文本会切段后用短静音拼接，**段与段之间不建模韵律**。
- 许可：bilibili 模型协议，有条件可商用（MAU 超 1 亿或年营收超 10 亿元要另行授权，**产出不能用来训练其他模型**）。只适合「用户自行下载的 GPU 增强包」。

**VoxCPM2（2B）/ VoxCPM-0.5B**
- 移植版本：[Nano-vLLM-VoxCPM](https://github.com/a710128/nanovllm-voxcpm)（GPU）、vLLM-Omni、[llama.cpp-omni](https://github.com/tc-mb/llama.cpp-omni) + [VoxCPM2-GGUF](https://huggingface.co/DennisHuang648/VoxCPM2-GGUF)、mlx-audio（4/8bit）、audio.cpp（VoxCPM2 Q8 2.8GB；VoxCPM1 0.5B 的包约 0.8GB）。
- 速度：(c) RTX 4090 上 0.30，Nano-vLLM 下 0.13；显存约 8GB。(b) **M4 Pro Metal Q8 为 1.76**（官方 README 引用 llama.cpp-omni 的数据），跑不到实时。(a)(d) 不可行。
- 中文证据：VoxCPM2 test-zh CER 0.97、SIM 79.5；VoxCPM-0.5B 为 0.93（[VoxCPM README](https://github.com/OpenBMB/VoxCPM)）。输出 48kHz。audio.cpp 的长文本默认用 **`continuation` 策略**：后一块接着前一块的音频继续生成，是目前候选里跨块连贯性最好的。
- 许可：代码和权重都是 Apache-2.0。适合「有 8GB 以上 N 卡」的增强包。

**Spark-TTS / Fish S2-Pro / OpenAudio S1-mini / MegaTTS3**（只作对照）
- Spark-TTS：test-zh CER 1.20–1.54。移植版有官方 Triton-TRTLLM、mlx-audio、[SparkTTS.cpp](https://github.com/DarkKowalski/SparkTTS.cpp)，但**权重是 CC-BY-NC-SA**，排除。
- Fish S2-Pro：test-zh CER 0.54，目前最好。4.4B 参数，audio.cpp 有 GGUF，但**权重是 Fish Research License，非商用**，排除。S1-mini 0.5B 的 test-hard CER 高达 23.37，许可也是 NC〔未核实〕。
- MegaTTS3：Apache-2.0，test-zh CER 1.52，WaveVAE 编码器没有公开（克隆受限），没有成熟的本地移植，排除。

**2026 年新出现的中文候选（第一轮未覆盖）**
- [FireRedTTS3](https://huggingface.co/FireRedTeam/FireRedTTS3)（2026-08，Apache-2.0，24 种语言加 21 种中文方言，Q8 GGUF 约 4GB）：GPU 级别。
- [MagpieTTS Multilingual 357M](https://huggingface.co/nvidia/magpie_tts_multilingual_357m)（NVIDIA Open Model License，可商用，含中文，自带说话人，Q8 GGUF 1.5GB）：体积处在中间，**值得在 CPU 上试听一次**〔未核实中文质量〕。
- [Kitten TTS 2](https://huggingface.co/KittenML/kitten-tts-2)（2026-09-30，含中文，但用的是 Stellon 社区许可，有注册和营收限制）：需谨慎。
- [LongCat-AudioDiT](https://huggingface.co/meituan-longcat/LongCat-AudioDiT-1B)（美团，MIT，1B / 3.5B；3.5B 版 test-zh CER 1.09、SIM 81.8）。
- [Ming-omni-tts-0.5B](https://huggingface.co/inclusionAI/Ming-omni-tts-0.5B)（Apache-2.0）。
- [Confucius4-TTS](https://github.com/netease-youdao/Confucius4-TTS)（权重 Apache-2.0，audio.cpp 支持流式）。
- [GLM-TTS](https://huggingface.co/zai-org/GLM-TTS)（权重 MIT）。

以上基本都需要 GPU，或者没有 CPU 实测数据。

### 7.2 汇总表

| 模型 + 推荐移植版 | x86 笔记本 CPU | Apple M | NVIDIA | 手机 arm64 | 流式 / 首包 | 中文 CER（test-zh） | 许可（代码 / 权重） | Tauri 接入 | 安装增量 |
|---|---|---|---|---|---|---|---|---|---|
| Kokoro v1.1-zh + sherpa-onnx | ✅ 远快于实时 | ✅ | 不需要 | ⚠️ 约 RTF 1〔未核实〕 | 按句 | 无（非克隆模型） | Apache / Apache | ✅ 已接入 | 140–347MB |
| Piper zh / Matcha + sherpa-onnx | ✅ | ✅ | 不需要 | ✅ | 按句 | 无 | MIT 等 / 逐个核实 | 进程内调用 | 13–125MB |
| MOSS-TTS-Nano + ORT / .c / audio.cpp | ⚠️ 官方称 4 核实时 | ✅ M1 0.33 | 不需要 | ⚠️ 未知 | ✅ 流式 | 未公布 | Apache / 待确认 | `ort` 或 FFI 或 sidecar | 0.2–0.7GB |
| Qwen3-TTS-0.6B + 纯 C int8 | ❌ 6800H 2.02 | ✅ M1 0.52–0.69，M4 0.32 | ✅ 0.3–0.4 | ❌ | ✅ 首包 0.46s | 0.92（1.7B 0.77） | Apache / Apache | sidecar（HTTP） | 1–2GB |
| Fun-CosyVoice3-0.5B + cosyvoice.cpp / audio.cpp | ❌〔推断〕 | ？ | ✅ 首包 150ms | ❌ | ✅ | 1.21（RL 0.81） | Apache / Apache | sidecar | 约 2.2GB（Q8） |
| VoxCPM2 + audio.cpp / Nano-vLLM | ❌ | ❌ M4 Pro 1.76 | ✅ 0.13–0.30（8GB） | ❌ | ✅ | 0.97 | Apache / Apache | sidecar | 约 2.8GB（Q8） |
| IndexTTS-2.5 + audio.cpp / vLLM | ❌ | ❌ | ✅ 0.21（6GB） | ❌ | ❌ | 1.03（v2） | bilibili / 有条件 | sidecar | 约 3.3GB（Q8） |
| OmniVoice / Spark / Fish S2 / F5 | — | — | — | — | — | 0.54–1.54 | **权重 NC** | 排除 | — |

> CER 衡量的是「读得对不对」（可懂度），**不代表自然度和韵律**。语境贴合要靠第 9 节的盲听评测来判断。

### 7.3 Tauri 集成方式比较

| 方式 | 适用模型 | 优点 | 缺点 |
|---|---|---|---|
| A. sherpa-onnx 进程内调用（现状） | Kokoro / Piper / Matcha / ZipVoice | 已接入；能上 Android | 只能用 sherpa 支持的模型 |
| B. Rust `ort` 进程内调用 | MOSS-TTS-Nano（ONNX） | 不多一个进程，onnxruntime 可以和 sherpa 共用〔需验证版本冲突〕 | 要自己移植自回归解码循环和采样逻辑 |
| C. audio.cpp C API + Rust FFI | audio.cpp 支持的全部模型 | 会话常驻、缓存可复用 | ggml 多后端（CUDA / Vulkan / Metal）的交叉编译会显著增加 CI 和安装包体积 |
| **D. sidecar 本地 HTTP**（`audiocpp_server` / 纯 C qwen_tts / cosyvoice-server） | 所有大模型 | 进程隔离（崩溃、OOM 不影响阅读器）；按机器下载 CPU / CUDA / Vulkan / Metal 对应的二进制；接口统一为 OpenAI `/v1/audio/speech` | 要管理端口、启动和退出；首次加载慢 |

建议：**默认引擎继续用 A，高品质引擎用 D 做成可选下载的「增强语音包」**（二进制加权重一起下载，不打进主安装包）。前端复用 Edge 那套「分段、预取、缓存」的调度，只把请求目标换成 `http://127.0.0.1:<port>`。

---

## 8. 长文本听书的分块建议

| 模型 | 单次输入建议 | 跨块连贯性 | 音色一致性的做法 |
|---|---|---|---|
| Kokoro（sherpa） | 1 句到 1 小段，单次 ≤ 510 个音素 token（模型上限）。sherpa 内部会再按标点切句，逐句独立推理 | ❌ 句与句之间没有上下文 | 固定 `sid`（音色向量），天然一致 |
| Piper / Matcha / Melo | 同上 | ❌ | 固定 sid |
| MOSS-TTS-Nano | 1–3 句；官方支持长文本自动分块克隆 | ⚠️ 每块都以同一参考音频为条件，韵律不跨块〔未核实〕 | 固定参考音频（预编码后复用） |
| Qwen3-TTS | **≤ 约 300 字、在句子边界切**。整章一次送入会漂移（社区经验） | ⚠️ 可以把上一块的音频和文本当作 ICL 提示续写〔实验性〕 | 用 CustomVoice 预置音色，或固定 x-vector / `.qvoice`；固定 seed |
| CosyVoice3 | 1–3 句（约 50–150 字）。前端会自动切句；支持文本输入流式（bi-streaming） | ⚠️ 只靠同一个 prompt 保持风格 | 缓存 prompt_speech 和说话人嵌入（cosyvoice.cpp 支持预编码复用） |
| IndexTTS-2.5 | 约 80–200 字（官方测到 200 字时 RTF 稳定） | ❌ 官方明确说段与段之间只插静音 | 固定参考音频；情感参考单独提供 |
| VoxCPM2（audio.cpp） | 默认分块 2048 字符 | ✅ **`continuation` 策略接着前一块继续生成** | 固定参考或用 voice design |
| OmniVoice（audio.cpp） | 160 字，伪流式 | ⚠️ voice prompt promotion | — |

**LightRead 的分块规则**（与引擎无关，建议写进 `services/tts` 的切分器）：
1. **以段落为硬边界**，段内按句号、问号、叹号切句，再把短句合并到目标长度：Kokoro 和 Piper 约 40–100 字，LLM 类 TTS 约 80–200 字。超长句在逗号、分号处再切。块不跨段落、不跨章节。
2. **对话保持完整**：引号内的话和紧邻的说话人标注（「他笑道：」）放在同一块，避免语气断开。
3. **先规范化再合成**：数字、日期、单位、公式、URL 先转成可读文本（或用 sherpa 的 `rule_fsts`）；人名、多音字查用户词典。
4. **停顿由调度层插入**：句间 150–250ms，段间 350–600ms，章节间约 1s。不依赖模型自己生成的结尾静音（LLM 类 TTS 首尾静音长短不一，需要裁掉再补）。
5. **音色稳定**：同一本书固定引擎、音色、seed、语速。LLM 类 TTS 尽量用预置音色或预编码的参考，不要每块重新提取参考。
6. **预取和缓存**：至少预取 2 块。按 `hash(引擎+模型+音色+语速+规范化文本)` 缓存音频，回听和跳转时直接命中，也方便算「还要听多久」。
7. **接缝处理**：块之间用 20–50ms 淡入淡出，或者干脆插静音；VoxCPM2 这类支持续写的模型可以不插。

---

## 9. 更新后的推荐矩阵与评测协议

### 9.1 推荐矩阵

| 档位 | 采用 | 理由 | 状态 |
|---|---|---|---|
| **默认（所有机器，含低配 Windows / 无 GPU 的 x86 笔记本）** | **sherpa-onnx + Kokoro v1.1-zh**：默认 fp32，提供 int8 精简选项；补 `rule_fsts`，加用户发音词典，按第 8 节分块。在线引擎保留 Edge | x86 CPU 上更好的模型（Qwen3-TTS 0.6B 在 6800H 上 RTF 2.0）都跑不到实时；Kokoro 是唯一「到处都流畅、许可干净」的方案 | 改进项可以马上做 |
| 默认的实验替补 | **MOSS-TTS-Nano**（先用 audio.cpp server 或 ONNX 原型做盲听；通过后再决定走 `ort` 进程内还是 sidecar） | 0.1B，官方称 4 核能实时，支持流式，Apache；可能是唯一能在普通笔记本上「比 Kokoro 更像人」的模型 | 需要实测 RTF 和中文听感，并确认权重分发许可 |
| **高配桌面：Apple Silicon（M1 及以上，16GB）** | **Qwen3-TTS-0.6B-CustomVoice int8 + [纯 C 引擎](https://github.com/gabriele-mastrapasqua/qwen3-tts) 的 `--serve` sidecar**（MIT 加 Apache，无 Python） | M1 RTF 0.52–0.69，M4 0.32，流式首包约 0.5s；有中文预置音色，会根据语义调整语气 | 做成可选下载的增强语音包（约 1–2GB） |
| **高配桌面：NVIDIA GPU（≥ 6–8GB）或 Vulkan 显卡** | **audio.cpp server（CUDA / Vulkan 版）**，模型可选 **Qwen3-TTS-1.7B-CustomVoice**（预置音色，免参考音频），或 **Fun-CosyVoice3-0.5B-RL**（test-zh CER 0.81，需要随包附带有授权的朗读参考音频）；显存 ≥ 8GB 时加上 **VoxCPM2**（用 continuation 做长文本连贯） | 许可都是 Apache；GPU 上 RTF 0.13–0.4 | 增强包；IndexTTS-2.5 只作为「用户自行同意 bilibili 协议」的可选项 |
| **手机（Android arm64）** | **sherpa-onnx + Kokoro int8**。如果 K70 实测 RTF > 0.7，就降级到 **Piper zh_CN int8（13MB）/ Matcha zh-en**；系统 TTS 和 Edge 兜底 | 只有 sherpa 路线有现成的 Tauri Android 支持；LLM 类 TTS 在 arm 服务器 CPU 上都要 0.66–1.28，手机更差 | 先做 PoC；MOSS-TTS-Nano 的 Android 版只做观察 |

### 9.2 评测协议

**测试语料**（固定 10 段，存成 `scripts/tts-eval/passages.txt`，等实施时再建；古文选公有领域作品，其余自拟）：
1. **多音字**：「银行行长说，这一行的行情不好，他行不行还得看下一步。重庆的重量级选手重新上场，还了钱还要还人情。」
2. **数字 / 日期 / 单位**：「2026年10月4日，GDP 同比增长5.2%，售价 ¥1,299.00，电话 13800138000，详见第3章第12节，1998—2003年。」
3. **中英混排**：「我们用 Transformer 做 machine learning，在 iPhone 17 Pro 上跑 Qwen3-TTS，延迟低于 300ms。」
4. **对话和语气**（自拟小说片段）：「"你真的要走？"她压低声音问。"不走还能怎样！"他把门一摔，"难道等着他们来抓吗？"」
5. **文言文**：范仲淹《岳阳楼记》「庆历四年春，滕子京谪守巴陵郡。越明年，政通人和，百废具兴……」
6. **诗词节奏**：李白《将进酒》「君不见黄河之水天上来，奔流到海不复回……」
7. **现代散文长句**：朱自清《荷塘月色》选段（约 150 字）。
8. **学术和技术段落**：「在 ImageNet 上，ResNet-50 的 top-1 准确率为 76.1%，参数量约 25.6M（见表 3，式 (2)）。」
9. **约 400 字长段落**（自拟叙事）：测跨块韵律、音色漂移、接缝。
10. **标点与轻声 / 儿化**：「他说——不，是喊……《三体》（刘慈欣著）。等一会儿，小孩儿把东西放下了。」

**听感评分**（每段 1–5 分，至少 3 人，随机文件名盲听，响度统一到 −16 LUFS，语速 1.0）：
- **读对**：错字、多音字误读、漏字、重复的数量（可以加一项 ASR 客观 CER，用 sherpa 的 Paraformer / SenseVoice 转写对比）。
- **自然度**：停顿位置、重音、句末降调、疑问句升调，有没有机器腔。
- **语境贴合**：对话情绪、文言和诗词的节奏、说明文是否平稳。
- **音色稳定**：跨块音色和音量是否一致，有没有漂移、怪声、电音、接缝爆音。
- **长听疲劳**：连续听第 9 段循环 10 分钟后的主观感受。

**性能**（每台目标机器各测一次：2 核低配 Windows、x86 无独显笔记本、M1/M 系列、NVIDIA 机器、K70 / K30 Pro）：冷启动加载时间、首块延迟、RTF（P50 / P95）、内存和显存峰值、朗读时 CPU 占用和 UI 卡顿次数、手机发热和每小时耗电。结果按 `docs/perf-ledger.md` 的格式记账。

**通过线**（建议）：默认引擎各项平均 ≥ 3.5，第 1、2 段零错误（加了词典和 FST 之后），目标机器 RTF P95 ≤ 0.6。增强包要求自然度和语境贴合两项都比 Kokoro 高 ≥ 0.5 分，否则不值得用户多下 1–3GB。

# 国内发布镜像（GitCode / Gitee）与本地 CosyVoice3 引擎调研（2026-10-05）

> 来源：官方文档、API 和 `gh` 查询，链接附在条目后。标 **〔未核实〕** 的是没拿到一手证据的内容，标〔推断〕的是根据数据推算的结论。
> 所有网络实测都在本机（美国服务器）上做，**没有在中国大陆网络下验证**。
> 本次 WebSearch 配额已用完，资料全部靠直接抓取官方页面、API 和 `gh` 获得。没有改动代码。

---

## A. 国内可访问的发布镜像

我们的发布物（v1.7.2，用 `gh release view` 实测）：12 个文件，合计约 **367MB**。最大的两个是 `amd64.AppImage` 104,921,592 B（略超 100MiB）和 Android APK 70,519,328 B。

### A.1 结论

| | GitCode（gitcode.com，CSDN 运营，存储在华为云） | Gitee（gitee.com，开源中国） |
|---|---|---|
| **结论** | **✅ GO：主镜像** | **❌ NO-GO：不做完整镜像**（最多做部分文件的备用镜像） |
| 附件大小限制 | 文档没有给出单文件、单 Release 或仓库附件的配额，只说用量达到 80% 和 95% 时提醒（[用量](https://docs.gitcode.com/docs/help/home/user_center/data_management/usage_and_storage)）。实例：Cherry Studio 在 GitCode 上有 102 个 Release，v2.1.4 一个版本就有 41 个附件，单个最大 **424MB**（dmg）和 408MB（AppImage）。是否有特殊配额〔未核实〕 | 社区版**单个附件 ≤ 100MB**，**每个仓库附件总量 ≤ 1GB**（推荐项目 5GB，GVP 20GB）（[创建发行版](https://help.gitee.com/repository/release/create)、[配额](https://help.gitee.com/questions/Gitee产品配额说明)）。我们的 AppImage 超出单文件限制；1GB 只够放约 3 个版本（不含 AppImage） |
| 注册与实名 | 注册要手机号和邮箱（[服务条款](https://docs.gitcode.com/docs/help/home/protocol/terms-of-service)，2025-11-21 生效）。公开仓库和 Release 是否要实名，文档没写〔未核实〕 | 大陆账号是否必须绑定手机、公开仓库是否仍需人工审核〔未核实〕 |
| Release API | `https://api.gitcode.com/api/v5`。鉴权用 `Authorization: Bearer <PAT>`。**上传附件分两步**：先 `GET …/releases/:tag/upload_url?file_name=` 拿到签名 URL 和请求头，再 `PUT` 文件（[文档](https://docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-releases-tag-upload-url)） | `POST /api/v5/repos/{o}/{r}/releases`，再用 `POST …/releases/{id}/attach_files`（multipart）上传，一次请求传完、不能续传 |
| 从 GitHub 镜像 | 项目设置 → 仓库镜像，支持 Pull 和 Push（[文档](https://docs.gitcode.com/docs/help/home/org_project/project_manage/project_settings/repository_mirroring)）。导入只迁 git 内容，**不迁 Release** | 仓库镜像管理功能的页面还写着「限时开放至 2022-08-31」，现在是否免费〔未核实〕 |
| 匿名下载（实测） | `GET /…/releases/download/<tag>/<file>` 302 跳到 `file-cdn.gitcode.com` 的签名 URL，再返回 206。**不用登录，支持 Range 断点续传**。注意 HEAD 请求返回 401，不能用 HEAD 探测。美国测速约 4MB/s，大陆速度未测 | 经两次 302 跳到 `foruda.gitee.com`，返回 200，不用登录。**不支持 Range**（断线要整个重下）。美国测速约 1.2MB/s |
| 条款风险 | 条款里有一句「游客不能上传或下载任何内容」，与实际可匿名下载不符，是潜在风险。条款不承诺服务不中断。正在和 AtomGit 合并账号，URL 将来可能变 | 条款第 8 条明确「**禁止大量的外链请求…不允许存放与代码无关的文件**」，可以停用或删除仓库。频繁外链拉取是仓库被屏蔽的原因之一（[FAQ](https://help.gitee.com/questions/项目被屏蔽后如何处理)）。应用内更新器指向 Gitee，正好属于这种外链 |
| API 限流 | 每分钟 400 次、每小时 4000 次（[API 文档](https://docs.gitcode.com/docs/apis/)）。一次发版约 30 次调用，足够 | 匿名每小时 60 次，登录后的上限文档没写 |
| 生产先例 | **Cherry Studio** 在用：GitHub Release 发布后由 workflow 同步到 GitCode，应用内按地区选择下载源（[sync-to-gitcode.yml](https://github.com/CherryHQ/cherry-studio/blob/main/.github/workflows/sync-to-gitcode.yml)、[app-upgrade.md](https://github.com/CherryHQ/cherry-studio/blob/main/docs/contrib/app-upgrade.md)） | 有人用 `nICEnnnnnnnLee/action-gitee-release`、`hepengju/release2gitee`（只保留最近 3 个版本） |

### A.2 GitCode 自动化步骤

**需要负责人手动做的事：**
1. 注册 GitCode 账号（需要手机号）。
2. 创建公开仓库 `yzfly/LightRead`。在「仓库镜像」里设置从 GitHub 的 Pull 镜像，或者由 workflow 推送代码和 tag。
3. 创建个人访问令牌（PAT）：勾选仓库和 Release 写权限，设置有效期，并记下过期日期。
4. 把令牌存进 GitHub：执行 `gh secret set GITCODE_TOKEN -R yzfly/LightRead`，按提示粘贴，不要回显；再执行 `gh variable set GITCODE_REPO -b yzfly/LightRead`。
5. 第一次发版后，在大陆网络下实际下载一次，测速并确认能下。

**在 `.github/workflows/release.yml` 新增 job `mirror-gitcode`**（放在 `needs: publish` 之后；失败**不影响**已经公开的 GitHub Release；另加一个 `workflow_dispatch` 输入 `mirror_only`，可以单独重跑）：
1. 下载并校验：`gh release download "$TAG" -D assets`，然后 `(cd assets && sha256sum -c SHA256SUMS)`。
2. 确保 tag 已经在 GitCode 上：可以 `git push https://<user>:$GITCODE_TOKEN@gitcode.com/$GITCODE_REPO.git refs/tags/$TAG`（用 PAT 时 HTTPS 用户名该填什么格式〔未核实，需要首次试验〕），也可以靠 Pull 镜像，轮询 `GET /repos/$R/tags` 直到 tag 出现。
3. 创建 Release（幂等）：先 `GET /repos/$R/releases/tags/$TAG`。返回 404 时再 `POST /repos/$R/releases`，内容为 `{tag_name, name:"LightRead 轻阅 $TAG", body:<GitHub 版本说明>, release_status:"latest"}`，正文用 `jq --rawfile` 组装。
4. 逐个上传文件。只传 `.assets[].name` 里还没有的文件，按从小到大的顺序，`SHA256SUMS` 和 `*.apk.json` 放最后。每个文件：
   - `curl -G --data-urlencode file_name=$f …/releases/$TAG/upload_url`，拿到 `url` 和 `headers`；
   - 把 `headers` 写进 `curl -K` 用的配置文件；
   - `curl --fail -X PUT --data-binary @assets/$f "$url"`；
   - 失败最多重试 5 次，退避 5、15、45 秒……，**每次重试都重新取 upload_url**；
   - 需要覆盖已有文件时，先 `DELETE …/attach_files/{id}`（同名上传会不会自动覆盖〔未核实〕）。
5. 回下载校验：用 GET（不能用 HEAD）从 `https://gitcode.com/$R/releases/download/$TAG/$f` 把每个文件下载回来，再跑 `sha256sum -c SHA256SUMS`。有任何不一致就让 job 失败。
6. 在 step summary 里列出所有镜像下载链接。

**应用内更新（`src/services/updater.ts`）**：
- 新增「下载源」设置：自动 / GitHub / GitCode（国内）。自动模式下，GitHub 8 秒超时或系统语言是 zh-CN 时，改用 `https://api.gitcode.com/api/v5/repos/yzfly/LightRead/releases/latest`（可匿名访问，支持 CORS，网页版也能用）。
- 字段要做映射：
  - 过滤掉 `type:"source"` 的源码包；
  - 没有 `size` 字段，大小从 SHA256SUMS 或 Range 请求里取；
  - 用 `created_at` 代替 `published_at`；
  - 发布页地址用 `https://gitcode.com/yzfly/LightRead/releases`。
- 下载走现有的 `fetchRemote`（GET，跟随跳转）。安装前用同一镜像上的 SHA256SUMS 校验。

**README**：在 GitHub 下载链接旁加一行「国内下载：GitCode」，并注明它比 GitHub 晚几分钟同步、已校验哈希。

**Gitee（如果一定要做）**：只放 APK、exe、dmg、deb、rpm 和 SHA256SUMS，不放 AppImage；只保留最近 2 个版本的附件。只在 README 里放链接，**更新器不要指向 Gitee**。

---

## B. 本地 CosyVoice3 引擎（作为 Kokoro 的补充）

### B.1 结论

1. **CosyVoice 没有开源的「2.5」版本。** 官方仓库已迁到 [QwenAudio/CosyVoice](https://github.com/QwenAudio/CosyVoice)，只开源了 CosyVoice 1、2 和 **Fun-CosyVoice3-0.5B-2512**（base 版和 RL 版）。Fun-CosyVoice 3.5 已经发布公告，但权重没有开源（[#1840](https://github.com/QwenAudio/CosyVoice/issues/1840)）。
   - 百炼云端的 `cosyvoice-v3.5-flash/plus` 只支持声音设计和声音复刻，没有系统音色（[百炼文档](https://help.aliyun.com/zh/model-studio/text-to-speech)）。
   - 负责人听到的「2.5」，很可能是硅基流动的 CosyVoice2 样本，或百炼的 v3、v3.5〔推断〕。
   - 本地 CosyVoice3 **没有内置音色**，听感很大程度取决于我们附带的参考音频。
2. **我做了 CPU Q8 实测：在本机远远达不到实时。**
   - 测试条件：用 [Lourdle/cosyvoice.cpp](https://github.com/Lourdle/cosyvoice.cpp) v0.1.3 从源码编译（纯 CPU，GGML_NATIVE），4 vCPU Xeon Cascade Lake（支持 AVX-512），4 线程。
   - 结果：

     | 模型 | 文本 | 合成耗时 / 音频时长 | RTF | 峰值内存 |
     |---|---|---|---|---|
     | **Q8_0（943MB）** | 37 字 | 62.4s / 9.24s | **6.75** | 1.89GB |
     | Q8_0 | 176 字整段 | 244s / 35.0s | **约 6.9** | 1.89GB |
     | Q4_K_M（629MB） | 37 字 | 约 57s / 8.88s | **约 6.4** | 1.27GB |

   - **换更低的量化几乎不提速**：瓶颈在 flow-matching（DiT 10 步），不在 LLM。
   - 普通 8 核笔记本大约是本机的 2–3 倍速，推算 RTF 约 2–3.5，仍然跑不到实时〔推断〕。
   - Apple Metal 或独显上可能低于 1，但没有公开数据〔未核实〕。
   - 社区的其他数据：QVAC 用 ggml 跑 CPU 10 线程，RTF 0.73–0.98，但硬件没注明，而且是贪心解码，WER 很差（[qvac#4601](https://github.com/tetherto/qvac/pull/4601)）；PyTorch 和 ONNX 跑 CPU，RTF 在 12–22 之间。
3. **读对率尚可。** 用 ASR 回写 CPU 样本：数字和日期都读对了。整段样本在「2024年3月」附近疑似重复读了「3月」一次，CosyVoice 类模型已知会有重复或漏字〔需试听确认〕。
4. **许可没问题。** 代码和权重都是 Apache-2.0（[模型卡](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512)），cosyvoice.cpp 是 MIT，audio.cpp 是 Apache-2.0。sherpa-onnx 维护者明确说「no plan to support」CosyVoice（[#3568](https://github.com/k2-fsa/sherpa-onnx/issues/3568)）。
5. **建议：可以做，但定位为「高品质增强包（需要 GPU 或 Apple 芯片）」，外加「后台预生成整章」模式。不能作为普通 CPU 机器的实时朗读引擎。** 先做 1–2 天 spike，在负责人的 Mac（Metal）和一台 Windows N 卡或 Vulkan 机器上测 RTF，再决定是否投入完整工作量。

### B.2 可用的移植版本

| 项目 | 许可 | CosyVoice3 支持 | 流式 | 量化与体积（不含参考音频前端） | 预编译包 | 备注 |
|---|---|---|---|---|---|---|
| **[Lourdle/cosyvoice.cpp](https://github.com/Lourdle/cosyvoice.cpp)** v0.1.3（2026-09-10） | MIT | 零样本、指令、跨语种 | ✅ DiT KV cache；server 以 chunked 方式返回 PCM16 | Q8_0 **944MB**、Q6_K 840MB、Q4_K_M 629MB、F16 1.72GB。LLM 和 flow 量化，HiFT 用 F16（[GGUF](https://huggingface.co/Lourdle/Fun-CosyVoice3-0.5B-2512-GGUF)） | Windows / Linux 包**不带 GGML**，要另配 llama.cpp 的库。**Linux 预编译包要求 glibc 2.43，在 Ubuntu 24.04 上跑不了（实测）**。没有 macOS x64 包 | 有 OpenAI 兼容的 `cosyvoice-server`、C API、`quantize` 工具。音色可以预先编码成 `prompt_speech.gguf`（本次实测 80KB），运行时不需要 ONNX。已知问题：解码卡住（[#34](https://github.com/Lourdle/cosyvoice.cpp/issues/34)）、句尾截字（[#33](https://github.com/Lourdle/cosyvoice.cpp/issues/33)） |
| [0xShug0/audio.cpp](https://github.com/0xShug0/audio.cpp) v0.9.0 | Apache-2.0 | 支持，**只有离线模式** | ❌ | 只有 Q8（2.26GB）和 F32。Q8 包里还有一份疑似重复的 BlankEN 权重 652MB | 齐全：Windows CPU / Vulkan / CUDA、Ubuntu、macOS arm64 / x64 Metal | 可以调低 `num_inference_steps`（默认 10），用速度换质量；一个运行时能跑多种模型 |
| [CrispASR](https://github.com/CrispStrobe/CrispASR) cosyvoice3-tts | MIT | 有 **RL 版**的 LLM GGUF | ✅ | 最小组合约 745MB（[GGUF](https://huggingface.co/cstr/cosyvoice3-0.5b-2512-GGUF)） | — | 自带 8 个音色（部分来自 FLEURS，CC BY 4.0）。用真人音色要加 `--i-have-rights`，并在开头插入 AI 声明 |
| [cosyvoice3_stream.cpp](https://huggingface.co/yang-qi1222/cosyvoice3_stream.cpp) | — | 剪枝蒸馏版（LLM 12 层，flow 4 步） | ✅ | 1.64GB | — | RTX 5880 上 RTF 0.10，首包 223ms。flow 步数少，对 CPU 有利，但没有 CPU 数据 |
| [Nian27/CosyVoice3-MNN](https://github.com/Nian27/CosyVoice3-MNN) | Apache-2.0 | flow 蒸馏到 2 步 | — | 内存约 2.25GB | Android | 骁龙 SM8850 上 RTF 0.79–0.96。说明**减少 flow 步数是在 CPU 上提速的关键** |

**组成部分**（官方仓库共 9.75GB）：
- LLM（基于 Qwen2-0.5B）：文本 → 25Hz 语音 token。
- Flow-matching DiT（10 步）：token → 梅尔谱。**这是 CPU 上的瓶颈。**
- HiFT 声码器：梅尔谱 → 24kHz 波形。
- 只在制作音色时用到：CAMPPlus 说话人向量（int8 版 8.7MB）、speech_tokenizer_v3（int8 版 244MB）。

**构建实测**（本机，`flock` 加 `nice`）：
- 要先拉 git submodules，需要 CMake ≥ 3.28。
- `cosyvoice-server` 的内嵌 WebUI 用到 C23 的 `#embed`，GCC 13 不支持，要加 `-DCOSYVOICE_SERVER_NO_WEBUI=ON`。
- 去掉 WebUI 后，用 3 线程约 45 秒编译完成。
- 自己在 CI 编译（固定 ggml 版本，选较老的 glibc 基线）是可行的，也必须这样做。

### B.3 音色

- **没有内置说话人**（仓库里没有 spk2info）。三种模式都需要参考音频和对应文本：零样本、跨语种、instruct2。instruct2 可以用「请用…语气」控制方言、情绪、语速。
- 参考音频可以预先编码一次，生成 `prompt_speech.gguf` 后反复使用。参考音频越短（3–5s），flow 的计算量越小。
- **可以随包分发的参考音频来源**：
  - AISHELL-3（[SLR93](https://www.openslr.org/93/)，**Apache-2.0**，218 位说话人，要挑朗读质量好的）；
  - FLEURS zh（CC BY 4.0，需要署名）；
  - 用 Kokoro（Apache-2.0）合成的参考句，不涉及任何真人。
  - **不能用**：官方 `asset/zero_shot_prompt.wav`（README 承认部分示例来自网络，来源不明），MAGICDATA（NC-ND），以及 Edge / Azure 合成的音频（服务条款不允许这么用）。本次测试用 Edge 曉臻做参考，**只用于本地测速，不能分发**。
- **台湾腔**：只能靠台湾口音的参考音频。可以从 AISHELL-3 或 FLEURS 里找台湾口音的说话人〔未核实是否有合适的〕，或者让用户自己录 5 秒（需要额外的前端包：int8 tokenizer 244MB 加 ORT）。

### B.4 接入方案（Tauri）

**形态：sidecar 进程。不做进程内 FFI，也不用 `ort`。** 理由：
- ggml 出错会直接 abort，独立进程不会拖垮阅读器；
- macOS 对事后下载的动态库有签名限制；
- 可以按需启动和退出，空闲时释放 1.3–1.9GB 内存。

1. **增强语音包**，约 1GB，按需下载，不打进安装包：
   - CI 自己编译的 `cosyvoice-server`，编译选项 `NO_FRONTEND`、`NO_ICU`、`NO_WEBUI`；
   - 平台：win-x64（CPU，可选 Vulkan）、mac-arm64（Metal）、mac-x64（CPU）、linux-x64（CPU）；
   - Q8 GGUF（944MB）。以后可以用 `convert_model_to_gguf.py --llm_model llm.rl.pt` 自己转出 RL 版（CER 0.81，base 版 1.21）；
   - 4–6 个预先编码好的 `prompt_speech.gguf`，附 NOTICE 和署名；
   - 一个 `manifest.json`，记录每个文件的 sha256 和大小。
2. **下载源顺序**：ModelScope → hf-mirror → huggingface.co → GitHub。支持断点续传，沿用现有的代理设置。已确认存在的国内镜像（实测返回 206，sha256 与 HF 一致）：
   - `https://modelscope.cn/models/Lourdle/Fun-CosyVoice3-0.5B-2512-GGUF/resolve/master/CosyVoice3-2512_Q8_0.gguf`
   - `https://modelscope.cn/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512`（官方原始权重）
   - `https://modelscope.cn/models/audio-cpp/audio.cpp-gguf/resolve/master/CosyVoice3-GGUF/cosyvoice3-q8_0.gguf`
3. **Rust 侧**：
   - 仿照现有的 `local_tts_*`，加安装和删除命令。
   - 启动 sidecar：
     - 端口：绑定 `127.0.0.1:0`，让系统分配空闲端口；
     - 启动参数：随机的 `--api-key`、`--threads` 设为物理核数、`--inference-buffer-policy dedicated`；
     - Windows 用 `CREATE_NO_WINDOW` 加 Job Object，Linux 用 PDEATHSIG，保证主进程退出时 sidecar 也退出；
     - 等健康检查 `GET /v1/models` 通过后再接请求；空闲 5 分钟自动退出。
   - 新增命令 `cosyvoice_synthesize`：用 reqwest 调 `POST /v1/audio/speech`，返回 WAV。由 Rust 转发，前端不用处理 localhost 跨域和 CSP。
   - 第二期：改成流式，通过 Tauri `Channel` 推送 PCM16。
4. **前端**：
   - `NeuralEngine.kind` 增加 `'cosyvoice'`（`local: true`），复用现有的切句、预取和缓存。
   - 设置里加 `cosyvoiceVoice`，音色选择带试听；文案走 `t()`，中英字典都加。
   - 用 CosyVoice 时卸载 Kokoro，避免两个模型同时占内存。
5. **自动回退到 Kokoro**：
   - 安装后先跑一段约 8 秒的固定文本做基准，记录 RTF。**RTF > 1 时默认不启用实时朗读**，只开放「后台预生成」。
   - 运行时用最近 3 块的 EMA 估算 RTF。EMA > 0.95 且已缓冲的音频不足 1.5 秒，或者首块超过 8 秒，就在本章剩余部分切回 Kokoro，并提示一次。
6. **后台预生成模式**（针对 CPU 机器）：
   - 按章节在后台用低优先级合成，结果按 `hash` 缓存到磁盘，用户听到时直接播放。
   - 按 RTF 约 3 估算，1 小时的音频要合成约 3 小时，适合「睡前把明天要听的几章做好」。
   - 播放器优先读缓存，没有缓存的部分用 Kokoro 补上。

**工作量**：约 **10–14 人日**。
- 测速 spike：1.5–2 天，**先做**。
- CI 四平台编译和签名：2–3 天。
- 音色制作、RL 版转换和上传：1–1.5 天。
- Rust 包管理和 sidecar：2–3 天。
- 前端和回退逻辑：1.5–2 天。
- 跨平台测试：2 天。
- 另加：流式 +2 天；后台预生成 +2 天；用户自录音色 +3 天。

**风险**：
1. CPU 速度。本次实测 RTF 约 6.8，是最大的问题。
2. 移植项目很年轻，只有一位维护者，有截字、卡死的问题。
3. 模型本身会重复读或漏字，必须保留采样（不能用贪心解码）。
4. 构建链：C++20、`#embed`、ggml 版本要固定，glibc 基线要处理。
5. 下载的 sidecar exe 可能被杀毒软件误报；macOS 要处理 quarantine。
6. 8GB 内存的机器压力大。
7. 参考音色的授权。

---

## C. Kokoro 语音包的国内镜像

- **sherpa-onnx 官方没有提供模型包的国内镜像。** 文档只给了 GitHub 地址，「中国镜像」只针对 APK（[文档](https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html)）。
- 现用的 GitHub 地址：`https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2`，实测返回 200，364,816,464 B，digest 与代码里的常量一致。
- 下面是逐文件的镜像。**都没有原样的 tar.bz2**，用的话要改成逐文件下载并逐个校验 sha256：
  - hf-mirror：`https://hf-mirror.com/csukuangfj/kokoro-multi-lang-v1_1/resolve/main/model.onnx`，返回 200，325,631,784 B（voices.bin 53,790,720 B）。实测会 302 跳到 `us.aws.cdn.hf.co`，大陆访问效果〔未核实〕。
  - ModelScope（第三方镜像）：`https://modelscope.cn/models/HZZSCIENCE/kokoro-multi-lang-v1_1/resolve/master/model.onnx`，返回 206。model.onnx、voices.bin、lexicon-zh.txt 的 sha256 都和 HF 一致；另一个镜像 `finchxu/kokoro-multi-lang-v1_1` 也一致。
  - int8 版：`https://modelscope.cn/models/liaowenbin/kokoro-int8-multi-lang-v1_1/resolve/master/model.int8.onnx`，返回 206，114,299,010 B，与 HF 一致。
  - ⚠️ `journey0ad/kokoro-multi-lang-v1_1` 是 2025-03 的旧导出，sha256 不一致，**不要用**。
- **建议**：在 yzfly 自己的 ModelScope 仓库（或上面 A 节的 GitCode 仓库附件）放一份**原样的** `kokoro-multi-lang-v1_1.tar.bz2`（365MB）。这样 sha256 不变，现有校验代码不用改，只要把下载 URL 改成镜像优先、GitHub 兜底。第三方镜像随时可能被删，只适合作为第二备份。

---

## 附：本次生成的样本

目录：`/tmp/claude-1000/-home-ubuntu-workspace-LightRead/47bd3643-15fa-4797-96b1-38080a310901/scratchpad/tts-samples/`。与在线音色样本使用同一段 176 字文本，详细数据见 `samples.json`。

- `local-cosyvoice3-q8-cpu-clone-hsiaochen.mp3`：整段文本，Q8，CPU，用曉臻的参考句克隆。
- `local-cosyvoice3-q8-cpu-short.mp3`：37 字短句，Q8。
- `local-cosyvoice3-q4km-cpu-short.mp3`：37 字短句，Q4_K_M，用来对比量化损失。

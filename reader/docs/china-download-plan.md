# 国内下载加速方案（待确认）

> 2026-10-05。问题：GitHub Releases 的安装包（`objects.githubusercontent.com`）在国内常常很慢或下不动；应用内「检查更新」也走 `api.github.com` 与 GitHub 下载地址。目标：发版后安装包同时出现在国内能直连、速度可接受的地方，用户和应用内更新都能用，不用翻墙。

## 1. 现状

- 安装包：每个版本约 12 个文件，单个 16–105MB（Android APK 约 70MB，Linux AppImage 约 105MB）。
- 应用内更新：查 `api.github.com/.../releases/latest`，再下载 GitHub 资产。
- 我们已有的基础设施：Cloudflare 账号（域名 jiangshu.ai）、R2 对象存储（背景音素材已托管在 `lightread-assets.jiangshu.ai`）、`get.jiangshu.ai` 分发 Worker（江树 CLI 在用）。

## 2. 可选方案

| 方案 | 国内速度 | 费用 | 门槛 / 限制 | 自动化 |
|------|---------|------|------------|--------|
| **A. Cloudflare R2 镜像**（`dl.jiangshu.ai`） | 不被墙、能直连；但免费版 Cloudflare 在国内走海外节点，速度看运营商和时段，一般好于 GitHub，不保证快〔需实测〕 | 出流量免费，存储每月 10GB 内免费（每版约 400MB，保留最近几个版本即可） | 无；已有账号 | 容易：发版 CI 最后一步上传 |
| **B. 国内对象存储**（阿里云 OSS / 腾讯云 COS，**内地地域**，用存储桶默认域名） | 快且稳定 | 按流量计费，约 ¥0.5/GB：APK 70MB × 1000 次下载 ≈ ¥35/月；用 CDN 约 ¥0.2/GB | 需要实名的云账号；**jiangshu.ai 是 .ai 域名，无法在国内备案**，所以不能绑自己的域名，只能用 `xxx.oss-cn-hangzhou.aliyuncs.com` 这类默认域名（阿里云默认域名对部分文件类型会强制下载，安装包正好需要下载，影响不大） | 容易：CI 用对象存储的 API 上传 |
| B'. 香港地域的 OSS / COS | 比 R2 稳，略逊于内地 | 流量价略高 | 不需要备案，可以绑 jiangshu.ai 子域名 | 同上 |
| C. Gitee 发行版 | 快 | 免费 | 单个附件限制约 100MB（AppImage 超了）、仓库附件总量有限，近年对开源仓库审核严格 | 难：需要单独的同步脚本，常受限 |
| D. 蓝奏云 / 123 云盘等网盘 | 快 | 免费 | 单文件大小限制、需手动上传或用非官方接口、链接可能失效，体验和可信度一般 | 难 |
| E. 第三方 GitHub 加速代理（ghproxy 等） | 不稳定 | 免费 | 第三方随时失效，且有被替换文件的安全风险 | 不推荐 |

## 3. 推荐

**先上 A，按实测结果决定要不要加 B。**

1. **A：发版时自动镜像到 R2**
   - 发版 CI 在 GitHub Release 公开后，把同一批安装包、`SHA256SUMS`、APK 报告上传到 R2，地址形如 `https://dl.jiangshu.ai/lightread/v1.7.2/LightRead_1.7.2_x64-setup.exe`，并维护一个 `latest.json`（版本号、各平台文件名、大小、SHA256）。
   - 提供一个简单的国内下载页 `https://dl.jiangshu.ai/lightread/`（列出最新版各平台安装包和校验值），README 顶部加「国内下载」链接。
   - **应用内更新**：先查 `dl.jiangshu.ai` 的 `latest.json`，从镜像下载；镜像不可用时自动回退 GitHub。下载后照常用 SHA256 校验，镜像被篡改也装不上。
   - 只保留最近 3 个版本，存储远低于免费额度；出流量免费。
2. **如果实测 A 在国内仍慢**：加 B（阿里云 OSS 杭州或腾讯云 COS 广州，默认域名），CI 同时传一份；下载页和应用内更新优先走 B，再 A，再 GitHub。费用按上面估算，几十元 / 月量级。

## 4. 先实测（不用等我开发）

请在国内网络（不开代理）下打开下面这个已托管在 R2 上的 5.5MB 文件，看下载速度：

`https://lightread-assets.jiangshu.ai/ambient/v1/piano-chopin-nocturne-op9-2.5230038e.ogg`

- 能跑到每秒 1MB 以上：A 就够用。
- 很慢或时断时续：建议 A + B。

## 5. 需要你确认

1. 先做 A（R2 镜像 + 国内下载页 + 应用内更新优先走镜像）？
2. 如果实测慢，是否接受国内对象存储（需要一个实名的阿里云或腾讯云账号，费用约几十元 / 月），用哪家？
3. 下载页域名用 `dl.jiangshu.ai` 可以吗？

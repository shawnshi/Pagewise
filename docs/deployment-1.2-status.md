# 1.2.0 构建与安装记录

日期：2026-10-20。当前状态：**Release / Debug 1.2.0 均已打包、原位安装，并完成启动及部署验收；两个版本共存。** 本记录不是商店发布或 GitHub Release 公告。

## 交付身份

| 项目 | Release | Debug |
|---|---|---|
| 包名 | `io.pagewise.reader` | `io.pagewise.reader.debug` |
| 启动器 / Activity 标签 | 知页 1.2 | 知页 1.2 试版 |
| versionName / versionCode | 1.2.0 / 1002000 | 1.2.0 / 1002000 |
| debuggable | false | true |
| ABI | arm64-v8a | arm64-v8a |
| APK 字节数 | 74,443,786 | 306,521,283 |
| 本地产物 | `artifacts/Pagewise-1.2.0-release.apk` | `artifacts/Pagewise-1.2.0-debug.apk` |

APK SHA-256：

- Release：`a6a607b1c81afa8076a3fc5228f0671822f8dcdabf0e8587040d5918d5a91668`
- Debug：`f1e3bf4037d170b49d6dfa7975f77b230b5ea5edbec1bff3619ba36cf23f5ddc`

两包使用设备既有证书，SHA-256：`9b0f56619d62232588818c64083536bcbb3ae9182593b3610f67ef3c13f472a3`。使用现有 AGP signingConfig 的本地签名连续性，不是生产发布签名方案建议；没有生成新密钥，也没有将口令或私钥写入脚本、参数或日志。

## 本轮源改动

- 五处根版本同步为 1.2.0：package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json。依赖图未升级。
- 新增 `reader/scripts/prepare-android-variants.mjs`：保留基础品牌“知页”，为 debug / release 写独立资源 overlay；确保 Debug 后缀 `.debug`，写入一致的版本属性。验证失败不写入，提交失败可回滚，回滚失败明确保留恢复目录。
- Android prepare / dev / build / release npm 入口均包含 variant 准备步骤。
- 新增 `reader/scripts/test-android-variants.mjs`：版本、标签、共存身份、幂等、异常与回滚验证。
- 包内包含前一阶段的原生设备环境、窗口生命周期、SAF 流式暂存和文件发布修补；不将这些再次计算为本轮新增功能。

## 构建与校验

- 使用已安装 JDK 21、NDK 30.0.16248370、Android SDK；没有修改全局 Java / SDK 配置，没有下载或升级依赖。
- 前端完整类型检查与 production build 通过；Rust 两种 profile 均重新构建，并封存本次库摘要。
- Release 首次冷编译触及 150 秒阶段预算，保留日志后以已经完成的依赖缓存继续一次成功；没有延长写入预算或降低优化等级。
- Cargo 重写了生成工程中的依赖 registry 路径。接受路径变化前，核对 139 个 Android 依赖源文件逐字节相同；完整恢复点仍保留。
- Gradle 按 Kotlin、R8、assemble 分阶段构建。仅跳过本次已完成且有源码 / JNI 摘要绑定的 Rust hook；没有把旧库装入新包。
- 两份 APK 均验证 ZIP CRC、包名、版本、标签、ABI、debuggable、证书、JNI 摘要及新原生桥方法。
- 178 项回归通过；variant 故障与幂等验证通过；另有 7 项部署门测试，验证缺证据拒绝 release、证据绑定与探针异常清理。
- 原生成 JNI 符号链接已恢复。临时签名/NDK/依赖构建目录设置仅位于本次 init script，不留在应用 Gradle 配置或全局环境。

## 安装门及数据边界

用户明确授权在当前 Note X3 Pro 上覆盖部署两包，保留应用数据，不卸载或清数据。安装前备份两个已装 1.1.0 APK、证书摘要、UID、首次安装时间与私有数据目录 inode；没有读取或导出书籍、批注、书库或账户设置。

两个原包此前均为 `enabled=3`。本次只允许启用这两个目标包进行启动检查，不改变 BOOX 全局冻结规则。

Release 必须等 Debug 的安装、前端 ready、真实原生环境调用与探针关闭回执齐全后才能安装；回执绑定当前 Debug APK 摘要和目标设备。安装后检查 UID、firstInstallTime、ceDataInode、dataDir 不变及设备 APK 摘要一致。身份保留检查不等于逐书内容审计。

初轮独立复核阻止了未强制 Debug 先行验收和未绑定原生运行态结果的部署门；修复经第二轮独立复核为 `OK with notes`，两项 P1 已解除。Node 连接清理的 P2 随后由主代理修正并通过 4 项故障注入测试，没有冒充再次独立复核。Debug 实际运行回执取得并通过门后才安装 Release；不能用进程存在或 DEX 方法名代替原生桥调用。

## 当前实机结果

- 两包均同证书原位覆盖安装，设备 APK SHA-256 与交付文件一致，versionName=1.2.0 / versionCode=1002000。
- 两包 UID、首次安装时间、私有数据目录 inode 和 dataDir 均与安装前一致。未卸载、未清数据；这不是逐书内容审计。
- 仅启用两个原先被禁用的目标包；最终检查均为 enabled=1，没有修改全局冻结策略。
- 两包冷启动均收到前端 + 原生的数值 ready 信号，随后显式以 PERF_PROBE=false 普通重启。Release 最终进程无探针样本；Debug 实际桥调用确认探针已关闭。
- Debug 通过仅连接该包 PID 的本地 CDP，实际调用 Tauri app/version，返回 1.2.0；调用 getReaderEnvironment 返回 version=1、boox=true、lowRam=false、memoryClassMb=256。确认应用已渲染且使用内置 tauri.localhost 来源，不依赖开发服务器。
- Release 的 debuggable=false，最终实际进程不存在 WebView 调试 socket。Debug 验证用的临时 forward 已回收，没有删除其他转发。
- 一次带探针的 Activity 启动 TotalTime：Debug 990ms、Release 484ms。仅为本次启动样本，不是翻页、书籍打开尾延迟或屏幕显影结果，也不能作前后性能比较。
- 签名容器元数据未变；只保留公开证书摘要，不读取或保存私钥内容。最终验收回执：`.cache/deployment-1.2-20261020/deployment-acceptance.json`。

本次部署不等于完整 BOOX 性能、阅读或 SAF provider 验收。`docs/android-native-roadmap.md` 中首轮“未打包/未安装”的描述是其离线验收时点；当前安装状态以本记录为准。

## 恢复与残留验收

- 源码、生成配置和旧 APK 恢复点位于忽略的 `.cache/deployment-1.2-20261020/`；APK 位于忽略的 `artifacts/`。不上传签名容器、设备恢复文件或运行中间态。
- 不承诺旧 Release APK 可直接降级覆盖。必要恢复应使用既有证书、更高 versionCode 的旧代码恢复包，不以卸载或清数据回退。
- 真实书籍首开、翻页长尾、SAF provider 异常、TTS 长时间运行、面板显影与残影仍需专项验收。启动 / ready / 原生环境结果不能替代这些测试。
- 既有导出超时不取消 action、delete 未进入同一队列等限制仍见 `docs/android-native-roadmap.md`，本轮没有扩大修复范围。

# Pagewise 审计修补：阶段 1 交付

日期：2026-10-20。基线为 `baa1d761981dbb0e3e58287a262b9b5db46f866f` 加实施开始时的未提交工作树，非 clean HEAD。当前源码版本仍为 1.2.0；本轮没有打包、安装、发布 APK，也没有访问真实书库、账户配置或调整 BOOX 设置。

## 当前状态

| 审计项 | 状态 | 验收边界 |
|---|---|---|
| PW-A05 原生超时、提交与清理 | 已独立审查、集成 | 当前生产源码 JVM 场景、Android 类型编译和集成回归通过；真实 DocumentsProvider 与设备销毁仍未验证 |
| PW-A07 未知元数据重复扫描 | 已独立审查、集成 | 前台常规轮询复用成功结果；人工刷新、provider 通知及不可用记录强制复查 |
| PW-A02/A03/A04 备份身份、边界与失败语义 | 已独立复核、集成 | 容量回归修正获准后集成，30/30 主工作树测试及浏览器往返通过 |
| PW-A01 正文安全隔离 | 已独立复核、集成 | 原始 CFI 校验、旧 HTML/SVG 锚点及安全内容浏览器回归通过，无兼容性豁免 |
| PDF 主线程准备、系统文件打开、版本变化提示及其他 P2 | 后续切片 | 不冒称本轮已完成 |

本阶段已完成上述有界源码切片的集成及主机/浏览器验收，不代表全部审计建议实施完毕，也不是 BOOX 真机认证或 APK 发布。保留此前未提交改动，没有提交或推送代码。

## 已集成语义

### 正文安全与旧位置兼容

- 正文在导航进 iframe 前完成净化和局部 CSP 设置，默认阻止脚本、事件处理、嵌套主动内容及远端资源请求；仍保留排版、受控本地资源和选择所需的 DOM。
- 通过每书/每节的可信文档登记，将安全 SVG 包装映射回原始 SVG-root CFI 坐标；HTML 保持原有委派。没有重写用户保存的位置/批注，也没有最近位置回退。
- 使用实际冻结的 Foliate View/CFI 与原始 SVG 渲染生成旧锚点，再验证新阅读器的生成、恢复、范围、导航和重载；覆盖 ID-less HTML、转义 ID、多节点、Unicode、合法空相对端点和书脊断言。
- 在有损解析前拒绝重复/偶数节点字符偏移、非终端限定符及错误断言。18 项畸形输入与 8 项真实旧边界范围通过定向浏览器验证；不把它们累加成独立 Node 测试。
- 集成时重现的分页器卸载竞态另有最小修补：根节点或窗口已消失时不调用 `getComputedStyle`。确定性负例、修补后零页面异常和原有 100 次翻页生命周期测试均通过，并独立复核该差异。
- 不宣称完整 KF8 或所有 WebView 认证；fixed-layout 的证据覆盖真实范围/Overlayer 几何，不冒充修复了上游缺失的完整批注 UI。

### 原生导出与私有文件发布

- 操作状态区分取消前、提交边界和提交结果未知；排队超时的任务不能迟到执行。
- 流式复制在取消检查点停止；跨文件系统复制仍暂存于目标目录后原子替换。
- 删除操作与写入在同一执行器串行化，保留既有路径白名单、单块和总字节上限。
- 可能已产生外部写入的失败明确返回 `outcome_unknown`，不能当成“确定未写入”或自动重试。
- 不承诺中断不合作 provider 的阻塞 I/O；无法证明没有提交时保留结果未知。

### 备份身份、容量与恢复结果

- 同名书籍仅在实际内容一致后合并，避免把另一版本的批注绑定到现有书籍。
- 导入在写入前检查 ZIP 结构、路径、解压预算、CRC 及载荷；导出按相同预算计算完整 ZIP 开销，不能成功生成自身无法恢复的包。
- 当前有界切片：ZIP 不超过 64 MiB、总展开载荷不超过 128 MiB、单项不超过 64 MiB、元数据不超过 4 MiB、最多 2,048 条目，另有中央目录和路径预算。Markdown 书籍载荷与元数据按引用角色区分，不因 `.md` 后缀一概限制到 4 MiB。
- 超限导出明确失败，受控原生调用方不发布该临时包；两本 33 MiB 书籍的拒绝、恰好 64 MiB 及 2,048 条目的可恢复边界均有真实生产函数测试。
- 旧 WebView 缺少 `DecompressionStream('deflate-raw')` 时，压缩旧包明确拒绝并提示升级 WebView（若设备允许）或在受支持环境重新生成未压缩包；不静默使用不可靠降级。当前未压缩导出仍可恢复。
- 阅读记录等附属数据失败不再隐去；中途失败返回已确认的恢复进度，不宣称跨文件/数据库整体回滚。尚无持久恢复日志或 UI 取消控件。
- 展开载荷预算不是总进程内存上限，真实 BOOX 峰值仍需测试。大库需要拆分归档，不能据此宣称任意大小备份已支持。

### 书库自动复查

未知大小/修改时间且描述符未变、可用状态正常的文件，成功解析结果最多复用五分钟，缓存不超过 5,000 项，仅在当前控制器会话内存在。失败不延长成功缓存；目录变化及停止会清理缓存。手动刷新、provider 通知、描述符变化及不可用记录绕过缓存。

五分钟是**允许执行扫描时**的复查间隔，不是后台、阅读期间或 provider 阻塞时的墙钟保证。未收到通知的内容变化可能延迟到后续自动复查才被发现；需要即时核验时使用手动刷新。此项不改变书籍身份、CFI 或批注映射，也不证明 BOOX 实际耗电下降。

## 已执行验证

| 检查 | 实际结果 | 不证明什么 |
|---|---|---|
| 未知元数据负例 | 原版四次轮询累计读取五次，违背复用断言 | 不是目标机耗时或耗电测量 |
| 新增扫描控制器测试 | 6/6，通过缓存到期、强制复查、权限、失败、生命周期及容量边界 | 依赖时钟/provider 为受控替身 |
| 书库/存储集成 | 19/19，通过实际浏览器、Dexie 和 SQLite 适配链路 | 不访问真实用户库 |
| SAF 前端适配器 | 14/14，通过 | 不等于真实 provider 故障认证 |
| 主工作树备份容量/恢复 | 30/30，通过；浏览器/IndexedDB 往返与版本隔离通过 | 非真实设备；不等于大库无限恢复 |
| 主工作树原生集成套件 | 12/12，通过 | 包含源契约与行为测试，不能把数量当作设备认证 |
| 生产 Kotlin JVM 生命周期 | 上述套件内 17 场景，零失败 | Android、Handler、provider 与 OS 边界使用受控替身 |
| 原生文件提交 | 上述套件内 42 条断言，通过 | 缩放字节上限及文件系统故障注入，非真实设备 |
| 当前 Kotlin 对 Android 36 / AndroidX / Tauri 编译 | exit 0 | 不是完整 APK、安装或真机测试 |
| 正文安全、旧 SVG CFI、卸载根节点及原分页器生命周期 | 各 1 项 Node 浏览器测试通过；另有头部/CFI 定向浏览器脚本通过 | 合成输入，非实体 BOOX |
| 集成 App / Node 类型检查 | 均 exit 0 | 包含最终安全与生命周期修补 |
| 集成隔离 Vite production build | exit 0 | 保留 MuPDF browser-external 等既有警告；不是 APK |
| 主动 LSP | 原生套件 JS 检查无 error；Kotlin 和部分 TS 为未确认 | 不以静默作为 clean，类型/编译以上述实际结果为准 |

共 85 项不同的 Node 测试通过；已在安全集成后重放书库/存储 19 项及备份浏览器往返。17 个原生生命周期场景、42 条提交断言、18 项畸形 CFI 和 8 项旧范围属于嵌套验证，不另行累加为独立 Node 测试。

## 独立审查与证据

首轮 `independent_review_completed: true`。结论为整体 BLOCK：原生与扫描可独立集成，备份因容量回归被阻止，安全因旧 SVG CFI 未兼容被阻止。没有把局部通过写成整体完成。

备份容量修正的后续独立复核为 `OK with notes`，原 P1 已解除，未发现新问题。只在当前文件摘要与复核快照一致后集成。首次主树测试命令因工作目录错误失败，保留日志后改用 `reader/` 目录，30 项全部通过；没有通过修改生产逻辑掩盖调用错误。

安全候选第一次独立审查阻止了 HTML 头部占位及有损 CFI 校验问题。第二次复核确认头部占位、重复偏移与书脊断言已有修正，但发现偶数节点字符偏移仍可被规范化丢弃，且新增原始语法门误拒绝旧版生成的合法空相对端点范围，因此仍为 BLOCK。

该有损校验缺陷按稳定 ID `P1-CFI-LOSSY-01` 保持原计数，最终修复后只做只读独立复核，结论为 `OK`，此前报告的兼容性 P1 均解除。开发进程最后超时，但六项命令及交接制品在超时前写完；父代理核验稳定字节，reviewer 检查实际代码/负例/回执后才批准，没有把进程超时报告成成功，也没有再延长开发或接受旧锚点损失。

主树内容测试随后捕获已记录的空根节点生命周期错误。父代理先以真实 Paginator 确定性重现，再仅补根/窗口前置条件，不改 CFI 和安全语义；独立 reviewer 对此精确差异批准。原失败日志保留，未通过放松 `pageerror` 断言或无修改重跑制造通过。

原生分支的初始回执与后续文件字节不一致。原始证据已保留，父代理重新核验当前文件，执行对应编译/测试，并记录前后稳定摘要；独立 reviewer 据此解除原生 freshness 阻塞。旧回执不再作为当前批准依据。

本地证据根：`.cache/audit-remediation-20261020-01/`：

- `baseline.json`、`baseline/`、原始 staged/unstaged diff：精确恢复基线。
- `independent-review-1.md`：首轮独立审查原件副本。
- `native-current-verification.json`、`native-current-*.log`：当前原生文件验证。
- `native-integrated.log`：主工作树集成后验证。
- `independent-review-archive-2.md`、`archive-capacity-freshness.json`：容量修正独立复核及精确快照。
- `archive-integrated-fixed-cwd.log`、`archive-browser-integrated.log`：当前备份集成验证；首次调用错误保存在 `archive-integrated.log`。
- `integrated-hashes.json`、`final-acceptance.json`：最终集成源文件/测试及验证摘要。
- `integrated-presecurity-acceptance.json`、`app-presecurity-typecheck.log`、`node-presecurity-typecheck.log`、`build-presecurity.log`：不含安全候选的集成编译与构建。
- `security-review-1.md`、`security-review-2.md`：安全分支阻塞项独立原件副本。
- `security-retry-ledger.json`：稳定问题 ID、最终只读复核及禁止兼容性豁免的边界。
- `security-review-final.md`、`paginator-lifecycle-review.md`：最终安全和主树生命周期独立批准。
- `security-final-freshness.json`、`paginator-lifecycle-receipt.json`：冻结制品与实际执行绑定。
- `security-review-final.log`、`security-svg-final.log`、`security-content-after-lifecycle.log`：主树正文安全与旧锚点验收。
- `detached-root-before.log`、`detached-root-after.log`、`paginator-lifecycle-final.log`：卸载竞态负/正例。
- `app-final-typecheck.log`、`node-final-typecheck.log`、`build-final.log`：最终组合检查。
- `folder-before.log`、`folder-after.log`、`folder-storage.log`、`folder-adapter.log`：扫描修补证据。
- `concurrent-drift.json`：期间发生的无关文档/图标变化，未用旧基线覆盖。

## 复验入口

从仓库的 `reader/` 目录按顺序执行。使用已安装的 Node.js 24+、项目依赖及本机 Android/Kotlin 工具链；缺少工具时明确失败，不自动安装。测试使用合成输入和独立浏览器上下文，不连接实际书库；保留需要比较的旧日志，避免同一测试目录并发写入。

```sh
node --test scripts/test-folder-recheck.mjs scripts/test-monitored-folder.mjs
node --test scripts/test-folder-library-storage.mjs
node --test scripts/test-native-export-lifecycle.mjs scripts/test-native-export-commit.mjs scripts/test-archive-export.mjs scripts/test-android-native.mjs
node scripts/test-native-export-lifecycle.mjs --android
node --experimental-strip-types --experimental-vm-modules --test scripts/test-archive-capacity.mjs
node scripts/test-bounded-archive-browser.mjs
node scripts/test-security-review-browser.mjs
node --test scripts/test-svg-legacy-cfi-browser.mjs
node scripts/test-book-content-security-browser.mjs
node --test scripts/test-paginator-detached-root.mjs scripts/test-paginator-lifecycle-browser.mjs
```

旧锚点测试需要本轮保留的 `.cache/audit-stage1/svg-repair-baseline.json` 及 `svg-repair-baseline/` 冻结制品，并逐字节检查安装的 Foliate。新环境必须提供相符原始基线，缺失时明确失败，不得从修补后实现伪造“旧版”或跳过断言。浏览器测试需要本机已有的支持版本浏览器；不要通过自动下载浏览器或读取个人配置替代缺失前提。

## 恢复与剩余验收

恢复只针对本轮精确差异：先核对当前文件是否仍匹配本轮集成摘要，再从冻结基线撤回对应修改；新增文件仅在摘要仍匹配时移除。不得 reset、stash 或覆盖其他改动。当前没有部署回退或用户数据迁移。

本阶段的有界源码切片已完成；PDF 主线程准备/总内存、系统 `content://` 打开、源版本变化提示、笔记独立归档/大库分卷及持久恢复日志仍是后续切片，不冒称全部审计问题闭合。真实 BOOX 的连续阅读、息屏 TTS、SAF 异常、物理残影/清晰度、内存峰值和耗电另行验收，不由本轮宿主结果推导。

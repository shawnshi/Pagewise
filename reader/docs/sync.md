# 多端同步协议

轻阅的多端同步是可选的，本地库始终是权威副本。后端可以换（第一步是 WebDAV，第二步是轻阅账号），协议只有一套。

## 设计要点

- **状态型同步，每台设备只写自己的文件。** 每台设备把「自己眼里的完整同步状态」写成 `devices/<deviceId>.json`，合并时读所有设备的文件取并集。WebDAV 没有可靠的锁，只写自己的文件就不会互相覆盖。
- **合并规则是纯函数，满足交换律、结合律、幂等**（CRDT 思路），同步多少次、以什么顺序同步，结果都一样。
  - 普通记录：LWW 寄存器（`{ value, stamp }`，`value === null` 表示已删除，即墓碑）。
  - 书的阅读时长：G-Counter（`reading[deviceId] = 该设备累计贡献的秒数`，总时长为各设备之和，合并时每台设备取较大值）。
  - `stamp = { t: 毫秒时间戳, d: deviceId }`，先比 `t`，相等时比 `d` 的字典序；stamp 完全相同（理论上不会发生）时按值的稳定序列化决胜，保证交换律。
- **书的身份是文件内容的 SHA-256**（`hash`）。各设备本地的 `BookMeta.id` 不同，同步层只认 hash。标注、书单、书源的 ID 是全局 UUID，应用到别的设备时**沿用原 ID**。
- **本地改动靠 diff 得出**：同步时把「当前本地状态」和「上次同步后保存的基线」逐条比较。有变化的记录打上新 stamp；上次在本地、这次不见了的记录生成墓碑。这样不需要改动业务代码的每一处写入。规则细节见下文「本地文档的生成」。
- 基线丢失（清缓存、重装后从旧备份恢复），或换到同类的另一个远端（另一个 WebDAV 地址 / 另一个账号；账号与 WebDAV 之间共用同一份基线）时视为首次同步：**远端优先**，本地只补上远端没见过的记录，本地有的书不会被删，旧备份也不会盖掉别处更新的改动。
- **规范化**：可选字段 `undefined` 与空串 `''` 视为同一个值（都去掉）；元数据补齐缺省值（`kind: 'book'`、`pinnedAt: 0`、`tags: []`），标注 `kind` 缺省为 `highlight`。判等用键序无关的结构比较。

## WebDAV 服务商（设置页）

设置页先选服务商，再填账号与（应用）密码，点一次「连接」完成：PROPFIND 校验（只认 207）→ 保存 → 打开自动同步 → 立即首次同步。校验失败不保存配置。数据见 `src/services/webdavProviders.ts`，`settings.webdavProvider` 记住选择（老配置为空时按 `webdavUrl` 识别）。

| 服务商 | 地址 | 账号 / 密码 | 来源 |
|---|---|---|---|
| 坚果云 | `https://dav.jianguoyun.com/dav/`（固定，不显示） | 注册邮箱或手机号 / 应用密码（网页「账户信息 → 安全选项 → 第三方应用管理」，直达 `https://www.jianguoyun.com/#/safety`） | help.jianguoyun.com/?p=2064 |
| Koofr | `https://app.koofr.net/dav/Koofr`（固定） | 登录邮箱 / 应用密码（`https://app.koofr.net/app/admin/preferences/password`） | koofr.eu 帮助中心 |
| 自建 | 用户填；只填域名时依次探测 `/`（群晖 WebDAV Server）、`/remote.php/dav/files/<用户名>/`（Nextcloud / ownCloud）、`/dav/`（Alist） | 用户名 / 密码或应用密码 | 各项目文档 |
| 其他 | 用户填完整地址 | — | — |

InfiniCLOUD 每个账号的 WebDAV 节点不同（`https://<节点>.teracloud.jp/dav/`），地址不固定，归入「其他」。

网页版：坚果云、Koofr 经轻阅同步服务中转（见 `docs/account-api.md`「WebDAV 中转」）；其他地址要求服务器开启 CORS，或在「网络」里配置跨域代理，否则提示改用桌面 / 手机 App。

## 远端布局（WebDAV）

```
<webdavUrl>/LightRead/
  lightread-backup.zip           旧的整库备份, 保持不变
  sync/v1/
    devices/<deviceId>.json      每台设备的 SyncDoc
    files/<hash>                 书籍文件 (按内容寻址, 只传一次)
    files/<hash>.cover           封面 (jpeg)
```

## 记录与键

| 集合 | 键 | 值 | 冲突规则 |
|---|---|---|---|
| books | 内容 hash | `meta`（书名/作者/格式/文件名/简介/语言/标签/加入时间/归属/来源/置顶，`pinnedAt: 0` 为未置顶）、`progress`（location/progress/lastReadAt）、`reading`、`alive` | `meta`、`progress`、`alive` 各为独立的 LWW 寄存器；`progress` 的 stamp.t 取 `lastReadAt`，从未读过取 0（读得最晚的赢，而不是同步得最晚的）；`reading` 为 G-Counter |
| annotations | 标注 id | 完整标注，`bookId` 换成 `bookHash` | LWW |
| booklists | 书单 id | `{ name, createdAt }` | LWW |
| booklistItems | `${booklistId}\|${bookHash}` | `{ booklistId, bookHash, addedAt }` | LWW |
| booklistWanted（可选） | 待找条目 id | 书单里还不在藏书中的书 `{ booklistId, title, author, isbn?, year?, note?, originalTitle?, originalAuthor?, addedAt }`（见 `docs/booklists.md`） | LWW；旧客户端的文档没有此字段，合并时视为空 |
| sources | 书源地址的规范化形式 `sourceKey(url)` | 自定义书源 / 私人书库 `{ title, url, kind, addedAt, username?, password? }`（含鉴权，内置书源不同步） | LWW，stamp.t 为该书源**最后一次被修改的时间**（`updatedAt`），见下文「私人书库（自定义书源）」 |
| readingLog（可选） | `设备 id → 日期 YYYY-MM-DD → 书的 hash` | 该设备当天在该书上贡献的秒数 | G-Counter：逐叶取较大值 |
| settings（可选） | 设置路径，如 `reader.fontSize`、`webdavUrl` | 该项的值 | LWW，stamp.t 为该项**最后一次被修改的时间**，见下文「设置同步」 |

## 设置同步

用户在一台设备上改的阅读、外观、听书、AI、WebDAV 等设置随同步（WebDAV 与轻阅账号都走同一套文档）带到其他设备。实现：`src/services/sync/settingsSync.ts`（纯函数）、`settingsTracker.ts`（记录修改时间）、engine 的 `settings` 端口。

- **开关（按设备，本身不同步）**：`settings.syncSettings`（默认开）关闭时本机既不发出也不落地设置，但写自己的文档时照样转写别的设备的设置；`settings.syncSecrets`（默认关）控制本机是否把密钥写进文档。
- **粒度**：每个设置路径一个 LWW 寄存器，嵌套对象按子键（`reader.*`、`pdf.*`、`readingMode.typewriter.*` …）；数组 / 字典型的值（`githubBookRepos`、`ambient.layers`、`dianjing.kinds`）整体 LWW。
- **stamp = 修改时间，不是同步时间**：`settingsTracker` 深度监听可同步的值，变化时记 `t = max(现在, 已知 t + 1)`（时钟偏慢也能盖过刚收到的值），存 localStorage `lightread-settings-sync`。第一次见到某项时：与默认值相同记 0（从没改过，不写进文档，任何设备的值都能盖过它），否则记 1（改过但不知何时：胜过默认值，输给之后的任何修改）。不依赖基线，所以关掉再打开「同步设置」、换远端都按修改时间收敛。
- **本机文档** = 基线里已知的设置 ∪ 本机各项（修改时间 > 0 的，`stamp.d` 为本机；从别处收到的沿用来源的 stamp，与来源文档完全一致）。
- **落地**：只落白名单路径，且合并结果的 stamp 新于本机的修改时间、值的类型与本机相符。落地时同时更新本机的修改时间与快照，所以收到的值不会被当成本机修改再发出去（不会来回打架）。同步前一刻还没被监听记下的修改，端口 `read()` 会先补记。
- **密钥**（`webdavPass`、`aiApiKey`）：只有发送方开启 `syncSecrets` 时才写进文档。**缺席表示不变**：合并是按路径取并集的 LWW，没带密钥的设备不会删掉远端已有的值（它写自己的文档时还会原样转写）。接收方不论自己是否开启，远端有且更新就落地；本机改了却没发出去的密钥修改时间更晚，不会被远端旧值盖回。密钥在同步端是明文（WebDAV 文件 / 账号服务的 R2），所以默认关闭。关掉 `syncSecrets` 不会抹掉已经发出去的旧值。
- **预设**（大字 / 夜间 / 护眼 / 歌词 / 墨水屏，`readingMode.presets`）临时改的键按开启前的值同步：被预设管着（当前值等于最上层预设写入的值）的 `reader.*` / `readingMode.typewriter.*` 读最底层预设的 `before`，落地时也写进这个 `before`，预设关闭时恢复到同步来的值。开关预设、夜间定时都不算修改设置，不会传到别的设备。
- **登录新设备**：`syncNow` 先同步账号，**之后**才判断 WebDAV 是否可用，所以账号带来的 WebDAV 配置在同一次同步里就能用上。`webdavSyncConfigured()` 要求地址已填，且填了账号时也有密码——发送方没开 `syncSecrets` 时只来了地址和账号，此时不去连 WebDAV（不报认证失败），等用户在本机补上密码。
- WebDAV 配置是普通同步项：在一台设备上换了服务商 / 地址 / 账号，其它设备随之改变（LWW）。**断开只影响本机**：本机 `webdavUrl` 为空时，WebDAV 连接的几项（地址、账号、服务商、密码）都不写进文档，别的设备照常使用；之后别处换了新配置仍会过来。地址换了时连接的几项**整组落地**（远端有的账号 / 服务商 / 密码跟着新地址一起，即使本机修改时间更晚），免得新地址配上本机的旧账号。换到另一个 WebDAV 地址时基线对它作废，按首次同步处理（只并集）。
- 旧客户端会忽略 `settings` 字段并在写自己的文档时丢掉它，不影响别的设备的文件（同 `readingLog`）。新客户端加的、本版本不认识的路径照样合并转写，但不落地。

### 同步与不同步的设置

归类表是 `SETTINGS_SYNC_SPEC`（与 `SettingsState` 同构）；新增设置项必须在里面归类，`scripts/test-sync-settings.mjs` 会检查。

| 归类 | 设置 |
|---|---|
| 同步 | `language`、`appearance`；`reader.*`（字号、行距、页边距、主题、排版方式、栏数、字体名、两端对齐、字距、进度显示）；`pdf.*`；`githubBookRepos`；`autoReadSeconds`；`ttsRate`、`edgeVoice`、`localVoiceId`；`aiProvider`、`aiBaseUrl`、`aiModel`；`webdavUrl`、`webdavUser`、`webdavProvider`；`dailyGoalMinutes`；`dianjing` 的 `level`（点睛阅读选的版本）、`enabled`、`consentAll`、`density`、`kinds`、`channel`、`chapterCard`；`readingMode` 的 `typewriter.*`、`lyric.*`、`wordGuide.*`、`immersive.*`、`eyeCare.*`、`night.*`；`ambient.*` |
| 密钥（仅 `syncSecrets`） | `webdavPass`、`aiApiKey` |
| 只属于本机 | `version`；`customFonts`（字体文件在本机）；`libraryRoot`、`calibrePath`（本机路径）；`httpProxy`、`corsProxy`（网络环境）；`paperAgentEngine`、`paperAgentExecutables`（本机安装的引擎）；`ttsEngine`（本地离线音色要下载模型，网页没有）、`ttsVoice`（系统音色因系统而异）；`usageStats`（关掉的设备不会被别处打开）；`syncSettings`、`syncSecrets`；`webdavSyncAuto`、`webdavSyncFiles`（自动同步、是否传书籍文件按设备）；`dianjing.perBook`、`dianjing.fiction`（键是本机书 id）；`readingMode.presets`、`readingMode.largeText`、`readingMode.eink`（预设开关与快照） |

书源（含 OPDS 账号密码）是书库记录，不属于设置，一直随 `sources` 同步，不受 `syncSecrets` 控制（理由见下一节）。

## 私人书库（自定义书源）

用户在「书源」页添加的自建 / 需登录的 OPDS 目录（calibre-web、自建书库等，`CatalogSourceRec`，`builtin: false`）随账号与 WebDAV 同步：在一台设备上添加、编辑、删除，其他设备同步后跟着变。内置书源（古登堡、arXiv）各设备自带，不同步。GitHub 书库（`githubBookRepos`）是设置项，随「设置同步」走（整体 LWW）。

- **身份 = 规范化地址** `sourceKey(url)`（`merge.ts`）：去掉地址里内嵌的 `user:pass@`、`#片段`、路径末尾的斜杠，协议与主机名小写、默认端口省略，查询串保留；不是 http(s) 地址时原样。两台设备各自添加同一个书库（大小写、末尾斜杠不同）合并后只剩一条。落地到本地的仍是用户填写的原地址（`value.url`）。同一地址不同账号视为同一个书库（较新的修改胜出），不支持在同一台设备上用多个账号挂同一个书库。
- **修改时间**：`CatalogSourceRec.updatedAt`（添加、编辑时记 `Date.now()`；老数据缺省按 `addedAt`）。它**不在值里**，只用作寄存器的 stamp.t，所以旧客户端看到的值不变、不会来回打架。
  - 有基线：值与基线相同沿用基线寄存器；变了的 `t = max(updatedAt, 基线 t + 1)`（时钟偏慢也能盖过它所基于的值）。
  - 首次同步（无基线）：远端有寄存器（含墓碑）时，本地值相同或 `updatedAt` 不比它晚就沿用远端；否则本地胜出（删掉之后又重新添加的会回来，旧副本不会盖掉别处更新的修改）。没有修改时间时退回「远端优先」。
  - 落地（`addSource` / `updateSource`）时把寄存器的 stamp.t 写成本地的 `updatedAt`。`updateSource` 原地改写规范的那一条（同一地址多条时取 `addedAt` 最早的），本地 id 不变（搜索范围、上传目标等按 id 记的状态保留）。
- **删除**：有基线、基线里存活、本地没有了 → 墓碑，stamp 为同步时间（不记录删除时刻）。墓碑会盖过删除之前的编辑；之后再添加（修改时间更晚）会复活。
- **与内置书源同地址**：别的设备同步来的、与本机内置书源同一地址的自定义书源不落地，也不因「本地没有」被当成删除（`LocalState.builtinSourceKeys`），原样转写。
- **账号密码**：书源的 `username` / `password` **始终**在记录里，不受 `syncSecrets` 控制。用户要的就是「换台设备书库直接能用」，没有密码的书源配置几乎没有用；`syncSecrets` 默认关，若也管书源就等于默认不同步私人书库。代价同密钥项：同步端是明文（WebDAV 文件 / 账号服务的 R2，只有本人能读）。密码不进日志与使用统计：同步只在出错时记书的 hash、请求方法与路径和错误，从不打印文档内容；整库备份（`.okf.zip`）仍不导出书源密码。
- **兼容旧客户端**：`SYNC_FORMAT` 仍为 1，服务端无需改动。旧客户端按原样 url 记键：新客户端合并时用 `sourceKey` 归一（撞键 LWW，仍满足交换律 / 结合律 / 幂等），读旧版基线时同样归一。地址本来就是规范形式（最常见）时两边的键完全一致；不是时，新客户端照常收敛，旧客户端可能收不到新客户端发出的删除，升级后自动收敛。
- **界面**：书源卡片上「编辑」打开同一个表单（带出已保存的账号密码），保存改写原记录；添加一个已存在地址的书源时改写那一条而不是重复添加，编辑成另一条书源的地址时提示已存在。书源页在每次同步结束后（`syncState.running` 变回 false）重读书源列表。

## 本地文档的生成（`buildLocalDoc`）

按书分三种情况：

| 情况 | meta | progress | alive |
|---|---|---|---|
| 有基线，且上次同步结束时书就在本地（`presentHashes`） | 与基线相同沿用基线寄存器，否则 stamp `now` | 与基线相同沿用，否则 `t = max(lastReadAt ?? 0, 基线 t + 1)` | 基线已是 alive 沿用，否则 `{ true, now }` |
| 新落地的书（有基线，但上次不在本地，如刚导入了一本仅元数据的书） | **沿用已同步的寄存器**（基线，没有则远端），同步过的元数据胜过刚导入的新元数据；都没有才 stamp `now` | 本地 `lastReadAt ?? 0` 大于已同步进度的 t 才用本地值（stamp t 取 `lastReadAt`），否则沿用 | 同上 |
| 首次同步（没有基线） | 远端有寄存器就原样沿用（远端优先），没有才 stamp `now` | 同上一行（仍按阅读时间，读得更晚的本地进度胜出） | 远端是 alive 沿用，否则 `{ true, now }`：本地有文件的书总是存活，**会复活远端已删的书** |

标注、书单、书单条目、待找条目、书源（书源的 stamp 用修改时间，见「私人书库（自定义书源）」）：

- 有基线：与基线 diff，变了的打 stamp `now`。
- 首次同步：远端有寄存器（**包括墓碑**）就原样沿用，远端删掉的不会被旧备份加回来；远端没有的才 stamp `now`。

### 删除的判定（防误删，只在有基线时）

- 书：基线里是 alive，**且上次同步后本地确实有这本书**（基线的 `presentHashes`），这次本地没有了 → 墓碑。只有元数据、文件还没下到本地的书，不会因为「本地没有」被删。
- 标注：基线里有，所属的书上次在本地（`presentHashes`）**且此刻仍在本地**，本地却没有这条 → 墓碑。
- 书单条目：同上，另外所属书单此刻也要在本地。
- 待找条目：基线里有，所属书单此刻在本地，本地却没有这条 → 墓碑（被自动关联成书单条目的也是这样删掉的）。
- 书整本删了、书单整个删了时，其标注 / 条目不单独生成墓碑，由书或书单的墓碑级联。这样不会把「因书单已删而从未落地」的条目误判为删除；书或书单日后被恢复（重新导入、并发改名胜出）时，里面的内容也一起回来。
- 书单、书源：基线里有、本地没有 → 墓碑。

## 落地到本地（`planApply`）

操作按可执行顺序排列：`addBook → updateBook → addBooklist/renameBooklist → addAnnotation/updateAnnotation → addBooklistItem/putWanted → addSource/updateSource →` 各类删除（`removeBooklistItem, deleteWanted, deleteAnnotation, deleteBooklist, deleteSource, deleteBook`）。待找条目新增或内容变了都产出 `putWanted`（同 id 覆盖），要求所属书单在合并结果里存活；书单删除时由 `deleteBooklist` 级联。

- **例外**：标注的 cfi/text/kind 等不可原地修改的字段变了时，产出紧挨着的 `deleteAnnotation + addAnnotation`（同一 id），放在添加阶段，保证先删后加。书源内容变了时产出 `updateSource`（原地改写，本地 id 不变），与 `addSource` 同一阶段。
- 书在合并结果里已删时，其标注 / 书单条目不再单独产出操作，由 `deleteBook` 级联；书单删除同理由 `deleteBooklist` 级联其条目。新增标注 / 条目要求所属的书（和书单）在合并结果里存活。
- `updateBook` 只带有差异的字段；合并结果里去掉的可选字符串（简介、语言、来源）写成 `''`，标注清空笔记写 `note: ''`；取消置顶写 `pinnedAt: 0`。
- 只有元数据、本地没有的书也会产出 `addBook`，由 engine 决定能否下载文件；引用本地不存在的书的标注 / 条目照样产出，engine 找不到 hash 时跳过（下次书落地后会再次产出）。

## 阅读时长

`myContribution = base.reading[me] + max(0, localTotal - sum(base.reading))`。
基线缺失时：`myContribution = max(0, localTotal - sum(remote.reading 中除我以外的设备))`，再与远端里我原有的贡献取较大值，避免重装后重复计时。
合并后本地总时长写成 `sum(merged.reading)`（只增不减）。

### 每日阅读记录（readingLog）

阅读记录页（按天、按书的时长）的数据。本地存在独立的 IndexedDB `lightread-stats`（`src/services/readingLog.ts`），每行键为 `${设备}|${日期}|${ref}`：

- `ref = id:<本地 bookId>`：本机阅读时由 `library.addReadingTime` 累加（与书的累计时长同时写，失败不影响后者）。日期是记录时设备本地时区的日期。
- `ref = h:<hash>`：同步落地的记录（其他设备读的，或本机缺失、由同步补回的差额），书名 / 类型取合并结果里的书目元数据。

SyncDoc 增加可选字段 `readingLog: { [device]: { [day]: { [hash]: 秒 } } }`，`SYNC_FORMAT` 仍为 1：旧客户端会忽略并在写自己的文档时丢掉它，但每台设备只写自己的文件，别的设备文件里的记录不受影响。

- 上传：本地行按 id → hash（同步层的 hash 缓存）聚合，每个 (设备, 日期, hash) = 映射到该 hash 的 id 行之和 + h 行；再与基线里的 readingLog 取较大值并入本机文档。没有 hash 的 id 行（书在算出 hash 之前就删了）只留在本地，不上传。
- 合并：`mergeReadingLog` 逐叶取较大值（交换律 / 结合律 / 幂等）；非正数、非有限数的叶子和不像日期的键丢弃；结果为空时文档里不写该字段。
- 落地：对合并结果里每个 (设备, 日期, hash)，本地已有的秒数（id 行 + h 行）小于合并值时，把差额累加进 `h:` 行。重复同步不会重复累计（本地值已等于合并值）。
- 显示（`loadDaily`）：同一天同一本书跨设备合并——hash 能映射回书架上的书就归到那本（给出 bookId），否则按 hash，都没有时按书名快照。
- 整库备份（`.okf.zip`）里另存 `reading-log.json`，导入时 id 行换成恢复后的新 id，按键取较大值合并；旧备份没有该文件时跳过。

## 一次同步的流程（engine）

1. 读本地库，得到 `LocalState`（按 hash 键，书的 hash 有缓存，只对新书计算）。
2. 远端：列出并读取所有 `devices/*.json`，合并得到 `remoteMerged`。
3. `buildLocalDoc(local, base, presentHashes, remoteMerged)`：给本地改动打 stamp、生成墓碑、更新自己的计时贡献；本地每日阅读记录聚合后并入 `readingLog`；本机设置（按修改时间）与基线里的设置并入 `settings`；再与远端文档一起 `mergeDocs`。
4. `planApply(merged, local)` 得到操作列表并应用到本地库：新书要先下载文件（远端有文件时才加入本地，否则保持「仅元数据」状态，等以后导入同一文件时自动匹配）。随后把 `merged.readingLog` 多出的差额落到本地阅读记录。开启「同步设置」时再落地比本机修改时间新的设置。
5. 把合并结果写到 `devices/<me>.json`，并把合并结果和 `presentHashes` 存为新基线（IndexedDB `lightread-sync`）。**先写文档、后传文件**：其他设备马上能看到新书的元数据，文件没到位时按第 4 步保持「仅元数据」，等文件传上去后的下一次同步再下载；上传中途应用被杀或切到后台，这次的改动也不会丢。
6. 上传：本地有、远端还没有的书文件和封面（开启「同步书籍文件」时），进度显示「第几本 / 共几本」。是否已上传以远端 `files/` 列表为准，不记在文档或基线里；单本失败只记日志，下次同步再传。
7. 刷新书架。

同一时刻只跑一次同步；自动同步在启动、切到后台、退出阅读器时触发，另外每 5 分钟一次。

### 传输与超时（WebDAV）

- 每个请求都有整体超时：普通请求（PROPFIND、读同步文档、建目录）60 秒，下载书籍文件 15 分钟，上传 60 秒 + 每 MB 10 秒（上限 30 分钟）。超时会中止请求并报「连接云端超时」（`sync.err.timeout`），不会让同步一直挂着、挡住之后的自动同步。
- 桌面 / 安卓上的 PUT（书籍文件、封面、同步文档）不走 `@tauri-apps/plugin-http`（它把请求体转成数字数组再 JSON 序列化走 IPC，整本书上传极慢、内存暴涨），改走原生命令 `http_upload`（`src-tauri/src/http_upload.rs`，前端 `src/services/nativeUpload.ts`）：
  - 书籍文件只传书库里的相对路径（`LibraryStorage.getBookFileRef`，`books/<id>.<扩展名>`，根目录为自定义书库或应用数据目录），由 Rust 直接读盘上传，书的内容不经过 WebView。Rust 侧只允许 `books/`、`covers/` 下的文件，自定义根目录必须含 `lightread.db`。读盘失败时退回读进 JS 再上传。
  - 其他请求体走 Tauri 2 的原始二进制 IPC（Android 上 Tauri 只有 postMessage 通道，仍是数字数组，但封面和同步文档都不大）。
  - 连接超时 30 秒，整体超时同上；代理沿用设置页的「HTTP 代理」（http / https / socks5）。
  - 其余请求（PROPFIND、GET、MKCOL）要读完整响应，仍走 plugin-http。

## 后端接口

后端实现 `SyncRemote`（`src/services/sync/types.ts`）。第二步的账号后端（Cloudflare Worker + D1）实现同一接口，`supportsFiles = false`，只同步元数据。

# 互传（设备间发送文字 / 链接 / 文件）

像「文件传输助手」：在一台设备上发出一段文字、一个链接或一本书，另一台设备收到后复制、打开或直接导入书库。2026-10-06 用户需求。

## 三条通道

| 通道 | 前提 | 目标 | 保留 | 单件上限 |
|---|---|---|---|---|
| 轻阅账号（默认） | 两端登录同一账号 | 指定设备 / 我的其他设备 | 7 天 | 文字 64 KB，文件 50 MB |
| WebDAV | 两端配置了同一个 WebDAV 同步（坚果云等，不需要账号） | 同上 | 7 天（各设备轮询时顺手清理） | 同上 |
| 临时取件码 | 不需要登录（借来的设备、朋友的手机） | 拿到 6 位取件码 / 二维码 / 链接的任何人 | 10 分钟或 1 小时（发送方选），最多取 10 次 | 20 MB（发送方已登录 50 MB） |

客户端统一成 `TransferChannel` 接口（`src/services/transfer/types.ts`），与同步的 `SyncRemote` 一样只换传输层，界面只有一套（「互传」页）。

```ts
interface TransferChannel {
  readonly id: 'account' | 'webdav' | 'drop'
  readonly pollIntervalMs: number                 // 账号 30 s；WebDAV 2 min（照顾坚果云限流）；取件码不轮询
  devices(): Promise<TransferDevice[]>            // 可选的目标设备（不含本机）
  list(since?: number): Promise<TransferItem[]>   // 本机可见的条目: 发给本机 / 发给全部且不是本机发的 / 本机发出的
  send(input: SendInput, opts?: { onProgress?, signal? }): Promise<TransferItem>
  fetchBlob(item, opts?: { onProgress?, signal? }): Promise<Blob>
  remove(item): Promise<void>                     // 对所有设备生效
}
```

设备身份沿用同步的 `deviceId`（IndexedDB `lightread-sync` 的 `kv.deviceId`）与 `deviceName()`。

## 轻阅账号通道（sync-server）

D1 新表（`sync-server/migrations/0001_transfers.sql`，同时并入幂等的 `schema.sql`）：

- `transfers (id, account_id, from_device, from_name, to_device NULL=全部, kind, title, text, url, r2_key, size, mime, filename, ready, created_at, expires_at)`
- `devices (account_id, device_id, name, last_seen_at)`：设备登记表。设备每次轮询 `GET /v1/transfers?device=` 时登记（同名且一小时内见过则不写，省 D1 写入）。只有支持互传的设备会出现在目标列表里；只同步、不互传的旧版本设备不会被列出（它也收不到）。
- 文件本体在 R2 `transfer/<accountId>/<id>`（与同步文档同一个桶）。

接口（`Authorization: Bearer <token>`，CORS 同现有接口）：

| 方法 路径 | 说明 |
|---|---|
| `GET /v1/devices` | `{ devices: [{ id, name, lastSeenAt }] }`，最近 90 天见过的设备 |
| `GET /v1/transfers?device=<id>&name=<设备名>&since=<ms>` | `{ items: TransferItem[], now }`；条目 = (`to_device` 为本机或 NULL 且 `from_device` ≠ 本机) ∪ (`from_device` = 本机)，未过期、文件已上传完；`since` 只返回 `created_at > since` 的；最多 200 条，新到旧 |
| `POST /v1/transfers` | JSON `{ kind, fromDevice, fromName?, toDevice?, title?, text?, url?, filename?, size?, mime? }` → `201 { item }`。文件先建记录（`ready=0`，24 小时内没传完即清理），再 `PUT /v1/transfers/:id/blob` |
| `PUT /v1/transfers/:id/blob` | 请求体为文件本身，`content-length` 必须等于声明的 `size`，流式写入 R2 → `204` |
| `GET /v1/transfers/:id/blob` | 文件流，`content-type: application/octet-stream`、`content-disposition: attachment`、`x-content-type-options: nosniff` |
| `DELETE /v1/transfers/:id` | `204`（账号内任何设备都能删，对所有设备生效） |

限制：文字 ≤ 64 KB（UTF-8）、文件 ≤ 50 MB，超出 `413 too_large`；链接 ≤ 4096 字符、标题 ≤ 300 字，超出 `400 invalid_transfer`（链接 / 文件没填标题时服务端用链接 / 文件名作标题）；每个账号每个 UTC 日最多 200 条、上传 500 MB，超出 `429 rate_limited` + `retryAfter`。每天的 Cron 删除过期条目与对应 R2 对象；注销账号时一起删掉。

## WebDAV 通道

```
<webdavUrl>/LightRead/transfer/
  item-<createdAt>-<rand>.json     条目 (同 TransferItem, 另有 format: 1 与 blob 文件名)
  item-<createdAt>-<rand>.<ext>    文件本体 (先传文件、再写 json, 列表里出现 json 即代表可取)
  device-<deviceId>.json           设备登记 { id, name, lastSeenAt }, 每台设备每天至多写一次
```

- 一次轮询 = 一次 `PROPFIND depth 1`：文件名里带创建时间，过期的不用读就知道；只 GET 没见过的 json（并发 4）。
- 轮询间隔 2 分钟（坚果云对 WebDAV 请求频率有限制）。
- 过期（7 天）条目由任何一台设备在轮询时顺手删除（每次最多删 10 个）。
- 凭据、网页版中转（坚果云 / Koofr 经 `/v1/webdav/` 中转）、桌面原生上传都复用同步的 WebDAV 代码。网页版上传无法得到字节级进度（走中转 / fetch），界面显示不确定进度条。

## 临时取件码（sync-server, 匿名）

D1 新表 `drops (id, code UNIQUE, account_id NULL, owner_hash, kind, title, text, url, r2_key, size, mime, filename, ready, downloads, max_downloads, created_at, expires_at)`，文件在 R2 `drop/<id>`。

| 方法 路径 | 说明 |
|---|---|
| `POST /v1/drops` | JSON `{ kind, title?, text?, url?, filename?, size?, mime?, ttl: 600 \| 3600 }`，可带 Bearer（已登录发送方上限 50 MB）→ `201 { id, code, ownerToken, expiresAt, maxDownloads }` |
| `PUT /v1/drops/:id/blob` | 头 `x-drop-token: <ownerToken>`，`content-length` = 声明的 `size` → `204` |
| `GET /v1/drops/:code` | `{ kind, title, text?, url?, filename?, size?, mime?, createdAt, expiresAt, downloadsLeft }`；文字 / 链接每次查看算一次领取 |
| `GET /v1/drops/:code/blob` | 文件流（attachment + nosniff），算一次领取 |
| `DELETE /v1/drops/:id` | 头 `x-drop-token`，发送方撤回 → `204` |
| `GET /d/:code` | 分享链接：Worker 配了 `WEB_APP_URL` 时 302 到 `<WEB_APP_URL>#/transfer?code=…`，否则返回纯文本说明（打开轻阅 → 互传 → 输入取件码） |

防滥用：

- 取件码 6 位数字，只在未过期的取件里保证唯一（建码时冲突重试）；有效期至多 1 小时，最多取 10 次，用完 / 过期 `410 gone`，查无 `404 not_found`。
- 每个 IP 每个 UTC 日：创建 20 次、查询 60 次、输错 10 次（之后当天所有查询 `429`）。计数键是 `HMAC(日期|IP)`，不存原始 IP（同统计心跳）。
- 下发文件一律 `application/octet-stream` + `content-disposition: attachment` + `nosniff`，从不在我们的域名下以 HTML 渲染；文字 / 链接只作为 JSON 字段返回，客户端当纯文本显示。
- Cron 删除过期取件与 R2 对象。

6 位数字是用户指定的（便于口头念、手输）。100 万的空间配合 1 小时有效期、单 IP 每天 60 次查询与输错封禁，足以挡住随手猜码；挡不住大规模多 IP 撞库，所以取件码只适合临时、非敏感的内容，界面上写明「拿到取件码的人都能查看」。

分享链接：网页版里是当前网页地址 `<origin><path>#/transfer?code=123456`；桌面 / 安卓没有网页地址，用 `https://sync.jiangshu.ai/d/123456`（由 Worker 跳转，见上表）。二维码编码的就是这条链接，由 `src/services/qr.ts`（自带编码器，不引入依赖）画成内联 SVG。

## 客户端

- `src/services/transfer/`：`types.ts`（接口与条目）、`accountChannel.ts`、`webdavChannel.ts`、`dropChannel.ts`、`http.ts`（XHR 上传进度 / fetch 下载进度）、`index.ts`（可用通道、轮询、新条目提醒、「最后看到」状态）。
- 轮询：启动时、窗口获得焦点 / 回到前台时、可见期间按通道间隔（账号 30 s、WebDAV 2 min）。已见条目 id 存 localStorage `lightread-transfer-seen`（按通道，最多 1000 个）。新收到时提示「收到来自「设备名」的 N 条」，带「查看」按钮打开互传页。
- 入口：侧栏「互传」（桌面 / 平板）；手机底部标签栏已有 5 个，不再加第 6 个，入口放在藏书页「导入」下拉菜单与设置页账号卡片里，深链 `#/transfer`；阅读器选中文字浮条「发送到其他设备」；书卡片「更多」里「发送到其他设备」（发送书籍文件）。
- 收到后：文字 → 复制 / 存为 TXT 入库；链接 → 打开 / 用「从链接导入」下载入库；文件 → 导入书库并打开 / 下载保存；删除。

## 隐私

- 内容只属于本账号（或本 WebDAV），全程 TLS；7 天自动删除，随时可删；不需要额外口令（用户明确不要再记一个密码）。
- 服务端能看到明文（同同步文档）。以后可以加可选的端到端加密：账号内设备间用登录时派生的密钥，取件码把密钥放进链接的 `#` 片段（不经服务器）。

## 为什么没有局域网直连

浏览器 / WebView 不能可靠地打开监听端口，网页版和安卓 WebView 无法做「本机当服务器」的直传；WebRTC 需要信令服务器，且在部分国产 ROM 的 WebView 上不稳定。以后可以只在桌面版通过 Tauri（Rust 监听 + mDNS）加一个局域网模式。

## 假设（等用户确认）

1. 账号通道的目标设备列表只含支持互传的新版本设备（登记表 `devices`），不含只同步、从没轮询过的旧设备。
2. 删除对所有设备生效（服务端只有一份）。
3. 取件码 6 位数字；网页版的公开网址仓库里没有记录，原生端的分享链接走 `https://sync.jiangshu.ai/d/<code>`，需要在 Worker 上配置 `WEB_APP_URL` 才会跳转到网页版。
4. WebDAV 目录放在 `<webdavUrl>/LightRead/transfer/`（与同步目录 `LightRead/sync/v1/` 并列，不影响同步列目录）。

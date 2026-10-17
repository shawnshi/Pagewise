# 自建书库：在轻阅里搜索、下载自己的书

把自己的电子书放到一台服务器、NAS 或网盘上，再通过 **OPDS** 目录接入轻阅。手机、平板、电脑上的轻阅都能按书名或作者搜索，点一下就把书下载到藏书里阅读。

轻阅不绑定某一种书库软件：只要服务端提供标准的 OPDS 1.x 目录，就能作为「书源」使用。下面先说明轻阅需要什么，再给出两种常见的搭法。

> 请只放你有权使用的书籍。不要把书库开放给公众，也不要把访问密码发到公开场合。

## 轻阅需要书库提供什么

| 能力 | 要求 | 不满足时 |
|------|------|----------|
| 目录 | OPDS 1.x Atom 订阅（`application/atom+xml`），条目里有获取链接 `rel="http://opds-spec.org/acquisition"` | 无法浏览 |
| 搜索 | 根目录里有 `rel="search"` 链接：可以是直接模板（如 `/opds?q={searchTerms}`），也可以是 OpenSearch 描述文档 | 只能翻目录，不能搜索；统一搜书里显示「此书源不支持搜索」 |
| 格式 | 每本书至少有一个可下载的文件链接；有 EPUB 时轻阅优先用 EPUB | 用其他格式下载 |
| 登录 | 推荐 HTTP Basic 认证（用户名 + 密码），所有请求（含下载）用同一组账号 | 不设密码时任何人都能下载你的书 |
| 分页 | 结果多时提供 `rel="next"` 链接 | 只显示第一页 |
| 地址 | 链接可以是相对地址，轻阅会按目录地址解析 | — |
| 网页版跨域 | 网页版轻阅从浏览器访问，需要服务端返回 CORS 头：对允许的来源返回 `Access-Control-Allow-Origin`，`Access-Control-Allow-Headers` 里明确写 `Authorization`（通配符 `*` 不包含它），并让不带账号的 `OPTIONS` 预检通过 | 网页版需配置书源代理；**桌面版和 Android 用原生网络请求，不受跨域限制** |

### 一步添加：连接信息

服务端可以生成一段「连接信息」，用户整段复制，粘贴到轻阅「书源 → 添加书源」顶部的「粘贴连接信息」框，名称、地址、用户名、密码会自动填好：

```text
名称：我的书库
地址：https://books.example.com/opds
用户名：reader
密码：（随机生成的长密码）
```

字段名也可以用英文（`Name:` `URL:` `Username:` `Password:`），全角、半角冒号都可以。添加后，这个书源会出现在「统一搜书」来源列表最前面，默认勾选，和公开书源一起搜索。

## 方案一：Calibre-Web 或 Calibre 内容服务器（最省事）

已经用 Calibre 管书的话，这是最快的路线，不需要写代码。

**Calibre-Web**（适合 NAS / VPS，用 Docker 部署）：

```yaml
# docker-compose.yml
services:
  calibre-web:
    image: lscr.io/linuxserver/calibre-web:latest
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Asia/Shanghai
    volumes:
      - ./config:/config
      - ./books:/books   # 放 Calibre 书库（含 metadata.db）
    ports:
      - 127.0.0.1:8083:8083   # 只监听本机，再通过 HTTPS 反代对外
    restart: unless-stopped
```

启动后在网页里完成初始设置（书库路径填 `/books`），修改默认管理员密码，并为轻阅单独建一个只读账号。OPDS 地址是 `https://你的域名/opds`，用户名密码就是这个账号。

**Calibre 自带的内容服务器**（电脑上直接开）：

```sh
calibre-server --enable-auth --port 8080 "/path/to/Calibre Library"
```

用 `calibre-server --manage-users` 添加用户。OPDS 地址是 `http://主机:8080/opds`。

## 方案二：用网盘存书，服务器只做索引（以百度网盘为例）

不想在服务器上放整库文件时，可以把书存在网盘里，服务器只保存书目索引，下载时再从网盘取。轻阅作者自己就是这样用的：书放在百度网盘，服务器只负责索引和中转。

```text
轻阅 ──HTTPS + Basic──▶ 你的 OPDS 服务 ──官方开放平台接口──▶ 百度网盘 /apps/<应用名>/books
                         │
                         └─ 书目索引（SQLite：书名、作者、ISBN、SHA256、网盘文件 ID）
```

要点：

1. **申请应用**：在[百度网盘开放平台](https://pan.baidu.com/union/console/applist)创建个人应用，记下应用名称、AppKey、SecretKey。个人应用供自己使用，用户数有限制。
2. **存储位置**：官方上传接口只允许写入 `/apps/<应用名>`，在网盘里显示为「我的应用数据 → 应用名」。建议按内容哈希分目录，例如 `books/epub/<SHA256 前两位>/书名 - 作者 [短哈希].epub`，完全相同的文件只存一份。
3. **授权**：用[设备码模式](https://pan.baidu.com/union/doc/使用入门/接入授权/设备码模式授权/)授权，服务器不需要浏览器。access_token 到期前用 refresh_token 续期，并**原子地保存新的 refresh_token**（旧的会失效）。同一份 refresh_token 只能给一个部署使用。
4. **上传**：按官方流程「预上传 → 分片上传 → 创建文件」，完成后重新查询远端路径和大小确认。
5. **索引**：用 EPUB 的 OPF 元数据提取书名、作者、语言、ISBN 等，以完整 SHA256 作为永久书籍 ID，同时记录网盘 `fs_id`（在 JSON 里用字符串保存，避免 JavaScript 大整数精度丢失）。
6. **下载**：轻阅请求 `/download/<SHA256>.epub` 时，服务端按 `fs_id` 实时获取临时下载链接 dlink，带上 access_token 下载，**核对大小和 SHA256 后**再返回给轻阅。dlink 和令牌都不写进索引、不发给客户端。
7. **OPDS 接口**：`GET /opds?q=关键词&page=1` 返回 Atom 订阅，每页固定条数，带 `rel="search"`（`/opds?q={searchTerms}`）和 `rel="next"`；所有接口要求同一组 HTTP Basic 账号。

> 完整的独立服务端参考实现仍在整理。目前仓库提供了[多格式上传模块与现有服务适配器](../library-server/README.md)，支持 EPUB、PDF、AZW、AZW3、MOBI；它依赖已有索引和网盘存储服务，不能单独启动。首次自建可以先用方案一，或按接口约定实现服务端。

## 对外访问：只用 HTTPS

书库服务建议只监听 `127.0.0.1`，再用下面任一方式提供 HTTPS，**不要把 HTTP 端口直接暴露到公网**（Basic 认证在明文 HTTP 下会泄露密码）。

- **Cloudflare Tunnel**：不需要公网 IP 和开放端口。在 Cloudflare Zero Trust 里创建 Tunnel，把 `books.example.com` 指向 `http://127.0.0.1:端口`，在服务器上用 `cloudflared tunnel run --token-file …` 作为 systemd 服务运行。注意 Cloudflare 等待源站响应约 100 秒：方案二要先把整本书从网盘取回并校验，特别大的文件可能超时。
- **Caddy 反向代理**（有公网 IP 和域名时）：

  ```caddyfile
  books.example.com {
      reverse_proxy 127.0.0.1:8766
  }
  ```

  Caddy 会自动申请和续期证书。

## 在轻阅中使用

1. 打开「书源 → 添加书源」，粘贴连接信息（或手动填写地址、用户名、密码），点「添加」。
2. 在「统一搜书」输入书名或作者。你的书库排在结果最前面，标着「我的书库」。
3. 点「下载并阅读 EPUB」：轻阅下载、导入藏书并直接打开。之后在藏书里离线阅读。

也可以点开书源卡片，像浏览目录一样逐页翻看。

### 添加本地书籍和收藏

- **本地藏书**：点「添加书籍」，可以多选或拖入 EPUB、AZW、AZW3、MOBI、PDF 等文件。在某个书单中添加，新书会同时加入该书单。
- **私人云端**：点「我的书库」卡片或书源目录内的「添加书籍」，选择设备上的文件，或切换到「已有藏书」，按书单、置顶、书名筛选后加入上传队列。确认目标书库后点「开始上传」。
- **已收藏的书**：藏书卡片的云端按钮、管理模式的批量操作和「将此书单加入云端」都能把已有原文件加入私人书库，不必重新下载。整份书单上传不受搜索或标签筛选影响。

MOBI、AZW、AZW3、FB2、TXT 等可转换的格式默认先在本机转成 EPUB 再上传（上传对话框里可关闭「上传前转换为 EPUB」），PDF 等固定版式保留原文件。藏书里也可以随时用书卡上的「转换为 EPUB」把书转成更好的格式，原书保留。相同内容只保存一份；某本失败不会打断其余书籍，可单独重试。当前适配器每本上限 90 MiB；客户端会显示服务端支持的格式和大小。AZW／AZW3 在本地阅读需要文件没有 DRM 加密。

### 服务端如何启用上传

普通 OPDS 只提供浏览和下载，**并不自动支持上传**。轻阅先检查服务声明的上传能力；只读书源会显示说明，不会接收文件。Calibre 的现有上传接口不会被当成这个协议调用。

自建服务在 OPDS feed 中增加以下链接（地址须与书源同源），并沿用书源的认证：

```xml
<link rel="https://lightread.app/rel/library" href="/api/library" type="application/json" />
<link rel="https://lightread.app/rel/upload" href="/api/upload" type="application/json" />
```

`GET /api/library` 返回版本、上传地址、格式和大小限制；`POST /api/upload` 接收原始文件体。完整请求头、返回值和安装验证步骤见[上传协议说明](../library-server/README.md)。网页版还需允许 CORS 的 `POST` 方法以及 `Content-Type`、`X-File-Name`、`X-Book-Title`、`X-Book-Author` 请求头。私人文件上传直连自己的书库，不通过公共书源代理。

## 常见问题

**显示「需要账号授权 (401)」**：用户名或密码不对，在书源卡片上删除后重新添加。

**统一搜书里显示「此书源不支持搜索」**：服务端的根目录没有 `rel="search"` 链接。Calibre-Web、Calibre 内容服务器都自带搜索；自己实现的服务请补上。

**网页版连不上，桌面版可以**：服务端没有返回 CORS 头。按上文「网页版跨域」一行配置，或在轻阅设置里配置书源代理。

**下载要等好几秒**：方案二每次都要从网盘取回并校验整本书，属于正常现象，网盘限速时会更慢。下载完成后书就在本机藏书里，之后阅读不再联网。

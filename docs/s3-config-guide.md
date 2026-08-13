# KnockChat 服务端存储桶配置指南

KnockChat 使用**兼容 AWS S3 API 的对象存储桶**作为唯一数据后端。
全部业务数据均存放在**同一个存储桶**中，通过对象 Key 前缀区分；
业务逻辑运行在 **Cloudflare Workers**（LockAPI）上，前端通过 HTTP 调用 Worker。

> 核心约定：**服务端只有一个存储桶**，任何数据都写入这个桶。

***

## 1. 架构说明

```
┌────────────────────────────────────────────────────────────
│ 前端（Tauri WebView，KnockChat）                            
│   src/js/s3.js        → window.s3.rpc(name, params)        
│                          POST {API_BASE_URL}/rpc           
│   src/js/realtime.js  → WebSocket /ws（实时网关）          
│         │  HTTPS                  
│         ▼                                                  
│  Cloudflare Worker（LockAPI / api-knockchat）              
│   src/index.ts：/rpc（RPC 分发）+ /ws（WebSocket 升级）     
│   Durable Object RealtimeRoom：在线人数 / 在线状态 /        
│      已读回执 / 内部事件推送（如好友关系变更）              
│         │  AWS Signature V4（HMAC-SHA256 签名）            
│         ▼                                                  
│  雨云对象存储（AWS S3 兼容 API）             
└────────────────────────────────────────────────────────────
```

- 凭证（AccessKey / SecretKey）**只保存在 Worker Secret 环境变量**（`wrangler secret put`），客户端与仓库不包含任何明文密钥。
- 前端所有数据操作统一走 `s3.rpc('rpc_name', params)` → `POST {API_BASE_URL}/rpc`，返回 `{ ok, data }` / `{ ok:false, error:{message} }`。
- **实时通道**：登录后前端建立 `/ws` WebSocket 连接（Durable Object `RealtimeRoom`，所有连接路由到 `env.REALTIME.idFromName("global")`），承载：
  - 在线人数 / 在线状态（`online_count` / `online_list` / `presence`）
  - 私聊已读回执（`read`，转发给会话对方在线连接）
  - 好友关系变更推送（`friend_update`，加/删好友后双方在线客户端立即刷新好友列表）
  - Worker 内部经 `stub.fetch("POST /push", {uids, event, payload})` 触发推送，DO stub 仅 Worker 内部可达，天然安全
- 群聊 / 私聊新消息仍以**轮询**（`get_my_groups` / `get_private_sessions`）为主，实时通道用于状态与事件同步。

***

## 2. 存储桶目录结构

S3 没有真正的"文件夹"，前缀 `xxx/` 即视为目录。KnockChat 约定如下（应用运行时自动创建，**无需手动建目录**）：


```
knockchat（存储桶名，可在雨云控制台自由命名）
├── users/                              用户数据
│     ├── <uid>/                        每个用户一个目录
│     │     ├── info.json               用户资料（昵称 → 密码哈希、状态、邮箱、简介、封禁状态等；含 cloud_settings 云设置密文）
│     │     ├── friends.json            好友列表（含好友分组 groups 字段）
│     │     └── groups.json             用户加入的群聊列表（group_ids）
│     ├── _index.json                   用户名 → UID 索引
│     └── _meta.json                    UID 计数器（next_uid，从 1 递增）
├── sessions/                           登录会话（会话 Token → 用户名）
│     └── <token 编码>.json
├── groups/                             群聊数据（群 ID 为纯数字递增，与 UID 同风格）
│     ├── <gid>/                        每个群聊一个目录
│     │     ├── info.json               群基础信息（群名、头像、群主、成员数、last_message、mute_all_until 等）
│     │     ├── members.json            群成员表（uid、role: owner|admin|member、joined_at、last_read_at、mute_until）
│     │     ├── messages/               群消息（按时间序 id 命名）
│     │     │     └── <毫秒时间戳十六进制>.json
│     │     ├── files/                  群文件（以「文件」上传，每群总容量上限 256MB，逐文件 ≤8MB）
│     │     ├── image/                  群图片（以「图片」按钮上传，不计入群文件用量与列表）
│     │     └── voice/                  群语音（消息内语音，不计入群文件用量与列表）
│     ├── _index.json                   群聊 ID → GID 索引（预留，gid 即 id，当前未启用）
│     └── _meta.json                    gid 计数器（next_gid，从 1 递增）
├── invites/                            邀请数据（收发双向同文件；目录即用户 uid）
│     ├── <uid>/groups.json             群邀请列表（invites 对象含 from_uid/to_uid 可推导方向；未受理）
│     └── <uid>/friends.json            好友申请列表（requests 对象含 from_uid/to_uid；未受理）
├── private/                            私聊数据
│     ├── <sid>/                        每个私聊会话一个目录（sid = 两个 uid 按数值排序拼接，如 "1__2"）
│     │     ├── messages/               私聊消息（<毫秒时间戳十六进制>.json）
│     │     └── files/                  私聊附件（每会话总容量上限 32MB）
│     └── <sid>.json                    私聊会话索引（sid = 较小uid__较大uid）
├── resrc/                              资源数据
│     ├── group_ava/                    群头像
│     ├── usr_ava/                      用户头像
│     └── usr_bkg/                      用户个人主页背景
├── media/emoji/<uid>/                  用户表情（v100 保留历史前缀）
├── agents/                             智能体（Golem 机器人）配置
│     ├── <id>.json                     智能体配置（昵称/简介/头像/归属账号/bot_key_hash 等）
│     └── by_name/<编码名>.json         智能体名称 → 配置索引
└── upd/                                应用更新包（latest.json 元数据 + 安装包）
```

说明：

- **ID 规则**：用户 UID 与群 ID（gid）均为纯数字递增（分别由 `users/_meta.json`、`groups/_meta.json` 计数器分配，从 1 开始）；历史遗留的十六进制字符串群 ID 仍兼容，与数字 ID 不冲突。
- 群消息 id 使用**十六进制毫秒时间戳前缀**，S3 按字典序返回对象，天然即"按时间排序"，配合 `p_before_id` / `p_after_id` 实现翻页。
- 私聊会话 id 由两个 uid（数值排序后拼接）确定性生成，双方计算出相同 id，无需单独分配。
- 好友关系为**双向**：互加成功时双方 `users/{uid}/friends.json` 同时写入，删除同样双向移除。
- 群管理（v100.x / v102）：群主可编辑管理员（每群最多 25 名）与**转让群主**（v102，转让后降为普通成员）；群主与管理员可修改群资料、删除/上传群文件、删除成员消息（留系统提示、多媒体文件联动删除）、禁言与踢人；仅群主可清空群消息。禁言支持**自定义时长**（v102，1 分钟 ~ 7 天 / 1~10080 分钟，个人/全体），截止时间分别存于成员 `mute_until` 与群信息 `mute_all_until`（全体禁言时管理员/群主豁免）。
- 群文件用量：`groups/<gid>/files/` 为「群文件」配额（每群 256MB，群文件页展示已用/上限）；图片（`image/`）与语音（`voice/`）不计入，删除多媒体消息时其引用的文件会一并删除。
- 群邀请 / 好友申请为**收发双向同文件**：`invites/{uid}/groups.json`（`friends.json`）同时记录该用户「收到」与「发出」的未受理记录，对象内 `from_uid` / `to_uid` 用于推导方向。
- 实时功能由 Durable Object（`RealtimeRoom`，SQLite 存储）承载，**不写入 S3**。
- 智能体（Golem 机器人，v103）：`agents/<id>.json` 存配置（归属账号、`bot_key_hash` 等），`agents/by_name/` 为名称索引；机器人同时拥有 `users/<uid>/info.json` 中 `role: "agent"` 的账号（密码随机不可登录，凭证为 `login_key`，见 `docs/milky-protocol-guide.md`）。
- 密码不落明文：前端 SHA-256 预哈希 → 服务端存储哈希值（登录时比对哈希）。

***

## 3. 在雨云创建存储桶

1. 登录 [雨云控制台](https://www.rainyun.com/) → 进入「对象存储 / COS」产品。
2. 创建一个**存储桶**（例如 `knockchat`），记录：
   - **EndPoint（私有 API 地址）**：形如 `https://cn-nb1.rains3.com`（务必使用**私有 S3 API**，勿用公开静态域——那是独立数据空间，无 list API）
   - **Region**：如 `us-east-1`
   - **Bucket 名称**
   - AccessKey 和 SecretKey
   - **公开直链域名**（桶设为公开读时）：形如 `https://cn-nb1.rains3.com/knockchat`

> 无需在控制台预建任何"文件夹"。KnockChat 运行时会按前缀自动写入。

***

## 4. Worker 配置（wrangler secrets + 前端 API 地址）

### 4.1 注入存储凭证（Cloudflare Workers 侧）

在 LockAPI 目录（`wrangler.toml` 所在处）执行（生产用 `wrangler secret put`，本地开发复制 `.dev.vars.example` 为 `.dev.vars` 填写）：

```
wrangler secret put S3_ENDPOINT    # 私有 S3 API：https://cn-nb1.rains3.com
wrangler secret put S3_BUCKET      # 存储桶名称
wrangler secret put S3_ACCESS_KEY
wrangler secret put S3_SECRET_KEY
wrangler secret put ADMIN_KEY      # BELL 管理端鉴权密钥（所有 /admin/* 请求必须携带）
```

非敏感默认值写在 `wrangler.toml` 的 `[vars]`：

| 字段               | 说明                                                                     |
| ---------------- | ---------------------------------------------------------------------- |
| `S3_REGION`      | 地域，默认 `us-east-1`                                                      |
| `S3_PATH_STYLE`  | 路径风格寻址（`endpoint/bucket/key`），雨云/对象存储一般为 `true`                        |
| `S3_PUBLIC_BASE` | 桶公开直链前缀，如 `https://cn-nb1.rains3.com/knockchat`；留空则回退为 7 天预签名链接（会过期失效） |

> **安全提醒**：凭证绝不写入仓库 / `wrangler.toml` / 前端代码；客户端（含打包 exe）不包含任何存储密钥。

### 4.2 前端 API 地址

- 编译常量：`src/js/constants.js` 的 `API_BASE_URL`（当前为 `https://api.cika-meow.top/`）。
- 运行时覆盖：`localStorage.cika_api_base` 优先于编译常量（便于测试环境切换）。
- 验证：登录页调用 `s3.status()` 检查 Worker 连通性；未配置/不可达时提示检查 Worker 地址与密钥。

***

## 5. 权限策略建议

### 方案 A：私有桶 + 预签名 URL（推荐）

- 桶权限设为**私有**（不公开读）。
- 媒体访问走服务端 `get_media_url` 生成的**预签名 URL**（默认 1 小时有效），前端拿到的链接都带签名，过期自动失效。
- 适合正式生产，防爬、防盗链。

### 方案 B：公开读

- 将桶设为公开读（或在桶策略中允许 `s3:GetObject`）。
- 配置 `S3_PUBLIC_BASE` 后，`upload_media` 返回的即永久公网直链，无需签名。
- 适合测试/轻量使用；媒体 URL 一旦泄露可长期访问。

> 无论哪种方案，**写操作（PutObject）都仅由 Worker 签名发起**，前端不会直接接触存储凭证。

***

## 6. 云端用户设置同步（跨设备）

用户设置（通知、屏蔽词、外观主题/字体、AI 模型/翻译设置含 API Key）会加密后同步到云端，实现换设备登录自动恢复。

### 存储位置

- 字段：`users/<uid>/info.json` 的 `cloud_settings`（可选，缺省为 null）。
- 内容为**客户端加密密文**：`{version, salt, iterations, updated_at, iv, data}`，其中 `data` 为 AES-GCM 密文（内含 `app` / `blockword` / `ai` 三部分设置）。
- **服务端只见密文**：加密密钥由「账号级随机盐 + 客户端密码预哈希」PBKDF2（10 万次迭代）派生，S3 侧无法解读，也不参与加解密。

### 相关 RPC（LockAPI `src/rpc.ts`）

| RPC                    | 参数                                     | 说明                                                    |
| ---------------------- | -------------------------------------- | ----------------------------------------------------- |
| `get_user_settings`    | `p_uid`、`p_token`（或 `p_session_token`） | 读取本账号 `cloud_settings`，返回 `{success, settings}`；需会话验证 |
| `update_user_settings` | `p_uid`、`p_token`、`p_settings`         | **整体覆盖**写入 `cloud_settings`（云端为权威）；需会话验证；单条 ≤ 16KB    |

### 同步策略

- **云端为权威**：登录/会话恢复后客户端拉取云端设置覆盖本地；本地设置变更后防抖（1.2s）推送。
- 首次使用云同步（云端无数据）时，客户端以当前设备设置为种子上传。
- 修改密码后旧密文无法解密，客户端以当前设备设置为准重新加密上传（旧密文对新密码不可读，等同丢弃）。
- 同步范围、加密细节见 `docs/local-storage-guide.md` 第 11 节；实现见 `src/js/cloudsync.js`。

***

## 7. 上传大小与类型限制

为防止刷流量与占用大量存储空间，上传做了**双重限制**：前端本地先校验、通过后才发起上传；后端按用途前缀强制拦截，即使绕过前端直接调 RPC 也无效。

### 后端强制限制（权威校验，见 LockAPI `src/rpc.ts` 的 `mediaUploadLimit`）

| 用途前缀                | 大小上限 | 类型限制            |
| ------------------- | ---- | --------------- |
| `resrc/usr_ava/`    | 5MB  | 仅图片             |
| `resrc/usr_bkg/`    | 8MB  | 仅图片             |
| `resrc/group_ava/`  | 8MB  | 仅图片             |
| `groups/<gid>/files/` | 8MB  | 不限（群文件，每群总量 ≤256MB） |
| `groups/<gid>/image/` | 8MB  | 不限（群聊图片，不占群文件配额）  |
| `groups/<gid>/voice/` | 8MB  | 不限（群语音，不占群文件配额）   |
| `private/<sid>/files/` | 32MB | 不限（私聊附件/语音）    |
| `media/emoji/<uid>/`  | 2MB  | 仅图片（用户级自定义表情，每用户 ≤ 64 个） |
| 其他/未知前缀            | 8MB  | 不限               |

> 服务端在 base64 解码后按对象 Key 前缀判断，超限返回错误、不写桶；`resrc/*` 用途仅接受 `image/*` 类型。
> 自定义表情走独立 RPC（`upload_emoji`，v091）：仅接受 `image/*`、单张 ≤ 2MB、每用户 ≤ 64 张，Key 强校验归属防越权。
> （v100：公聊已移除；媒体路径为目录式，`media/avatars/`、`media/background/`、`media/group/`、`media/private/` 已不再读写。
> v100.x：群聊图片/语音分别落到 `groups/<gid>/image/` 与 `groups/<gid>/voice/`，不再与群文件混用 `files/`；`list_media` 对群文件前缀返回 `{files, total_size, file_count, max_size}` 供用量展示，`upload_media` 对 `files/` 校验每群 256MB 总容量。）

### 前端限制（本地先校验，通过再上传）

| 上传项                  | 原图/原文件限制       | 最终上传限制（压缩/裁剪后） |
| -------------------- | -------------- | -------------- |
| 头像（`resrc/usr_ava/`）   | 5MB            | ≤ 1MB          |
| 主页背景图（`resrc/usr_bkg/`） | 8MB            | ≤ 3MB          |
| 群头像（`resrc/group_ava/`） | 8MB            | -              |
| 群聊图片（`groups/<gid>/image/`） | 8MB            | 压缩后仍 ≤ 8MB     |
| 群聊文件（`groups/<gid>/files/`） | 8MB            | -              |
| 私聊文件（`private/<sid>/files/`） | 32MB           | -              |
| 语音                   | 8MB / 最长 120 秒 | 超时自动停止录制       |

- 前端所有入口统一调用 `fileSizeError(fileOrBlob, maxBytes, label)` 校验（`src/js/features.js`），超限直接提示并中止，**不发起任何网络请求**。
- 头像/背景等会经过压缩、裁剪的图片，上传前会对最终 Blob **二次校验**，防止压缩后仍超限。
- 群聊图片（`image/`）、语音（`voice/`）、文件（`files/`）分别存储于 `groups/<gid>/` 下的不同子目录，群文件页只展示 `files/`（即「以文件形式上传的文件」）并显示用量；语音 ≤ 8MB、≤ 120 秒，到点自动停止录制。
- 修改限制时需**同步修改** `src/js/constants.js` 的常量与 LockAPI `src/rpc.ts` 的 `mediaUploadLimit`。

***

## 8. 运维建议

- **备份**：`users/`、`sessions/`、`groups/`、`private/`、`invites/` 是核心数据，建议在雨云开启版本控制或定期导出。
- **清理**：`groups/<gid>/files/`、`private/<sid>/files/` 可能累积大文件，建议按前缀设置生命周期规则或手动归档。
- **监控**：关注雨云控制台的请求量/流量计费，群聊/私聊轮询默认每 5\~10 秒一次，量小无压力。
- **v100 结构迁移**：v100 起存储桶收敛为目录式结构（`users/<uid>/info.json`、`groups/<gid>/…`、`invites/<uid>/…`、
  `private/<sid>/…`、`resrc/…`），并移除公聊（`public/messages/`、`media/chat/`、`media/public/`）。升级前后端代码前，先运行
  `BELL/migrate_structure.py`（boto3 直连雨云 S3）完成旧扁平结构 → 新目录结构的迁移（含 JSON 内嵌媒体 URL 改写）：
  - `python migrate_structure.py`：dry-run，统计 + 导出「旧→新」备份清单，不写存储桶；
  - `python migrate_structure.py --yes`：确认后执行迁移（先复制/合并，成功后删除旧对象）；
  - `python migrate_structure.py clean-public`：仅清理 v099 遗留的公聊数据；
  - 脚本幂等可重跑，迁移对照表与安全说明见脚本头部。
- **迁移后核对**：迁移完成后打开 BELL 管理端，检查「用户」与「群文件」页签能正常列举；再以用户身份登录客户端验证
  头像/背景/群文件/私聊附件可正常加载。

***

## 9. 单桶约束说明

- 应用假设**只有一个存储桶**，所有 Key 都不含桶名，代码中 `bucket` 仅用于寻址。
- 如你后续在雨云新建了其他桶，业务数据仍只写入配置中的这个桶，其他桶不影响 KnockChat。


# KnockChat Milky 协议端接入指南

本文档说明如何通过 **Milky 协议** 将 KnockChat 的机器人账号（Golem）接入现有机器人框架（NoneBot、Koishi、Lagrange.OneBot 等支持 Milky/OneBot 系协议适配的框架）。

LockAPI 服务器实现了 Milky 协议端：机器人账号以 `login_key` 作为凭证连接，即可调用好友 / 群聊 / 消息 / 文件等 API，并通过 WebSocket 实时接收事件。

***

## 1. 协议概览

| 项目           | 说明                                                                           |
| ------------ | ---------------------------------------------------------------------------- |
| HTTP 端点      | `POST https://<worker地址>/bot/api/{endpoint}`（统一在协议端点前加 `/bot/` 前缀）           |
| WebSocket 事件 | `wss://<worker地址>/bot/event`                                                 |
| 请求体          | `application/json`                                                           |
| 认证           | `Authorization: Bearer <access_token>`（HTTP）；`?access_token=`（WS 查询参数）       |
| 成功响应         | `{ "status": "ok", "retcode": 0, "data": { ... } }`                          |
| 失败响应         | `{ "status": "failed", "retcode": 1, "message": "错误说明" }`                    |
| 事件帧          | `{ "event_type": "...", "time": 秒级时间戳, "self_id": 机器人uid, "data": { ... } }` |

> `retcode` 业务失败为 `1`；鉴权失败 `401`；端点不存在 `404`；非 POST `405`；Content-Type 非 JSON `415`（这些 HTTP 状态码与 retcode 一致，其余业务失败 HTTP 状态码为 200）。

***

## 2. 准备机器人账号

1. 在 KnockChat 客户端「机器人」页面（Golem）申请并创建机器人账号，获取：
   - `uid`（如 `10001`）
   - `login_key`（仅创建时展示一次）
2. 拿到账号后即可用它调用所有 `/bot/api/*` 端点。

### 2.1 认证凭证的两种格式

支持组合式与分离式两种写法，任选其一：

**方式 A：组合式（uid + login\_key 拼在一个 token 里）**

```
Authorization: Bearer 10001.LK3x9...
```

**方式 B：分离式**

```
Authorization: Bearer LK3x9...
X-Bot-Uid: 10001
```

或把 uid 放进请求体：

```json
{ "uid": 10001, ...业务参数 }
```

WebSocket 同样支持两种写法：

```
wss://<worker>/bot/event?access_token=10001.LK3x9...
wss://<worker>/bot/event?uid=10001&access_token=LK3x9...
```

> 机器人账号被封禁（banned）或停用（bot\_disabled）时认证一律返回 401。

***

## 3. 快速上手

```bash
# 登录信息
curl -X POST "https://<worker>/bot/api/get_login_info" \
  -H "Authorization: Bearer 10001.LK3x9..." \
  -H "Content-Type: application/json" -d "{}"

# 发送私聊消息
curl -X POST "https://<worker>/bot/api/send_private_message" \
  -H "Authorization: Bearer 10001.LK3x9..." \
  -H "Content-Type: application/json" \
  -d '{"user_id": 20002, "message": [{"type": "text", "data": {"text": "你好"}}]}'

# 发送群聊消息（@ + 文本）
curl -X POST "https://<worker>/bot/api/send_group_message" \
  -H "Authorization: Bearer 10001.LK3x9..." \
  -H "Content-Type: application/json" \
  -d '{"group_id": "30003", "message": [{"type": "mention", "data": {"user_id": 20002}}, {"type": "text", "data": {"text": "你好"}}]}'
```

Node.js 参考：

```js
const BASE = "https://<worker>/bot/api";
const TOKEN = "10001.LK3x9..."; // 组合式

async function call(endpoint, body) {
  const r = await fetch(`${BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return r.json();
}

// WebSocket 事件订阅
const ws = new WebSocket(`wss://<worker>/bot/event?access_token=${TOKEN}`);
ws.onmessage = (e) => {
  const frame = JSON.parse(e.data);
  console.log(frame.event_type, frame.data);
};
```

***

## 4. WebSocket 事件

连接后服务端实时推送事件帧，`data` 内字段因事件类型而异。已支持的事件：

| event\_type             | 触发场景         | data 关键字段                                                                 |
| ----------------------- | ------------ | ------------------------------------------------------------------------- |
| `message_receive`       | 收到私聊 / 群聊消息  | 完整 IncomingMessage（见 §5.2）                                                |
| `message_recall`        | 私聊 / 群聊消息被撤回 | 消息 ID、场景、会话方                                                              |
| `group_file_upload`     | 群文件被上传       | `group_id`、`file{id,name,size,url}`、`operator_id`                         |
| `friend_request`        | 收到好友申请       | `user_id`、`nickname`、`comment`、`request_id`                               |
| `friend_nudge`          | 好友拍一拍（戳一戳）   | `user_id`（被拍者）、`from_user_id`、`from_nickname`                             |
| `group_nudge`           | 群内拍一拍        | `group_id`、`target_uid`、`from_uid`、`from_nickname`                        |
| `group_invitation`      | 被邀请入群        | `group_id`、`group_name`、`inviter_id`、`inviter_name`、`message`、`invite_id` |
| `group_member_increase` | 新成员入群        | `group_id`、`user_id`、`nickname`、`operator`                                |
| `group_member_decrease` | 成员退群/被踢      | 同上                                                                        |
| `group_name_change`     | 群名变更         | `group_id`、`name`、`operator_id`                                           |
| `group_mute`            | 成员被禁言        | `group_id`、`user_id`、`duration`、`operator_id`                             |
| `group_whole_mute`      | 全体禁言         | `group_id`、`is_mute`、`operator_id`                                        |

事件帧示例：

```json
{
  "event_type": "message_receive",
  "time": 1786600000,
  "self_id": 10001,
  "data": {
    "message_scene": "group",
    "peer_id": 30003,
    "sender_id": 20002,
    "sender_name": "小明",
    "sender_role": "member",
    "message_seq": "2f3c...",
    "time": 1786600000,
    "segments": [{ "type": "text", "data": { "text": "你好" } }]
  }
}
```

> 提醒：`group_invitation` 事件中的 `invite_id` 即为应答接口 `accept_group_invitation` / `reject_group_invitation` 所需的 `invitation_seq`，请原样回传。

***

## 5. 消息模型

### 5.1 发送（OutgoingSegment\[]）

`message` 参数为段数组 `[{ "type": "...", "data": { ... } }]`：

| type                    | data 字段            | 说明                            |
| ----------------------- | ------------------ | ----------------------------- |
| `text`                  | `text`             | 纯文本                           |
| `mention`               | `user_id`          | @指定成员（仅群聊）                    |
| `mention_all`           | —                  | @全体成员（仅群聊）                    |
| `face`                  | —                  | 表情（渲染为 `[表情]`）                |
| `image`                 | `uri`              | 图片：`http(s)://` 或 `base64://` |
| `record`                | `uri`, `duration?` | 语音：同上                         |
| `video`                 | `uri`              | 视频：同上                         |
| `reply`                 | —                  | 引用（空占位）                       |
| `forward` / `light_app` | —                  | 占位段（渲染为文案）                    |

> 媒体 URI 支持 `http(s)://` 与 `base64://` 前缀；`base64://` 内容会转存到对象存储并生成可访问 URL。不支持 `file://`。发送时若同时含文本与媒体段，KnockChat 内部采用「单类型 + 文本」模型，以首个媒体段为准。

### 5.2 接收（IncomingMessage）

```json
{
  "message_scene": "friend" | "group",
  "peer_id": 20002,
  "sender_id": 20002,
  "sender_name": "小明",
  "sender_role": "owner" | "admin" | "member",
  "message_seq": "十六进制消息ID",
  "time": 1786600000,
  "segments": [
    { "type": "text",  "data": { "text": "..." } },
    { "type": "image", "data": { "url": "...", "text": "" } },
    { "type": "record","data": { "url": "...", "duration": 0 } },
    { "type": "file",  "data": { "url": "...", "name": "...", "size": "..." } }
  ]
}
```

> 消息历史中的文本为 KnockChat 客户端存储格式，服务端已自动还原（含 Base58 加密文本解码与内联表情 CQ 码转 `[表情]`）。

***

## 6. API 参考

### 6.1 系统

| endpoint                   | 请求体                      | 返回 data                                                                             |
| -------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `get_login_info`           | `{}`                     | `{ uin, nickname }`                                                                 |
| `get_impl_info`            | `{}`                     | `{ impl_name, impl_version, qq_protocol_version, qq_protocol_type, milky_version }` |
| `get_user_profile`         | `{ user_id? }`（缺省为机器人自身） | `{ nickname, qid, age, sex, remark, bio, level, country, city, school }`            |
| `get_friend_list`          | `{}`                     | `{ friends: [FriendEntity] }`                                                       |
| `get_friend_info`          | `{ user_id }`            | `{ friend: FriendEntity }`                                                          |
| `get_group_list`           | `{}`                     | `{ groups: [GroupEntity] }`                                                         |
| `get_group_info`           | `{ group_id }`           | `{ group: GroupEntity }`                                                            |
| `get_group_member_list`    | `{ group_id }`           | `{ members: [GroupMemberEntity] }`                                                  |
| `get_group_member_info`    | `{ group_id, user_id }`  | `{ member: GroupMemberEntity }`                                                     |
| `set_avatar`               | `{ uri }`                | `{}`                                                                                |
| `set_nickname`             | `{ new_nickname }`       | `{}`                                                                                |
| `set_bio`                  | `{ new_bio }`            | `{}`                                                                                |
| `get_custom_face_url_list` | `{}`                     | `{ urls: [图片URL] }`                                                                 |

**实体结构**：

- `FriendEntity`：`{ user_id, uin, nickname, remark, sex, age, level }`
- `GroupEntity`：`{ group_id, group_uin, group_name, group_avatar, member_count, max_member_count }`
- `GroupMemberEntity`：`{ user_id, uin, nickname, group_role, role_name, title }`（`group_role` ∈ owner/admin/member）

### 6.2 消息

| endpoint                 | 请求体                                                      | 返回 data                                             |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------- |
| `send_private_message`   | `{ user_id, message }`                                   | `{ message_seq, time }`                             |
| `send_group_message`     | `{ group_id, message }`                                  | `{ message_seq, time }`                             |
| `recall_private_message` | `{ user_id, message_seq }`                               | `{}`                                                |
| `recall_group_message`   | `{ group_id, message_seq }`                              | `{}`                                                |
| `get_message`            | `{ message_scene, peer_id, message_seq }`                | `{ message: IncomingMessage }`                      |
| `get_history_messages`   | `{ message_scene, peer_id, limit?, start_message_seq? }` | `{ messages: [IncomingMessage], next_message_seq }` |
| `mark_message_as_read`   | `{ message_scene, peer_id }`                             | `{}`                                                |

> `message_scene` 取值 `"friend"` / `"group"`；`peer_id` 为对方 uid 或群号。`get_history_messages` 的 `limit` 最大 30（缺省 20），`start_message_seq` 缺省表示从最新往回翻。

### 6.3 好友

| endpoint                | 请求体                 | 返回 data                                                                                                                    |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `send_friend_nudge`     | `{ user_id }`       | `{}`                                                                                                                       |
| `delete_friend`         | `{ user_id }`       | `{}`                                                                                                                       |
| `get_friend_requests`   | `{ limit? }`        | `{ requests: [{ time, initiator_id, initiator_uid, target_user_id, target_user_uid, state, comment, via, is_filtered }] }` |
| `accept_friend_request` | `{ initiator_uid }` | `{}`                                                                                                                       |
| `reject_friend_request` | `{ initiator_uid }` | `{}`                                                                                                                       |

> `initiator_uid` 支持 `"u_10001"` / `"u10001"` / `"10001"` 三种写法。

### 6.4 群聊

| endpoint                  | 请求体                               | 返回 data            |
| ------------------------- | --------------------------------- | ------------------ |
| `set_group_name`          | `{ group_id, new_group_name }`    | `{}`               |
| `set_group_avatar`        | `{ group_id, image_uri }`         | `{}`               |
| `set_group_member_mute`   | `{ group_id, user_id, duration }` | `{}`（`duration` 秒） |
| `set_group_whole_mute`    | `{ group_id, is_mute }`           | `{}`               |
| `kick_group_member`       | `{ group_id, user_id }`           | `{}`               |
| `quit_group`              | `{ group_id }`                    | `{}`               |
| `send_group_nudge`        | `{ group_id, user_id }`           | `{}`               |
| `accept_group_invitation` | `{ invitation_seq }`              | `{}`               |
| `reject_group_invitation` | `{ invitation_seq }`              | `{}`               |

> 全体禁言内部映射为 7 天（10080 分钟，内部上限），解禁传 `is_mute: false`。被禁言、被踢、群名/群头像变更、禁言等管理操作仅群主/管理员可执行（与客户端权限一致）。

### 6.5 群文件 / 文件夹

KnockChat 群文件为目录式存储：`groups/{群号}/files/{folderId}/{文件名}`，根目录文件无文件夹前缀。文件夹为单层结构。

| endpoint                        | 请求体                                                     | 返回 data                                          |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `upload_group_file`             | `{ group_id, file_uri, file_name?, parent_folder_id? }` | `{ file_id }`                                    |
| `get_private_file_download_url` | `{ user_id, file_id }`                                  | `{ download_url }`                               |
| `get_group_file_download_url`   | `{ group_id, file_id }`                                 | `{ download_url }`                               |
| `get_group_files`               | `{ group_id, parent_folder_id? }`                       | `{ files: [GroupFile], folders: [GroupFolder] }` |
| `move_group_file`               | `{ group_id, file_id, target_folder_id }`               | `{}`                                             |
| `rename_group_file`             | `{ group_id, file_id, new_file_name }`                  | `{}`                                             |
| `delete_group_file`             | `{ group_id, file_id }`                                 | `{}`                                             |
| `create_group_folder`           | `{ group_id, folder_name }`                             | `{ folder_id }`                                  |
| `rename_group_folder`           | `{ group_id, folder_id, new_folder_name }`              | `{}`                                             |
| `delete_group_folder`           | `{ group_id, folder_id }`                               | `{}`（文件夹内文件一并删除）                                 |

- `parent_folder_id`：根目录传 `"/"` 或空串；`get_group_files` 按此过滤当前目录下的文件与文件夹。
- `file_uri` 支持 `http(s)://` 与 `base64://`；`file_name` 缺省从 URI 末尾取，中文/全角括号可原样落库。
- `GroupFile`：`{ group_id, file_id, file_name, parent_folder_id, file_size, uploaded_time, expire_time, uploader_id, downloaded_times }`
- `GroupFolder`：`{ group_id, folder_id, parent_folder_id, folder_name, created_time, last_modified_time, creator_id, file_count }`
- 群文件每群容量上限 256MB；文件夹最多 100 个、名称 1-32 字符。
- 上传 / 移动 / 重命名 / 删除 / 建夹等操作仅群主与管理员可执行（`upload_group_file` 上传本身任意群成员可执行，需已在群内）。

***

## 7. 已知限制与说明

- 历史消息最多一次拉取 30 条（Milky 文档约定）。
- 全体禁言只支持「开/关」语义，不做时长参数。
- 事件推送依赖 WebSocket 在线连接；机器人离线期间产生的事件不会补发，请用拉取接口兜底（如 `get_history_messages`、`get_friend_requests`、`get_group_invites`）。
- 私聊 / 群聊文件通过对应下载 URL 接口获取；`message_receive` 中的 `file` 段已带直链。
- 所有端点仅支持 `POST` 与 `application/json`。

***

## 8. 与现有框架对接提示

- **NoneBot2 / Koishi**：选用支持 OneBot/OneBot-12 系或 Milky 的适配器时，将适配器 `access_token` 配置为组合式 `{uid}.{login_key}`，`base_url` 指向 `/bot/api`、事件订阅指向 `/bot/event` 即可。
- **拉取兜底**：连接中断后建议先调用 `get_group_list` / `get_friend_list` 全量同步，再用 `get_history_messages` 按 `message_seq` 增量补齐。
- **身份**：机器人即一个 KnockChat 用户，可加好友、进群、收消息；其头像/昵称可通过 `set_avatar` / `set_nickname` 修改。


# 本地存储指南（KnockChat）

本文档梳理 KnockChat 存储在**本机**（`localStorage` / `sessionStorage` / Cache API）的全部数据键，便于维护与排查。

> 所有键名统一在 `src/js/constants.js` 的 `LS_KEYS` 中**集中定义**，业务代码一律通过 `LS_KEYS.xxx` 引用，禁止散落字符串字面量。
> ⚠️ 键名即实际存储 key，**改动会破坏现有用户数据/配置/缓存**，非必要勿修改。新增存储键必须先加入 `LS_KEYS`。

***

## 1. 登录与会话（localStorage）

| 键                        | LS\_KEYS 常量       | 用途               | 格式                               | 生命周期              |
| ------------------------ | ----------------- | ---------------- | -------------------------------- | ----------------- |
| `mjchat_session`         | `SESSION`         | 登录会话             | `{username, uid, token, pwhash}` | 登录写入；登出/注销/验证失败删除 |
| `mjchat_last_login`      | `LAST_LOGIN`      | 上次登录账号（快捷登录展示）   | 用户名                              | 登录写入；登出删除         |
| `mjchat_last_login_time` | `LAST_LOGIN_TIME` | 上次登录时间（未读计数兜底基准） | ISO 时间串                          | 登录写入；登出删除         |

## 2. 用户加密设置（localStorage）

以「密码哈希 + PBKDF2 盐」派生的 AES-GCM 密钥加密，密钥仅存内存，登出即清除。

| 键                           | LS\_KEYS 常量      | 用途       | 格式                               |
| --------------------------- | ---------------- | -------- | -------------------------------- |
| `mjchat_user_configs`       | `USER_CONFIGS`   | 各用户加密设置表 | `{username: {iv, data}}`（AES 密文） |
| `mjchat_keymeta_<username>` | `KEYMETA_PREFIX` | 每用户密钥元数据 | `{salt, iterations}`             |

### 加密配置包含的子设置（解密后）

- 主题、主题色
- 未读状态 `{publicLastRead, privateLastRead}`（`publicLastRead` 为公聊遗留字段，公聊移除后恒为 `null`）
- 已关闭的隐私横幅集合
- 通知设置 `{showNotify, public, private, mention, sound, sampleRate}`

## 3. AI 设置（localStorage，AES 加密，含 API Key）

| 键                            | LS\_KEYS 常量             | 用途                              |
| ---------------------------- | ----------------------- | ------------------------------- |
| `cika_ai_model_settings`     | `AI_MODEL_SETTINGS`     | AI 模型配置（Base URL、API Key、模型列表等） |
| `cika_ai_translate_settings` | `AI_TRANSLATE_SETTINGS` | AI 翻译配置                         |

> 注销账号时会连同用户配置一并清除。

## 4. 聊天缓存（localStorage，加密）

| 键                            | LS\_KEYS 常量        | 用途                      |
| ---------------------------- | ------------------ | ----------------------- |
| `mjchat_msgcache_<username>` | `MSG_CACHE_PREFIX` | 聊天记录加密缓存（群聊/私聊历史，供离线浏览；群聊按 gid 隔离，每群上限 200 条） |

## 5. 媒体缓存（localStorage）

| 键                          | LS\_KEYS 常量     | 用途             | 生命周期                |
| -------------------------- | --------------- | -------------- | ------------------- |
| `mjchat_avatar_<username>` | `AVATAR_PREFIX` | 头像 URL 缓存      | LRU 上限 200 条，超出淘汰最旧 |
| `mjchat_avatar_index`      | `AVATAR_INDEX`  | 头像缓存索引（LRU 顺序） | 随写入维护               |
| `mjchat_ud_bg_<username>`  | `BG_PREFIX`     | 用户主页背景 URL 缓存  | TTL 30 天            |

## 6. 主题 / 字体（localStorage）

| 键                     | LS\_KEYS 常量   | 用途                 |
| --------------------- | ------------- | ------------------ |
| `cika_theme_store_v1` | `THEME_STORE` | 主题状态（当前主题、自定义主题列表） |
| `cika_font_store_v1`  | `FONT_STORE`  | 字体设置（字体族、字号缩放）     |

> 当前激活的主题/字体 id 会随云端同步跨设备恢复；**自定义主题的完整定义仅存本机**（不随云同步），换设备后若云端主题 id 对应的自定义主题不存在，将回退到内置暗黑主题。

## 7. 图片字节缓存（Cache API）

| 键                  | LS\_KEYS 常量   | 用途                               | 生命周期                     |
| ------------------ | ------------- | -------------------------------- | ------------------------ |
| `cika-imgcache-v1` | `IMGCACHE_DB` | 图片字节缓存（IndexedDB 不适用时的 Cache 存储） | 条目上限 500、TTL 7 天，超出按最旧淘汰 |

## 8. 功能状态（localStorage）

| 键                           | LS\_KEYS 常量     | 用途                               |
| --------------------------- | --------------- | -------------------------------- |
| `mjchat_public_muted`       | `PUBLIC_MUTED`  | 公聊免打扰（`'1'`/`'0'`；公聊已移除，兼容清理用）  |
| `mjchat_group_muted`        | `GROUP_MUTED`   | 群聊免打扰（`{gid: true}`，v099）               |
| `mjchat_private_muted`      | `PRIVATE_MUTED` | 私聊会话免打扰（`{sessionId: true}`）     |
| `mjchat_blockword_settings` | `BLOCKWORD`     | 屏蔽词设置 `{enabled, types, method}` |
| `mjchat_page_stack`         | `PAGE_STACK`    | 页面导航栈（恢复上次所在页）                   |

## 9. 会话级数据（sessionStorage）

| 键                         | LS\_KEYS 常量        | 用途        | 生命周期  |
| ------------------------- | ------------------ | --------- | ----- |
| `mjchat_csrf`             | `CSRF`             | CSRF 令牌   | 单次进程内 |
| `mjchat_banner_dismissed` | `BANNER_DISMISSED` | 隐私横幅已关闭标记 | 登出时重置 |

## 10. 旧版遗留键（不再写入，仅启动兜底清理删除）

以下键在旧版本中为明文存储，已并入第 2 节的加密用户配置。`initUserSettings`（登录后）会迁移旧值并删除；若用户已有加密配置（跳过迁移分支），残留旧键也会在启动时兜底清理。

| 键                         | LS\_KEYS 常量          | 原用途     |
| ------------------------- | -------------------- | ------- |
| `mjchat_theme`            | `LEGACY_THEME`       | 旧主题     |
| `mjchat_theme_color`      | `LEGACY_THEME_COLOR` | 旧主题色    |
| `mjchat_unread`           | `LEGACY_UNREAD`      | 旧未读状态   |
| `dismissedPrivacyBanners` | `LEGACY_BANNERS`     | 旧隐私横幅标记 |

## 11. 云端设置同步（跨设备）

**必要且适合跨设备云同步的用户设置**会上传到服务端（S3 `users/<uid>/info.json` 的 `cloud_settings` 字段），实现换设备登录自动恢复。冲突策略：**云端为权威**——登录/会话恢复后拉取云端设置覆盖本地；本地设置变更后防抖（1.2s）推送云端。

### 同步范围

| 类别    | 内容                         | 云端字段        |
| ----- | -------------------------- | ----------- |
| 应用设置  | 主题 id、主题色、字体/字号/字重 id、通知设置 | `app`       |
| 屏蔽词   | `{enabled, types, method}` | `blockword` |
| AI 设置 | 模型配置与翻译配置（**含 API Key**）   | `ai`        |

**不同步（设备本地数据）**：未读状态、已关闭横幅列表、自定义主题定义（仅同步当前激活主题 id）、私聊会话与聊天记录缓存、群聊/私聊免打扰标记。

### 加密与安全

- 云端密钥由「**账号级随机盐** + 客户端密码预哈希」PBKDF2-HMAC-SHA256（10 万次迭代）派生，AES-GCM 加密**整个设置包**后上传；服务端只见密文，无法解读。
- 账号级盐明文随包存储（盐无需保密，仅用于防彩虹表）；换设备登录后凭密码即可重建密钥解密。
- 登录/会话恢复在 `storage.js` 的 `initUserSettings` 末尾触发拉取（`CloudSync.onLocalSettingsReady`），设置变更通过 `notifyCloudSettingsChanged()` 通知（由 `syncSettingsToEncryptedStore`、`saveAIModelSettings`、`saveAITranslateSettings`、`saveBlockwordSettings` 统一调用）。
- **修改密码注意**：云端密文由旧密码派生密钥加密，改密后无法解密；此时以当前设备本地设置为准，重新生成账号级盐并加密上传（旧密文对新密码不可读，等同丢弃）。

### 相关文件

- 实现：`src/js/cloudsync.js`（推拉、加解密、防抖去重）、`src/js/storage.js`（通知 hook）
- 后端 RPC：`s3rpc_get_user_settings` / `s3rpc_update_user_settings`（见 `docs/s3-config-guide.md`）

***

## 维护约定

1. **新增存储键**：先在 `constants.js` 的 `LS_KEYS` 增加一项（键名保持稳定），业务代码用 `LS_KEYS.xxx`。
2. **不推荐修改键名**：容易乱
3. **加密规则**：含敏感信息（API Key、聊天记录、用户设置）必须走 AES-GCM（见 `storage.js`）；纯缓存（头像/背景 URL）可用明文。
4. **清理**：登出清理会话与 AI 密钥元数据；注销彻底清除用户配置、AI 设置与消息缓存；图片缓存由 LRU/TTL 自动淘汰。


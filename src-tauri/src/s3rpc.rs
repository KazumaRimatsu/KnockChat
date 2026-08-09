//! KnockChat S3 业务命令层。
//! 前端通过 Tauri invoke 调用 `s3rpc_<rpc名>`，参数统一为 `{ params: {...} }`（serde_json::Value），
//! 返回 `serde_json::Value`（与旧 Supabase RPC 的结构保持一致，前端改动最小）。

use crate::s3::{ObjectMeta, S3, S3Config};
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{Duration, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::{Arc, Mutex, OnceLock};

static CFG: OnceLock<Mutex<Option<Arc<S3>>>> = OnceLock::new();

/// 设置全局 S3 客户端（lib.rs 在启动时调用）
pub fn set_s3(s3: Option<S3>) {
    let lock = CFG.get_or_init(|| Mutex::new(None));
    if let Ok(mut g) = lock.lock() {
        *g = s3.map(|s| Arc::new(s));
    }
}

/// 获取全局 S3 客户端，未配置时返回错误
fn s3() -> Result<Arc<S3>, String> {
    let lock = CFG.get_or_init(|| Mutex::new(None));
    let g = lock.lock().map_err(|_| "S3 配置锁异常".to_string())?;
    g.clone().ok_or_else(|| "S3 存储桶未配置，请先完成存储桶配置（见配置指南）".to_string())
}

fn err(msg: &str) -> Result<Value, String> {
    Err(msg.to_string())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn new_id() -> String {
    let ms = Utc::now().timestamp_millis().max(0) as u64;
    let r: u64 = rand::random();
    format!("{:x}{:016x}", ms, r)
}

/// 用户名 → 对象 Key 安全编码（保留 ASCII 字母数字 .-_，其余字节 %XX）
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// 用户主键：users/<uid>.json（uid 从 1 开始递增，类似 QQ 号）
fn user_key(uid: u64) -> String {
    format!("users/{}.json", uid)
}

/// 统一用户索引：users/_index.json 存 { username: uid }
const USER_INDEX_KEY: &str = "users/_index.json";

/// 读取统一用户索引（username → uid 映射）
async fn user_index_map(s3: &Arc<S3>) -> Result<Value, String> {
    Ok(json_get(s3, USER_INDEX_KEY).await?.unwrap_or_else(|| json!({})))
}

/// 统一索引写入（读-改-写）
async fn user_index_put(s3: &Arc<S3>, username: &str, uid: u64) -> Result<(), String> {
    let mut map = user_index_map(s3).await?;
    if let Some(obj) = map.as_object_mut() {
        obj.insert(username.to_string(), json!(uid));
    } else {
        map = json!({ username: uid });
    }
    json_put(s3, USER_INDEX_KEY, &map).await
}

/// 统一索引删除条目
async fn user_index_remove(s3: &Arc<S3>, username: &str) -> Result<(), String> {
    let mut map = user_index_map(s3).await?;
    if let Some(obj) = map.as_object_mut() {
        obj.remove(username);
        json_put(s3, USER_INDEX_KEY, &map).await?;
    }
    Ok(())
}

/// uid 计数器：users/_meta.json 存 {"next_uid": N}
const UID_META_KEY: &str = "users/_meta.json";

/// 分配一个新的 uid（从 1 开始递增，类 QQ 号）。
/// S3 无原子操作：读 next_uid → 尝试写用户对象（占用检查）→ 更新计数器。
async fn next_uid(s3: &Arc<S3>) -> Result<u64, String> {
    for _ in 0..50 {
        let next = match json_get(s3, UID_META_KEY).await? {
            Some(v) => v["next_uid"].as_u64().unwrap_or(1).max(1),
            None => 1,
        };
        // 占用检查：该 uid 尚未被写用户文件，则占用成功（并发注册时几乎不可能同号）
        if json_get(s3, &user_key(next)).await?.is_none() {
            json_put(s3, UID_META_KEY, &json!({ "next_uid": next + 1 })).await?;
            return Ok(next);
        }
    }
    Err("uid 分配冲突，请重试".to_string())
}

fn session_key(token: &str) -> String {
    format!("sessions/{}.json", enc(token))
}

fn pub_msg_key(id: &str) -> String {
    format!("public/messages/{}.json", id)
}

fn priv_sess_key(sid: &str) -> String {
    format!("private/sessions/{}.json", sid)
}

fn priv_msg_key(sid: &str, id: &str) -> String {
    format!("private/messages/{}/{}.json", sid, id)
}

/// 私聊会话 id：两个 uid 按数值排序拼接（唯一且可推导）
fn private_session_id(uid_a: u64, uid_b: u64) -> String {
    if uid_a < uid_b {
        format!("{}__{}", uid_a, uid_b)
    } else {
        format!("{}__{}", uid_b, uid_a)
    }
}

fn valid_username(u: &str) -> bool {
    let n = u.chars().count();
    if n < 2 || n > 15 {
        return false;
    }
    !u.chars().any(|c| {
        // 空白 / 控制字符（C0/C1 与 Unicode Cc）/
        // 零宽及不可见格式字符（Cf）：U+00AD 软连字符、U+061C 阿拉伯字母数字符号、
        // U+200B-200F 零宽空格/连接符/分隔符、U+202A-202E 双向文本、U+2060-2064/2066-2069 隐形格式、U+FEFF BOM
        c.is_whitespace()
            || c.is_control()
            || matches!(
                c,
                '\u{00AD}' | '\u{061C}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{200E}' | '\u{200F}'
                    | '\u{202A}' | '\u{202B}' | '\u{202C}' | '\u{202D}' | '\u{202E}' | '\u{2060}' | '\u{2061}'
                    | '\u{2062}' | '\u{2063}' | '\u{2064}' | '\u{2066}' | '\u{2067}' | '\u{2068}' | '\u{2069}'
                    | '\u{FEFF}'
            )
            || matches!(
                c,
                '<' | '>' | '&' | '"' | '\'' | '\\' | '/' | '#' | '?' | ':' | '%'
                    | '{' | '}' | '|' | '^' | '`' | '~' | '[' | ']' | '@' | '*' | '$'
                    | '!' | '(' | ')' | '=' | '+' | ',' | ';'
            )
    })
}

// ==================== JSON 读写辅助 ====================

async fn json_get(s3: &S3, key: &str) -> Result<Option<Value>, String> {
    match s3.get_object(key).await? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("解析 {} 失败: {e}", key)),
        None => Ok(None),
    }
}

async fn json_put(s3: &S3, key: &str, v: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(v).map_err(|e| format!("序列化失败: {e}"))?;
    s3.put_object(key, bytes, "application/json").await
}

async fn fetch_json_all(s3: &Arc<S3>, keys: &[String]) -> Vec<Value> {
    let mut out = Vec::with_capacity(keys.len());
    for chunk in keys.chunks(16) {
        let fut: Vec<_> = chunk.iter().map(|k| json_get(s3, k)).collect();
        let res = futures::future::join_all(fut).await;
        for r in res {
            if let Ok(Some(v)) = r {
                out.push(v);
            }
        }
    }
    out
}

fn sort_desc_by_created(arr: &mut [Value]) {
    arr.sort_by(|a, b| {
        let ta = a["created_at"].as_str().unwrap_or("");
        let tb = b["created_at"].as_str().unwrap_or("");
        tb.cmp(ta)
    });
}

// ==================== 会话管理 ====================

async fn create_session(s3: &Arc<S3>, uid: u64, username: &str) -> Result<String, String> {
    let token = new_id();
    let sess = json!({
        "uid": uid,
        "username": username,
        "created_at": now_iso(),
        "expires_at": (Utc::now() + Duration::days(30)).to_rfc3339_opts(SecondsFormat::Millis, true)
    });
    json_put(s3, &session_key(&token), &sess).await?;
    Ok(token)
}

async fn verify_session(s3: &Arc<S3>, uid: u64, token: &str) -> Result<bool, String> {
    if token.is_empty() {
        return Ok(false);
    }
    let Some(v) = json_get(s3, &session_key(token)).await? else {
        return Ok(false);
    };
    let suid = v["uid"].as_u64().unwrap_or(0);
    let exp = v["expires_at"].as_str().unwrap_or("");
    if suid != uid || exp.is_empty() {
        return Ok(false);
    }
    let expired = chrono::DateTime::parse_from_rfc3339(exp)
        .map(|d| d <= Utc::now())
        .unwrap_or(true);
    Ok(!expired)
}

// ==================== 用户文件 ====================

async fn get_user(s3: &Arc<S3>, uid: u64) -> Result<Option<Value>, String> {
    json_get(s3, &user_key(uid)).await
}

async fn save_user(s3: &Arc<S3>, uid: u64, v: &Value) -> Result<(), String> {
    json_put(s3, &user_key(uid), v).await
}

// ==================== 细分限制（restrictions） ====================
//
// users/<uid>.json 的 "restrictions" 字段为限制对象，每项：
//   "<name>": { "enabled": true, "until": "ISO-8601 或空串" }
// 支持的限制项：
//   login        禁止登录
//   public_text  公聊发送文字消息
//   public_media 公聊发送文件/图片/语音/链接等多媒体消息
//   new_private  发起新的私聊会话
//   private_msg  发送私聊消息
//   profile_edit 修改头像与背景（含主页资料）
// 定时解封：until 到期后在任何检查点懒清除（自动恢复），无需定时任务。
// 智能体（role: "agent"）不受任何限制。

/// 限制项的中文提示（供 RPC 返回 message）
fn restriction_msg(name: &str) -> &'static str {
    match name {
        "login" => "您的账户已被限制登录",
        "public_text" => "您已被限制发送公聊文字消息",
        "public_media" => "您已被限制发送公聊文件/图片等多媒体消息",
        "new_private" => "您已被限制发起新的私聊",
        "private_msg" => "您已被限制发送私聊消息",
        "profile_edit" => "您已被限制修改头像与背景",
        _ => "您已被限制该操作",
    }
}

/// 同步判断用户是否受 name 限制（不写回）。Some = 受限（含过期未清除的视为不限）。
fn restriction_blocked(user: &Value, name: &str) -> bool {
    if user["role"].as_str() == Some("agent") {
        return false; // 智能体不受限
    }
    let Some(r) = user["restrictions"].get(name) else {
        return false;
    };
    if r["enabled"].as_bool().unwrap_or(false) != true {
        return false;
    }
    let until = r["until"].as_str().unwrap_or("");
    if !until.is_empty() {
        if let Ok(exp) = chrono::DateTime::parse_from_rfc3339(until) {
            if exp <= Utc::now() {
                return false; // 已到期，视为未受限（懒清除由 check_restriction 完成）
            }
        }
    }
    true
}

/// 异步检查用户是否受 name 限制，返回 true=允许。过期时自动懒清除并写回。
async fn check_restriction(s3: &Arc<S3>, uid: u64, name: &str) -> Result<bool, String> {
    let Some(mut user) = get_user(s3, uid).await? else {
        return Ok(true);
    };
    if user["role"].as_str() == Some("agent") {
        return Ok(true);
    }
    let Some(r) = user["restrictions"].get(name) else {
        return Ok(true);
    };
    if r["enabled"].as_bool().unwrap_or(false) != true {
        return Ok(true);
    }
    let until = r["until"].as_str().unwrap_or("");
    if !until.is_empty() {
        if let Ok(exp) = chrono::DateTime::parse_from_rfc3339(until) {
            if exp <= Utc::now() {
                // 定时解封到期：清除该限制并写回
                if let Some(ro) = user["restrictions"].as_object_mut() {
                    ro.remove(name);
                    save_user(s3, uid, &user).await?;
                }
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// 当前生效的细分限制列表（供登录/会话响应返回给前端展示）
fn active_restrictions(user: &Value) -> Vec<&str> {
    let mut out = Vec::new();
    for name in ["login", "public_text", "public_media", "new_private", "private_msg", "profile_edit"] {
        if restriction_blocked(user, name) {
            out.push(name);
        }
    }
    out
}

/// 通过用户名查 uid（统一索引 users/_index.json）
async fn uid_by_name(s3: &Arc<S3>, username: &str) -> Result<Option<u64>, String> {
    Ok(user_index_map(s3).await?.get(username).and_then(|v| v.as_u64()))
}

async fn get_user_by_name(s3: &Arc<S3>, username: &str) -> Result<Option<Value>, String> {
    match uid_by_name(s3, username).await? {
        Some(uid) => get_user(s3, uid).await,
        None => Ok(None),
    }
}

fn default_user(username: &str, password_hash: &str, uid: u64) -> Value {
    json!({
        "uid": uid,
        "username": username,
        "password_hash": password_hash,
        "role": "user",
        "banned": false,
        "avatar_url": "",
        "bg_url": "",
        "email": "",
        "birthday": "",
        "bio": "",
        "tags": [],
        "blocked": [],
        "created_at": now_iso(),
        "last_login_at": "",
        "last_login_ip": ""
    })
}

fn user_public_fields(v: &Value) -> Value {
    json!({
        "success": true,
        "uid": v["uid"].as_u64().unwrap_or(0),
        "username": v["username"].as_str().unwrap_or(""),
        "role": v["role"].as_str().unwrap_or("user"),
        "banned": v["banned"].as_bool().unwrap_or(false),
        "avatar_url": v["avatar_url"].as_str().unwrap_or(""),
        "bg_url": v["bg_url"].as_str().unwrap_or(""),
        "email": v["email"].as_str().unwrap_or(""),
        "birthday": v["birthday"].as_str().unwrap_or(""),
        "bio": v["bio"].as_str().unwrap_or(""),
        "tags": v["tags"].clone(),
        "created_at": v["created_at"].as_str().unwrap_or("")
    })
}

// ==================== 认证 ====================

pub async fn s3rpc_check_username_exists(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let username = params["p_username"].as_str().unwrap_or("");
    if username.is_empty() {
        return err("缺少用户名");
    }
    let exists = get_user_by_name(&s, username).await?.is_some();
    Ok(json!({ "exists": exists }))
}

async fn do_register(s3: &Arc<S3>, username: &str, password_hash: &str) -> Result<Value, String> {
    if !valid_username(username) {
        return Ok(json!({ "success": false, "message": "昵称不合法（2-15 个字符）" }));
    }
    if password_hash.len() < 10 {
        return Ok(json!({ "success": false, "message": "密码哈希无效" }));
    }
    if get_user_by_name(s3, username).await?.is_some() {
        return Ok(json!({ "success": false, "message": "该昵称已被使用" }));
    }
    let uid = next_uid(s3).await?;
    save_user(s3, uid, &default_user(username, password_hash, uid)).await?;
    user_index_put(s3, username, uid).await?;
    let token = create_session(s3, uid, username).await?;
    Ok(json!({ "success": true, "uid": uid, "username": username, "session_token": token }))
}

pub async fn s3rpc_register_user_secure(params: Value) -> Result<Value, String> {
    let s = s3()?;
    do_register(&s, params["p_username"].as_str().unwrap_or(""), params["p_password_hash"].as_str().unwrap_or("")).await
}

pub async fn s3rpc_register_user(params: Value) -> Result<Value, String> {
    s3rpc_register_user_secure(params).await
}

async fn do_login(s3: &Arc<S3>, username: &str, password_hash: &str) -> Result<Value, String> {
    // v087: 仅支持 uid 登录（昵称登录已移除）——入参必须是纯数字 uid
    let input = username.trim();
    let uid = match input.parse::<u64>() {
        Ok(uid) => uid,
        Err(_) => return Ok(json!({ "success": false, "message": "UID格式错误，请输入纯数字UID" })),
    };
    let user = get_user(s3, uid).await?; // 网络错误向上传播
    let Some(mut user) = user else {
        return Ok(json!({ "success": false, "message": "UID或密码错误" }));
    };
    if user["password_hash"].as_str().unwrap_or("") != password_hash {
        return Ok(json!({ "success": false, "message": "UID或密码错误" }));
    }
    if user["banned"].as_bool().unwrap_or(false) {
        return Ok(json!({ "success": true, "banned": true, "message": "您的账户已被封禁，无法登录" }));
    }
    // 细分限制：登录限制（含定时解封——到期自动清除后放行）
    if restriction_blocked(&user, "login") {
        return Ok(json!({ "success": true, "banned": true, "message": restriction_msg("login") }));
    }
    if let Some(ro) = user["restrictions"].as_object_mut() {
        if ro.contains_key("login") {
            ro.remove("login"); // 过期限制在此懒清除
            save_user(s3, uid, &user).await?;
        }
    }
    let uid = user["uid"].as_u64().unwrap_or(uid);
    // 会话以用户记录中的真实昵称为准（入参是数字 uid）
    let real_name = user["username"].as_str().unwrap_or(input).to_string();
    let token = create_session(s3, uid, &real_name).await?;
    let avatar = user["avatar_url"].as_str().unwrap_or("");
    Ok(json!({
        "success": true,
        "uid": uid,
        "username": real_name,
        "session_token": token,
        "avatar_url": avatar,
        "banned": false,
        "role": user["role"].as_str().unwrap_or("user"),
        "restrictions": active_restrictions(&user)
    }))
}

pub async fn s3rpc_verify_login_secure_rate_limited(params: Value) -> Result<Value, String> {
    let s = s3()?;
    do_login(&s, params["p_username"].as_str().unwrap_or(""), params["p_password_hash"].as_str().unwrap_or("")).await
}

pub async fn s3rpc_verify_login_secure(params: Value) -> Result<Value, String> {
    s3rpc_verify_login_secure_rate_limited(params).await
}

pub async fn s3rpc_verify_login(params: Value) -> Result<Value, String> {
    s3rpc_verify_login_secure_rate_limited(params).await
}

async fn do_verify_session(s3: &Arc<S3>, uid: u64, username: &str, token: &str) -> Result<Value, String> {
    let valid = verify_session(s3, uid, token).await?;
    if !valid {
        return Ok(json!({ "success": true, "valid": false }));
    }
    let user = get_user(s3, uid).await?.unwrap_or_else(|| json!({}));
    let name = if username.is_empty() {
        user["username"].as_str().unwrap_or("")
    } else {
        username
    };
    Ok(json!({
        "success": true,
        "valid": true,
        "uid": uid,
        "username": name,
        "avatar_url": user["avatar_url"].as_str().unwrap_or(""),
        "banned": user["banned"].as_bool().unwrap_or(false),
        "restrictions": active_restrictions(&user),
        "needs_relogin": false
    }))
}

pub async fn s3rpc_verify_session_secure(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let username = params["p_username"].as_str().unwrap_or("");
    let token = params["p_token"].as_str().or_else(|| params["p_session_token"].as_str()).unwrap_or("");
    if uid == 0 {
        return Ok(json!({ "success": true, "valid": false }));
    }
    do_verify_session(&s, uid, username, token).await
}

pub async fn s3rpc_verify_session(params: Value) -> Result<Value, String> {
    s3rpc_verify_session_secure(params).await
}

pub async fn s3rpc_change_password_secure(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let old_hash = params["p_old_password_hash"].as_str().unwrap_or("");
    let new_hash = params["p_new_password_hash"].as_str().unwrap_or("");
    let Some(mut user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    if user["password_hash"].as_str().unwrap_or("") != old_hash {
        return Ok(json!({ "success": false, "message": "原密码错误" }));
    }
    user["password_hash"] = json!(new_hash);
    save_user(&s, uid, &user).await?;
    let username = user["username"].as_str().unwrap_or("");
    let token = create_session(&s, uid, username).await?;
    Ok(json!({ "success": true, "session_token": token }))
}

pub async fn s3rpc_change_password(params: Value) -> Result<Value, String> {
    s3rpc_change_password_secure(params).await
}

pub async fn s3rpc_delete_my_account(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let hash = params["p_password_hash"].as_str().unwrap_or("");
    let Some(user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    if user["password_hash"].as_str().unwrap_or("") != hash {
        return Ok(json!({ "success": false, "message": "密码错误" }));
    }
    let username = user["username"].as_str().unwrap_or("");
    // 删除用户资料与统一索引
    s.delete_object(&user_key(uid)).await?;
    if !username.is_empty() {
        let _ = user_index_remove(&s, &username).await;
    }
    // 删除该用户的会话
    let sess_keys = s.list_objects("sessions/").await?;
    let mut to_delete = Vec::new();
    for meta in &sess_keys {
        if let Some(v) = json_get(&s, &meta.key).await? {
            if v["uid"].as_u64().unwrap_or(0) == uid {
                to_delete.push(meta.key.clone());
            }
        }
    }
    for k in to_delete {
        let _ = s.delete_object(&k).await;
    }
    // 删除相关私聊会话与消息
    let sessions = list_all_sessions(&s).await?;
    for sess in &sessions {
        let u1 = sess["user1_uid"].as_u64().unwrap_or(0);
        let u2 = sess["user2_uid"].as_u64().unwrap_or(0);
        if u1 == uid || u2 == uid {
            let sid = sess["id"].as_str().unwrap_or("");
            if let Ok(msgs) = s.list_objects(&format!("private/messages/{}/", sid)).await {
                for m in msgs {
                    let _ = s.delete_object(&m.key).await;
                }
            }
            let _ = s.delete_object(&priv_sess_key(sid)).await;
        }
    }
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_record_login(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    if uid == 0 {
        return Ok(json!({ "success": true }));
    }
    if let Some(mut user) = get_user(&s, uid).await? {
        user["last_login_at"] = json!(now_iso());
        user["last_login_ip"] = json!(params["p_ip"].as_str().unwrap_or("unknown"));
        let _ = save_user(&s, uid, &user).await;
    }
    Ok(json!({ "success": true }))
}

// ==================== 公聊 ====================

pub async fn s3rpc_get_public_messages(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let limit = params["p_limit"].as_u64().unwrap_or(200).min(500) as usize;
    let before_id = params["p_before_id"].as_str().unwrap_or("").trim();
    let after_id = params["p_after_id"].as_str().unwrap_or("").trim();

    let metas = s.list_objects("public/messages/").await?;
    let mut ids: Vec<String> = metas
        .into_iter()
        .filter(|m| m.key.starts_with("public/messages/") && m.key.ends_with(".json"))
        .map(|m| m.key["public/messages/".len()..m.key.len() - 5].to_string())
        .collect();
    ids.sort(); // Key 字典序 ≈ 时间序（id 前缀为十六进制毫秒时间戳）

    let selected: Vec<String> = if !before_id.is_empty() {
        // 加载更早的消息：取 before_id 之前的最后 limit 条
        let mut v: Vec<String> = ids.iter().filter(|i| i.as_str() < before_id).cloned().collect();
        v.reverse();
        v.truncate(limit);
        v
    } else if !after_id.is_empty() {
        // 增量轮询：取 after_id 之后的最多 50 条
        let v: Vec<String> = ids.iter().filter(|i| i.as_str() > after_id).cloned().collect();
        v[..v.len().min(50)].to_vec()
    } else {
        // 最新 limit 条
        let mut v: Vec<String> = ids.into_iter().rev().take(limit).collect();
        v.reverse();
        v
    };

    let keys: Vec<String> = selected.iter().map(|id| pub_msg_key(id)).collect();
    let mut msgs = fetch_json_all(&s, &keys).await;
    sort_desc_by_created(&mut msgs);
    Ok(Value::Array(msgs))
}

pub async fn s3rpc_send_public_message_secure(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    // 细分限制：带附件（图片/语音）或含链接的消息按"多媒体"限制，纯文字按"文字"限制
    let text = params["p_text"].as_str().unwrap_or("");
    let has_media = !params["p_image_url"].as_str().unwrap_or("").is_empty()
        || !params["p_audio_url"].as_str().unwrap_or("").is_empty();
    let has_link = !text.is_empty()
        && (text.contains("://") || text.to_ascii_lowercase().starts_with("www."));
    let restr = if has_media || has_link { "public_media" } else { "public_text" };
    if !check_restriction(&s, uid, restr).await? {
        return Ok(json!({ "success": false, "message": restriction_msg(restr) }));
    }
    let user = get_user(&s, uid).await?.unwrap_or_else(|| json!({}));
    let username = user["username"].as_str().unwrap_or("");
    let msg = json!({
        "id": new_id(),
        "sender": username,
        "sender_uid": uid,
        "text": params["p_text"].as_str().unwrap_or(""),
        "image_url": params["p_image_url"].as_str().unwrap_or(""),
        "audio_url": params["p_audio_url"].as_str().unwrap_or(""),
        "audio_dur": params["p_audio_dur"].as_f64().unwrap_or(0.0),
        "reply_to_id": params["p_reply_to_id"].as_str().unwrap_or(""),
        "reply_content": params["p_reply_content"].as_str().unwrap_or(""),
        "is_system": params["p_is_system"].as_bool().unwrap_or(false),
        "sender_deleted": false,
        "created_at": now_iso()
    });
    json_put(&s, &pub_msg_key(msg["id"].as_str().unwrap()), &msg).await?;
    Ok(json!({ "success": true, "message": msg }))
}

pub async fn s3rpc_delete_public_message(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let msg_id = params["p_msg_id"].as_str().unwrap_or("");
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let key = pub_msg_key(msg_id);
    if let Some(msg) = json_get(&s, &key).await? {
        let owner = msg["sender_uid"].as_u64().unwrap_or(0);
        if owner != 0 && owner != uid {
            return Ok(json!({ "success": false, "message": "只能删除自己的消息" }));
        }
    }
    s.delete_object(&key).await?;
    Ok(json!({ "success": true }))
}

// ==================== 私聊 ====================

async fn list_all_sessions(s3: &Arc<S3>) -> Result<Vec<Value>, String> {
    let metas = s3.list_objects("private/sessions/").await?;
    let keys: Vec<String> = metas
        .into_iter()
        .filter(|m| m.key.starts_with("private/sessions/") && m.key.ends_with(".json"))
        .map(|m| m.key)
        .collect();
    Ok(fetch_json_all(s3, &keys).await)
}

pub async fn s3rpc_get_private_sessions(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let sessions = list_all_sessions(&s).await?;
    let mut mine: Vec<Value> = sessions
        .into_iter()
        .filter(|v| {
            let u1 = v["user1_uid"].as_u64().unwrap_or(0);
            let u2 = v["user2_uid"].as_u64().unwrap_or(0);
            if u1 == uid {
                v["deleted_by_user1"].as_bool().unwrap_or(false) == false
            } else if u2 == uid {
                v["deleted_by_user2"].as_bool().unwrap_or(false) == false
            } else {
                false
            }
        })
        .collect();
    mine.sort_by(|a, b| {
        let ta = a["updated_at"].as_str().unwrap_or("");
        let tb = b["updated_at"].as_str().unwrap_or("");
        tb.cmp(ta)
    });
    Ok(Value::Array(mine))
}

pub async fn s3rpc_create_private_session(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let user1_uid = params["p_user1_uid"].as_u64().unwrap_or(0);
    let user2_uid = params["p_user2_uid"].as_u64().unwrap_or(0);
    if user1_uid == 0 || user2_uid == 0 {
        return err("缺少参数");
    }
    let sid = private_session_id(user1_uid, user2_uid);
    let key = priv_sess_key(&sid);
    let user1 = get_user(&s, user1_uid).await?.unwrap_or_else(|| json!({}));
    let user2 = get_user(&s, user2_uid).await?.unwrap_or_else(|| json!({}));
    let user1_name = user1["username"].as_str().unwrap_or("").to_string();
    let user2_name = user2["username"].as_str().unwrap_or("").to_string();
    match json_get(&s, &key).await? {
        Some(mut v) => {
            // 已有会话：解除双方删除标记并刷新时间
            v["deleted_by_user1"] = json!(false);
            v["deleted_by_user2"] = json!(false);
            v["updated_at"] = json!(now_iso());
            json_put(&s, &key, &v).await?;
        }
        None => {
            // 细分限制：仅真正"新建会话"时拦截；已有会话重新激活不视为新发起
            if !check_restriction(&s, user1_uid, "new_private").await? {
                return Ok(json!({ "success": false, "message": restriction_msg("new_private") }));
            }
            let v = json!({
                "id": sid,
                "user1_uid": user1_uid,
                "user2_uid": user2_uid,
                "user1": user1_name,
                "user2": user2_name,
                "updated_at": now_iso(),
                "last_message": "",
                "deleted_by_user1": false,
                "deleted_by_user2": false
            });
            json_put(&s, &key, &v).await?;
        }
    }
    Ok(json!({ "success": true, "session_id": sid }))
}

async fn session_accessible(s3: &Arc<S3>, sid: &str, uid: u64) -> Result<Option<Value>, String> {
    let Some(v) = json_get(s3, &priv_sess_key(sid)).await? else {
        return Ok(None);
    };
    let u1 = v["user1_uid"].as_u64().unwrap_or(0);
    let u2 = v["user2_uid"].as_u64().unwrap_or(0);
    if u1 != uid && u2 != uid {
        return Ok(None);
    }
    Ok(Some(v))
}

pub async fn s3rpc_get_private_messages(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let sid = params["p_session_id"].as_str().unwrap_or("");
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let limit = params["p_limit"].as_u64().unwrap_or(200).min(500) as usize;
    if session_accessible(&s, sid, uid).await?.is_none() {
        return Ok(json!({ "success": false, "message": "无权访问该会话" }));
    }
    let metas = s.list_objects(&format!("private/messages/{}/", sid)).await?;
    let mut ids: Vec<String> = metas
        .into_iter()
        .filter(|m| m.key.ends_with(".json"))
        .map(|m| {
            let prefix = format!("private/messages/{}/", sid);
            m.key[prefix.len()..m.key.len() - 5].to_string()
        })
        .collect();
    ids.sort();
    let take: Vec<String> = ids.into_iter().rev().take(limit).collect();
    let keys: Vec<String> = take.iter().map(|id| priv_msg_key(sid, id)).collect();
    let mut msgs = fetch_json_all(&s, &keys).await;
    sort_desc_by_created(&mut msgs);
    Ok(Value::Array(msgs))
}

pub async fn s3rpc_send_private_message(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let sid = params["p_session_id"].as_str().unwrap_or("");
    let sender_uid = params["p_sender_uid"].as_u64().unwrap_or(0);
    let content = params["p_content"].as_str().unwrap_or("");
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, sender_uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    // 细分限制：禁止发送私聊消息
    if !check_restriction(&s, sender_uid, "private_msg").await? {
        return Ok(json!({ "success": false, "message": restriction_msg("private_msg") }));
    }
    let Some(mut sess) = session_accessible(&s, sid, sender_uid).await? else {
        return Ok(json!({ "success": false, "message": "会话不存在或无权访问" }));
    };
    let user = get_user(&s, sender_uid).await?.unwrap_or_else(|| json!({}));
    let sender_name = user["username"].as_str().unwrap_or("");
    let msg = json!({
        "id": new_id(),
        "session_id": sid,
        "sender": sender_name,
        "sender_uid": sender_uid,
        "content": content,
        "sender_deleted": false,
        "created_at": now_iso()
    });
    json_put(&s, &priv_msg_key(sid, msg["id"].as_str().unwrap()), &msg).await?;
    sess["updated_at"] = json!(now_iso());
    sess["last_message"] = json!(content.chars().take(60).collect::<String>());
    json_put(&s, &priv_sess_key(sid), &sess).await?;
    Ok(json!({ "success": true, "message": msg }))
}

pub async fn s3rpc_mark_private_messages_read(_params: Value) -> Result<Value, String> {
    // 实时已读回执已随 Realtime 移除；保留命令避免前端报错
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_delete_private_session(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let sid = params["p_session_id"].as_str().unwrap_or("");
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let Some(mut sess) = json_get(&s, &priv_sess_key(sid)).await? else {
        return Ok(json!({ "success": true }));
    };
    let u1 = sess["user1_uid"].as_u64().unwrap_or(0);
    let u2 = sess["user2_uid"].as_u64().unwrap_or(0);
    if u1 == uid {
        sess["deleted_by_user1"] = json!(true);
    } else if u2 == uid {
        sess["deleted_by_user2"] = json!(true);
    }
    json_put(&s, &priv_sess_key(sid), &sess).await?;
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_delete_private_message(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let sid = params["p_session_id"].as_str().unwrap_or("");
    let msg_id = params["p_msg_id"].as_str().unwrap_or("");
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let key = priv_msg_key(sid, msg_id);
    if let Some(msg) = json_get(&s, &key).await? {
        let owner = msg["sender_uid"].as_u64().unwrap_or(0);
        if owner != 0 && owner != uid {
            return Ok(json!({ "success": false, "message": "只能删除自己的消息" }));
        }
    }
    s.delete_object(&key).await?;
    Ok(json!({ "success": true }))
}

// ==================== 用户资料 ====================

pub async fn s3rpc_get_user_profile(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let username = params["p_username"].as_str().unwrap_or("");
    if uid == 0 && username.is_empty() {
        return Ok(json!({ "success": false, "message": "缺少用户标识" }));
    }
    let user = if uid != 0 {
        get_user(&s, uid).await?
    } else {
        get_user_by_name(&s, username).await?
    };
    match user {
        Some(v) => Ok(user_public_fields(&v)),
        None => Ok(json!({ "success": false, "message": "用户不存在" })),
    }
}

pub async fn s3rpc_update_avatar(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let avatar_url = params["p_avatar_url"].as_str().unwrap_or("");
    // 细分限制：禁止修改头像与背景
    if uid != 0 && !check_restriction(&s, uid, "profile_edit").await? {
        return Ok(json!({ "success": false, "message": restriction_msg("profile_edit") }));
    }
    if let Some(mut user) = get_user(&s, uid).await? {
        user["avatar_url"] = json!(avatar_url);
        save_user(&s, uid, &user).await?;
    }
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_upsert_user_profile(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let Some(mut user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    // 细分限制：禁止修改头像与背景（含主页资料）
    if uid != 0 && !check_restriction(&s, uid, "profile_edit").await? {
        return Ok(json!({ "success": false, "message": restriction_msg("profile_edit") }));
    }
    for (field, key) in [
        ("p_email", "email"),
        ("p_birthday", "birthday"),
        ("p_bio", "bio"),
        ("p_bg_url", "bg_url"),
    ] {
        if let Some(v) = params[field].as_str() {
            user[key] = json!(v);
        }
    }
    if let Some(tags) = params["p_tags"].as_array() {
        user["tags"] = Value::Array(tags.clone());
    }
    save_user(&s, uid, &user).await?;
    Ok(json!({ "success": true }))
}

/// 昵称（用户名）每日可修改次数上限
const MAX_USERNAME_RENAMES_PER_DAY: u64 = 5;

/// 修改昵称（用户名）——用户文件 renames 字段记录 {date, count} 实现每日限次；
/// 主键为 users/<uid>.json，私聊会话 id 基于 uid，改名只需重建统一用户索引。
pub async fn s3rpc_update_username(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let new_name = params["p_new_username"].as_str().unwrap_or("").trim().to_string();
    if uid == 0 {
        return err("缺少用户标识");
    }
    if new_name.is_empty() || !valid_username(&new_name) {
        return Ok(json!({ "success": false, "message": "昵称不合法（2-15 个字符，不含特殊字符）" }));
    }
    let Some(mut user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    let old_name = user["username"].as_str().unwrap_or("").to_string();
    if old_name == new_name {
        return Ok(json!({ "success": false, "message": "昵称未变化" }));
    }
    // 新昵称不得被其他用户占用
    if let Some(owner) = uid_by_name(&s, &new_name).await? {
        if owner != uid {
            return Ok(json!({ "success": false, "message": "该昵称已被使用" }));
        }
    }
    // 每日修改次数限制
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let mut rename_count: u64 = 0;
    if let Some(r) = user["renames"].as_object() {
        if r.get("date").and_then(|v| v.as_str()) == Some(today.as_str()) {
            rename_count = r.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
        }
    }
    if rename_count >= MAX_USERNAME_RENAMES_PER_DAY {
        return Ok(json!({ "success": false, "message": "今日昵称修改次数已达上限（每天 5 次）" }));
    }
    // 执行改名：更新用户文件 + 重建统一索引
    user["username"] = json!(new_name);
    user["renames"] = json!({ "date": today, "count": rename_count + 1 });
    save_user(&s, uid, &user).await?;
    if !old_name.is_empty() {
        let _ = user_index_remove(&s, &old_name).await;
    }
    user_index_put(&s, &new_name, uid).await?;
    Ok(json!({
        "success": true,
        "username": new_name,
        "renames_left": MAX_USERNAME_RENAMES_PER_DAY.saturating_sub(rename_count + 1)
    }))
}

/// 云端设置单条上限（客户端打包为单个加密 JSON，远小于该值）
const MAX_CLOUD_SETTINGS_BYTES: usize = 16 * 1024;

/// 读取云端用户设置（cloud_settings 字段）。
/// 内容由客户端用「密码派生密钥」AES-GCM 加密，服务端只见密文，无法解读。
/// 需验权：仅登录会话所有者可读取自己的设置。
pub async fn s3rpc_get_user_settings(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_token"].as_str().or_else(|| params["p_session_token"].as_str()).unwrap_or("");
    if uid == 0 {
        return Ok(json!({ "success": false, "message": "缺少用户标识" }));
    }
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let user = get_user(&s, uid).await?.unwrap_or_else(|| json!({}));
    let cs = user["cloud_settings"].clone();
    if cs.is_null() {
        return Ok(json!({ "success": true, "settings": Value::Null }));
    }
    Ok(json!({ "success": true, "settings": cs }))
}

/// 覆盖写入云端用户设置（cloud_settings 字段，整体替换，云端为权威）。
/// 内容为客户端加密密文，服务端仅做大小与结构校验。
pub async fn s3rpc_update_user_settings(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_token"].as_str().or_else(|| params["p_session_token"].as_str()).unwrap_or("");
    if uid == 0 {
        return Ok(json!({ "success": false, "message": "缺少用户标识" }));
    }
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let settings = &params["p_settings"];
    if !settings.is_object() {
        return Ok(json!({ "success": false, "message": "缺少设置数据" }));
    }
    let serialized = serde_json::to_string(settings).map_err(|e| format!("设置序列化失败: {}", e))?;
    if serialized.len() > MAX_CLOUD_SETTINGS_BYTES {
        return Ok(json!({ "success": false, "message": "设置数据过大" }));
    }
    let Some(mut user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    user["cloud_settings"] = settings.clone();
    save_user(&s, uid, &user).await?;
    Ok(json!({ "success": true, "updated_at": now_iso() }))
}

pub async fn s3rpc_search_users(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let query = params["p_query"].as_str().unwrap_or("").trim().to_lowercase();
    let limit = params["p_limit"].as_u64().unwrap_or(20).min(50) as usize;
    if query.is_empty() {
        return Ok(Value::Array(vec![]));
    }
    // 基于统一索引匹配用户名（免全桶扫描）：先匹配名字，再按 uid 取用户对象
    let mut matched_uids: Vec<u64> = Vec::new();
    if let Some(obj) = user_index_map(&s).await?.as_object() {
        for (name, v) in obj {
            if name.to_lowercase().contains(&query)
                || enc(name).to_lowercase().contains(&query)
                || enc(name).to_lowercase().contains(&query.replace(" ", ""))
            {
                if let Some(uid) = v.as_u64() {
                    matched_uids.push(uid);
                }
            }
        }
    }
    matched_uids.sort();
    matched_uids.truncate(limit);
    let keys: Vec<String> = matched_uids.iter().map(|uid| user_key(*uid)).collect();
    let users = fetch_json_all(&s, &keys).await;
    let mut matched: Vec<Value> = users
        .into_iter()
        .map(|v| {
            json!({
                "uid": v["uid"].as_u64().unwrap_or(0),
                "username": v["username"].as_str().unwrap_or(""),
                "avatar_url": v["avatar_url"].as_str().unwrap_or("")
            })
        })
        .collect();
    matched.sort_by(|a, b| a["username"].as_str().unwrap_or("").cmp(b["username"].as_str().unwrap_or("")));
    Ok(Value::Array(matched))
}

/// @提及候选：普通用户（非封禁）+ 智能体（启用中），供输入框 @ 快速选择。
/// 基于统一索引匹配用户名，无需登录态。
pub async fn s3rpc_mention_candidates(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let query = params["p_query"].as_str().unwrap_or("").trim().to_lowercase();
    let limit = params["p_limit"].as_u64().unwrap_or(30).min(50) as usize;
    let mut out: Vec<Value> = Vec::new();

    // 普通用户：统一索引匹配
    if let Some(obj) = user_index_map(&s).await?.as_object() {
        let mut matched: Vec<(u64, String)> = Vec::new();
        for (name, v) in obj {
            if query.is_empty()
                || name.to_lowercase().contains(&query)
                || enc(name).to_lowercase().contains(&query)
            {
                if let Some(uid) = v.as_u64() {
                    matched.push((uid, name.clone()));
                }
            }
        }
        matched.sort_by(|a, b| a.1.cmp(&b.1));
        let keys: Vec<String> = matched.iter().take(limit).map(|(uid, _)| user_key(*uid)).collect();
        let users = fetch_json_all(&s, &keys).await;
        for v in users {
            if v["banned"].as_bool().unwrap_or(false) {
                continue;
            }
            out.push(json!({
                "uid": v["uid"].as_u64().unwrap_or(0),
                "username": v["username"].as_str().unwrap_or(""),
                "role": v["role"].as_str().unwrap_or("user"),
                "avatar_url": v["avatar_url"].as_str().unwrap_or("")
            }));
        }
    }

    // 智能体：agents/<id>.json 名称匹配（归入"智能体"用户组，随用户一起展示）
    // 注意：智能体账号同时存在于统一索引（users/<uid>.json 角色为 agent），
    // 必须以 uid（及用户名兜底）去重，否则同一智能体在列表中会出现两次。
    let mut agent_entries: Vec<Value> = Vec::new();
    let mut agent_uids: Vec<u64> = Vec::new();
    let mut agent_names: Vec<String> = Vec::new();
    let metas = s.list_objects("agents/").await?;
    let keys: Vec<String> = metas
        .into_iter()
        .filter(|m| {
            m.key.starts_with("agents/") && m.key.ends_with(".json") && !m.key.starts_with("agents/by_name/")
        })
        .map(|m| m.key)
        .collect();
    let agents = fetch_json_all(&s, &keys).await;
    for a in agents {
        if a["enabled"].as_bool().unwrap_or(true) == false {
            continue;
        }
        let name = a["name"].as_str().unwrap_or("");
        if name.is_empty() {
            continue;
        }
        if !query.is_empty() && !name.to_lowercase().contains(&query) && !enc(name).to_lowercase().contains(&query)
        {
            continue;
        }
        let uid = a["uid"].as_u64().unwrap_or(0);
        agent_uids.push(uid);
        agent_names.push(name.to_string());
        agent_entries.push(json!({
            "uid": uid,
            "username": name,
            "role": "agent",
            "avatar_url": ""
        }));
    }
    // 剔除用户列表中的智能体账号（智能体由 agents/ 配置统一展示）
    out.retain(|v| {
        let uid = v["uid"].as_u64().unwrap_or(0);
        let name = v["username"].as_str().unwrap_or("");
        !agent_uids.contains(&uid) && !agent_names.iter().any(|n| n == name)
    });
    out.extend(agent_entries);
    out.sort_by(|a, b| a["username"].as_str().unwrap_or("").cmp(b["username"].as_str().unwrap_or("")));
    out.truncate(limit);
    Ok(Value::Array(out))
}

pub async fn s3rpc_toggle_block_user(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let blocker_uid = params["p_blocker_uid"].as_u64().unwrap_or(0);
    let blocked_uid = params["p_blocked_uid"].as_u64().unwrap_or(0);
    let block = params["p_block"].as_bool().unwrap_or(false);
    let Some(mut user) = get_user(&s, blocker_uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    let mut list: Vec<u64> = user["blocked"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64())
                .collect()
        })
        .unwrap_or_default();
    if block {
        if !list.contains(&blocked_uid) {
            list.push(blocked_uid);
        }
    } else {
        list.retain(|x| *x != blocked_uid);
    }
    user["blocked"] = Value::Array(list.into_iter().map(|x| json!(x)).collect());
    save_user(&s, blocker_uid, &user).await?;
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_get_blocked_users(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let user = get_user(&s, uid).await?.unwrap_or_else(|| json!({}));
    let blocked_ids: Vec<u64> = user["blocked"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
        .unwrap_or_default();
    let mut list: Vec<Value> = Vec::with_capacity(blocked_ids.len());
    for blocked_uid in blocked_ids {
        let name = get_user(&s, blocked_uid)
            .await?
            .map(|u| u["username"].as_str().unwrap_or("").to_string())
            .unwrap_or_default();
        list.push(json!({ "blocked": blocked_uid, "username": name }));
    }
    Ok(Value::Array(list))
}

pub async fn s3rpc_check_blocked(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let blocker_uid = params["p_blocker_uid"].as_u64().unwrap_or(0);
    let target_uid = params["p_target_uid"].as_u64().unwrap_or(0);
    let user = get_user(&s, blocker_uid).await?.unwrap_or_else(|| json!({}));
    let blocked = user["blocked"]
        .as_array()
        .map(|a| a.iter().any(|v| v.as_u64() == Some(target_uid)))
        .unwrap_or(false);
    Ok(json!(blocked))
}

// ==================== 媒体 ====================

/// 校验媒体 Key 合法且位于 media/ 前缀下
fn media_key_of(params: &Value) -> Result<String, String> {
    let raw = params["p_key"].as_str().unwrap_or("");
    if raw.is_empty() {
        return Err("缺少文件路径".to_string());
    }
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '%' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let key = if cleaned.starts_with("media/") {
        cleaned
    } else {
        format!("media/{}", cleaned)
    };
    if key.len() > 512 {
        return Err("文件路径过长".to_string());
    }
    Ok(key)
}

/// 媒体上传大小限制（按用途前缀，单位字节）——服务端权威校验，
/// 即使绕过前端直接调 RPC，超大文件也会在上传前被拦截，防止刷流量/占存储
fn media_upload_limit(key: &str) -> usize {
    const MB: usize = 1024 * 1024;
    // media_key_of 会补 media/ 前缀，这里去掉前缀再按用途判断
    let k = key.strip_prefix("media/").unwrap_or(key);
    if k.starts_with("avatars/") {
        5 * MB // 头像：前端裁剪压缩后通常 100-200KB
    } else if k.starts_with("background/") {
        8 * MB // 背景图
    } else if k.starts_with("chat/") {
        8 * MB // 公聊图片
    } else if k.starts_with("public/") || k.starts_with("private/") {
        32 * MB // 公/私聊文件（含语音）
    } else {
        8 * MB // 未知用途保守限制
    }
}

pub async fn s3rpc_upload_media(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let key = media_key_of(&params)?;
    // 会话校验 + 细分限制
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let k = key.strip_prefix("media/").unwrap_or(&key);
    let restr = if k.starts_with("avatars/") || k.starts_with("background/") {
        Some("profile_edit") // 头像/背景 → 修改头像与背景限制
    } else if k.starts_with("chat/") || k.starts_with("public/") {
        Some("public_media") // 公聊图片/文件/语音 → 公聊多媒体限制
    } else if k.starts_with("private/") {
        Some("private_msg") // 私聊附件/语音 → 私聊消息限制
    } else {
        None
    };
    if let Some(name) = restr {
        if !check_restriction(&s, uid, name).await? {
            return Ok(json!({ "success": false, "message": restriction_msg(name) }));
        }
    }
    let b64 = params["p_base64"].as_str().unwrap_or("");
    let content_type = params["p_content_type"].as_str().unwrap_or("application/octet-stream");
    let bytes = S3::decode_base64(b64)?;
    if bytes.is_empty() {
        return err("文件内容为空");
    }
    // 按用途前缀限制大小（服务端强制，前端校验仅作首道防线）
    let limit = media_upload_limit(&key);
    if bytes.len() > limit {
        return Err(format!("文件超过 {}MB 限制", limit / (1024 * 1024)));
    }
    // 头像/背景/聊天图片用途仅允许图片类型
    let k = key.strip_prefix("media/").unwrap_or(&key);
    if (k.starts_with("avatars/") || k.starts_with("background/") || k.starts_with("chat/"))
        && !content_type.starts_with("image/")
    {
        return err("该用途仅允许上传图片");
    }
    s.put_object(&key, bytes, content_type).await?;
    let url = s.public_url(&key);
    Ok(json!({ "success": true, "key": key, "url": url }))
}

pub async fn s3rpc_get_media_url(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let key = params["p_key"].as_str().unwrap_or("");
    if key.is_empty() {
        return err("缺少文件路径");
    }
    Ok(json!({ "success": true, "url": s.presign_get(key, 3600) }))
}

pub async fn s3rpc_list_media(params: Value) -> Result<Value, String> {
    let s = s3()?;
    // 安全加固：群文件仅允许枚举公聊上传的媒体（media/chat/ 与 media/public/）。
    // 无论客户端传入何种前缀，都不会返回 media/private/（私聊媒体）、media/avatars/（头像）、
    // media/background/（背景），更不会暴露桶内 users/、sessions/、config/ 等配置与私密对象。
    let prefix = match params["p_prefix"].as_str() {
        Some(p) if p.starts_with("media/chat/") || p.starts_with("media/public/") => p.to_string(),
        _ => "media/".to_string(),
    };
    let metas: Vec<ObjectMeta> = s
        .list_objects(&prefix)
        .await?
        .into_iter()
        .filter(|m| m.key.starts_with("media/chat/") || m.key.starts_with("media/public/"))
        .collect();
    let list: Vec<Value> = metas
        .into_iter()
        .map(|m| {
            let name = m.key.rsplit('/').next().unwrap_or("").to_string();
            let created = chrono::DateTime::parse_from_rfc3339(&m.last_modified)
                .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
                .unwrap_or_else(|_| m.last_modified.clone());
            json!({
                "key": m.key,
                "name": name,
                "size": m.size,
                "created_at": created,
                "url": s.public_url(&m.key)
            })
        })
        .collect();
    Ok(Value::Array(list))
}

// ==================== 智能体 ====================
//
// 存储结构：
//   agents/<id>.json            智能体配置（id 为十六进制毫秒时间戳+随机数）
//   agents/by_name/<name>.json  智能体名 → id 反向索引
//   每个智能体对应一个 users/<uid>.json 用户账号（role: "agent"，归入"智能体"用户组），
//   公聊消息以该账号身份发出（sender_uid = 账号 uid）。
//
// API Key 安全：前端经本机 Tauri IPC 传明文 → 后端用 AES-256-GCM 加密落盘（杜绝明文存储），
// 密钥由 S3 凭证派生（HMAC-SHA256(S3Config.secret_key, "cikachat-agent-apikey")），
// 仅调用 LLM 时在内存中解密，API Key 永不进入前端、永不出现于 S3 对象明文。

fn agent_key(id: &str) -> String {
    format!("agents/{}.json", id)
}

fn agent_name_index(name: &str) -> String {
    format!("agents/by_name/{}.json", enc(name))
}

/// 从 S3 凭证派生 AES-256 密钥（HMAC-SHA256 固定上下文，32 字节）
fn agent_aes_key(s: &Arc<S3>) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(s.cfg.secret_key.as_bytes()).expect("hmac key");
    mac.update(b"cikachat-agent-apikey");
    let out = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

/// 加密 API Key：返回 base64(nonce(12B) || AES-256-GCM 密文)
async fn encrypt_api_key(s: &Arc<S3>, plain: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(&agent_aes_key(s)).map_err(|e| format!("AES 初始化失败: {e}"))?;
    let nonce_bytes: [u8; 12] = rand::random();
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_bytes())
        .map_err(|e| format!("API Key 加密失败: {e}"))?;
    let mut out = nonce_bytes.to_vec();
    out.extend_from_slice(&ct);
    Ok(BASE64.encode(out))
}

/// 解密 API Key：输入为 encrypt_api_key 的输出
fn decrypt_api_key(s: &Arc<S3>, encoded: &str) -> Result<String, String> {
    let raw = BASE64.decode(encoded.trim()).map_err(|e| format!("密文解码失败: {e}"))?;
    if raw.len() < 13 {
        return Err("API Key 密文损坏".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(&agent_aes_key(s)).map_err(|e| format!("AES 初始化失败: {e}"))?;
    let pt = cipher
        .decrypt(Nonce::from_slice(&raw[..12]), &raw[12..])
        .map_err(|_| "API Key 解密失败".to_string())?;
    String::from_utf8(pt).map_err(|_| "API Key 解密失败".to_string())
}

/// 智能体名 → id
async fn agent_id_by_name(s3: &Arc<S3>, name: &str) -> Result<Option<String>, String> {
    match json_get(s3, &agent_name_index(name)).await? {
        Some(v) => Ok(v["agent_id"].as_str().map(|x| x.to_string())),
        None => Ok(None),
    }
}

/// 确保智能体拥有一个 role: "agent" 的用户账号（归入"智能体"用户组）。
/// 账号已存在且角色为 agent 则复用；名称被普通用户占用则返回错误。
/// 智能体账号密码为随机不可知串（无法登录，仅用于发消息）。
async fn ensure_agent_user(s3: &Arc<S3>, name: &str) -> Result<u64, String> {
    if let Some(uid) = uid_by_name(s3, name).await? {
        let user = get_user(s3, uid).await?.unwrap_or_else(|| json!({}));
        if user["role"].as_str().unwrap_or("user") == "agent" {
            return Ok(uid);
        }
        return Err("该昵称已被用户使用".to_string());
    }
    let uid = next_uid(s3).await?;
    let random_hash = format!("agent:{}:{}", uid, new_id());
    let mut user = default_user(name, &random_hash, uid);
    user["role"] = json!("agent");
    save_user(s3, uid, &user).await?;
    user_index_put(s3, name, uid).await?;
    Ok(uid)
}

pub async fn s3rpc_get_agents(_params: Value) -> Result<Value, String> {
    let s = s3()?;
    let metas = s.list_objects("agents/").await?;
    let keys: Vec<String> = metas
        .into_iter()
        .filter(|m| {
            // 只取 agents/<id>.json（排除 by_name/ 索引）
            m.key.starts_with("agents/") && m.key.ends_with(".json") && !m.key.starts_with("agents/by_name/")
        })
        .map(|m| m.key)
        .collect();
    let mut agents = fetch_json_all(&s, &keys).await;
    sort_desc_by_created(&mut agents);
    // 注意：绝不返回 api_key_enc，API Key 只以密文落盘
    let out: Vec<Value> = agents
        .into_iter()
        .map(|a| {
            json!({
                "id": a["id"].as_str().unwrap_or(""),
                "name": a["name"].as_str().unwrap_or(""),
                "provider": a["provider"].as_str().unwrap_or("custom"),
                "model": a["model"].as_str().unwrap_or(""),
                "created_by": a["created_by"].as_str().unwrap_or(""),
                "enabled": a["enabled"].as_bool().unwrap_or(true),
                "created_at": a["created_at"].as_str().unwrap_or(""),
                "updated_at": a["updated_at"].as_str().unwrap_or("")
            })
        })
        .collect();
    Ok(Value::Array(out))
}

pub async fn s3rpc_save_agent(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let name = params["p_name"].as_str().unwrap_or("").trim().to_string();
    let provider = params["p_provider"].as_str().unwrap_or("custom").trim().to_string();
    let api_key = params["p_api_key"].as_str().unwrap_or("").trim().to_string();
    let model = params["p_model"].as_str().unwrap_or("").trim().to_string();
    let creator = params["p_created_by"].as_str().unwrap_or("").trim().to_string();

    if name.is_empty() || !valid_username(&name) {
        return Ok(json!({ "success": false, "message": "智能体名称不合法（2-15 个字符）" }));
    }
    if api_key.is_empty() {
        return Ok(json!({ "success": false, "message": "请输入 API Key" }));
    }
    if model.is_empty() {
        return Ok(json!({ "success": false, "message": "请输入模型名称" }));
    }
    let Some(creator_user) = get_user_by_name(&s, &creator).await? else {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    };
    if creator_user["banned"].as_bool().unwrap_or(false) {
        return Ok(json!({ "success": false, "message": "账户已被封禁" }));
    }
    let creator_uid = creator_user["uid"].as_u64().unwrap_or(0);
    if creator_uid == 0 {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    // 写操作必须校验会话，防止伪造 p_created_by 冒名创建/修改
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, creator_uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }

    let api_key_enc = encrypt_api_key(&s, &api_key).await?;
    let now = now_iso();

    // 已存在同名智能体 → 更新配置（保留 id/uid/创建者；仅创建者本人可修改）
    if let Some(existing_id) = agent_id_by_name(&s, &name).await? {
        let key = agent_key(&existing_id);
        let Some(mut agent) = json_get(&s, &key).await? else {
            // 名称索引存在但配置对象丢失：按新智能体重建
            let uid = match ensure_agent_user(&s, &name).await {
                Ok(u) => u,
                Err(e) => return Ok(json!({ "success": false, "message": e })),
            };
            let agent = json!({
                "id": existing_id, "name": name, "provider": provider, "model": model,
                "api_key_enc": api_key_enc, "created_by": creator, "created_by_uid": creator_uid,
                "uid": uid, "enabled": true, "created_at": now, "updated_at": now
            });
            json_put(&s, &key, &agent).await?;
            return Ok(json!({ "success": true, "id": existing_id }));
        };
        if agent["created_by"].as_str().unwrap_or("") != creator {
            return Ok(json!({ "success": false, "message": "只有创建者可以修改该智能体" }));
        }
        agent["provider"] = json!(provider);
        agent["model"] = json!(model);
        agent["api_key_enc"] = json!(api_key_enc);
        agent["enabled"] = json!(true);
        agent["updated_at"] = json!(now);
        json_put(&s, &key, &agent).await?;
        return Ok(json!({ "success": true, "id": existing_id }));
    }

    // 新建：先建智能体用户账号，再写配置
    let uid = match ensure_agent_user(&s, &name).await {
        Ok(u) => u,
        Err(e) => return Ok(json!({ "success": false, "message": e })),
    };
    let id = new_id();
    let agent = json!({
        "id": id, "name": name, "provider": provider, "model": model,
        "api_key_enc": api_key_enc, "created_by": creator, "created_by_uid": creator_uid,
        "uid": uid, "enabled": true, "created_at": now, "updated_at": now
    });
    json_put(&s, &agent_key(&id), &agent).await?;
    json_put(&s, &agent_name_index(&name), &json!({ "agent_id": id })).await?;
    Ok(json!({ "success": true, "id": id }))
}

pub async fn s3rpc_delete_agent_rpc(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let agent_id = params["p_agent_id"].as_str().unwrap_or("");
    let username = params["p_username"].as_str().unwrap_or("");
    let token = params["p_session_token"].as_str().unwrap_or("");
    if agent_id.is_empty() || username.is_empty() {
        return Ok(json!({ "success": false, "message": "参数不完整" }));
    }
    // 写操作必须校验会话
    let caller_uid = match uid_by_name(&s, username).await? {
        Some(u) => u,
        None => 0,
    };
    if caller_uid == 0 || !verify_session(&s, caller_uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let key = agent_key(agent_id);
    let Some(agent) = json_get(&s, &key).await? else {
        return Ok(json!({ "success": false, "message": "智能体不存在" }));
    };
    if agent["created_by"].as_str().unwrap_or("") != username {
        return Ok(json!({ "success": false, "message": "只有创建者可以删除该智能体" }));
    }
    let name = agent["name"].as_str().unwrap_or("");
    // 删除配置与名称索引
    let _ = s.delete_object(&key).await;
    if !name.is_empty() {
        let _ = s.delete_object(&agent_name_index(name)).await;
        // 删除智能体用户账号（role=agent 且 uid 匹配，避免误删普通用户）
        if let Some(uid) = agent["uid"].as_u64() {
            if let Some(user) = get_user(&s, uid).await? {
                if user["role"].as_str().unwrap_or("user") == "agent" {
                    let _ = s.delete_object(&user_key(uid)).await;
                    let _ = user_index_remove(&s, name).await;
                }
            }
        }
    }
    Ok(json!({ "success": true, "message": "已删除" }))
}

/// 调用者鉴权：p_caller 用户名解析 uid + 会话校验
async fn verify_caller_session(s: &Arc<S3>, params: &Value) -> Result<u64, Value> {
    let caller = params["p_caller"].as_str().unwrap_or("");
    let token = params["p_session_token"].as_str().unwrap_or("");
    let caller_uid = if caller.is_empty() {
        0
    } else {
        match uid_by_name(s, caller).await {
            Ok(Some(u)) => u,
            _ => 0,
        }
    };
    if caller_uid == 0 || !verify_session(s, caller_uid, token).await.unwrap_or(false) {
        return Err(json!({ "success": false, "message": "请重新登录" }));
    }
    Ok(caller_uid)
}

pub async fn s3rpc_call_agent_llm_rate_limited(params: Value) -> Result<Value, String> {
    let s = s3()?;
    if let Err(v) = verify_caller_session(&s, &params).await {
        return Ok(v);
    }
    let agent_id = params["p_agent_id"].as_str().unwrap_or("");
    let user_message = params["p_user_message"].as_str().unwrap_or("");
    if user_message.is_empty() {
        return Ok(json!({ "success": false, "message": "消息内容为空" }));
    }
    let Some(agent) = json_get(&s, &agent_key(agent_id)).await? else {
        return Ok(json!({ "success": false, "message": "智能体不存在" }));
    };
    if !agent["enabled"].as_bool().unwrap_or(true) {
        return Ok(json!({ "success": false, "message": "智能体已停用" }));
    }
    let api_key = match agent["api_key_enc"].as_str() {
        Some(enc) => match decrypt_api_key(&s, enc) {
            Ok(k) => k,
            Err(e) => return Ok(json!({ "success": false, "message": e })),
        },
        None => return Ok(json!({ "success": false, "message": "智能体缺少 API Key 配置" })),
    };
    let provider = agent["provider"].as_str().unwrap_or("custom").to_string();
    let model = agent["model"].as_str().unwrap_or("").to_string();
    let response = call_llm(&provider, &model, &api_key, user_message).await?;
    Ok(json!({ "success": true, "response": response }))
}

pub async fn s3rpc_send_agent_message(params: Value) -> Result<Value, String> {
    let s = s3()?;
    if let Err(v) = verify_caller_session(&s, &params).await {
        return Ok(v);
    }
    let agent_name = params["p_agent_name"].as_str().unwrap_or("");
    let content = params["p_content"].as_str().unwrap_or("");
    if agent_name.is_empty() || content.is_empty() {
        return Ok(json!({ "success": false, "message": "参数不完整" }));
    }
    let Some(agent_id) = agent_id_by_name(&s, agent_name).await? else {
        return Ok(json!({ "success": false, "message": "智能体不存在" }));
    };
    let agent = json_get(&s, &agent_key(&agent_id)).await?.unwrap_or_else(|| json!({}));
    let agent_uid = agent["uid"].as_u64().unwrap_or(0);
    let msg = json!({
        "id": new_id(),
        "sender": agent_name,
        "sender_uid": agent_uid,
        "text": content,
        "image_url": "",
        "audio_url": "",
        "audio_dur": 0.0,
        "reply_to_id": params["p_reply_to_id"].as_str().unwrap_or(""),
        "reply_content": params["p_reply_content"].as_str().unwrap_or(""),
        "is_system": false,
        "sender_deleted": false,
        "created_at": now_iso()
    });
    json_put(&s, &pub_msg_key(msg["id"].as_str().unwrap()), &msg).await?;
    Ok(json!({ "success": true, "message": "ok" }))
}

/// 各服务商 OpenAI 兼容 API base URL（Google/Anthropic 使用各自原生协议）
fn provider_base_url(provider: &str) -> &'static str {
    match provider {
        "openai" => "https://api.openai.com/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        "baidu" => "https://qianfan.baidubce.com/v2",
        "ali" => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "bytedance" => "https://ark.cn-beijing.volces.com/api/v3",
        "zhipu" => "https://open.bigmodel.cn/api/paas/v4",
        "google" => "https://generativelanguage.googleapis.com/v1beta",
        "anthropic" => "https://api.anthropic.com/v1",
        _ => "https://api.openai.com/v1",
    }
}

/// 从 LLM 错误响应中提取可读信息
fn llm_error_text(body: &str, status: u16) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = v["error"]["message"].as_str() {
            return format!("HTTP {status}: {msg}");
        }
        if let Some(msg) = v["message"].as_str() {
            return format!("HTTP {status}: {msg}");
        }
    }
    let snippet: String = body.chars().take(200).collect();
    format!("HTTP {status}: {snippet}")
}

/// 调用 LLM（服务端发起，API Key 只在内存中使用）
async fn call_llm(provider: &str, model: &str, api_key: &str, user_message: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;
    let system_prompt = "你是一个聊天机器人（KnockChat 智能体）。请用简体中文简洁友好地回答用户的问题。";

    match provider {
        "google" => {
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                model
            );
            let body = json!({
                "contents": [{ "parts": [{ "text": user_message }] }],
                "systemInstruction": { "parts": [{ "text": system_prompt }] },
                "generationConfig": { "maxOutputTokens": 2048 }
            });
            let resp = client
                .post(&url)
                .query(&[("key", api_key)])
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("请求 Google 失败: {e}"))?;
            let status = resp.status().as_u16();
            let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
            if !(200..300).contains(&status) {
                return Err(llm_error_text(&text, status));
            }
            let v: Value = serde_json::from_str(&text).map_err(|_| "解析 Google 响应失败".to_string())?;
            v["candidates"][0]["content"]["parts"][0]["text"]
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Google 返回为空".to_string())
        }
        "anthropic" => {
            let url = "https://api.anthropic.com/v1/messages";
            let body = json!({
                "model": model,
                "max_tokens": 2048,
                "system": system_prompt,
                "messages": [{ "role": "user", "content": user_message }]
            });
            let resp = client
                .post(url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("请求 Anthropic 失败: {e}"))?;
            let status = resp.status().as_u16();
            let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
            if !(200..300).contains(&status) {
                return Err(llm_error_text(&text, status));
            }
            let v: Value = serde_json::from_str(&text).map_err(|_| "解析 Anthropic 响应失败".to_string())?;
            let mut out = String::new();
            if let Some(blocks) = v["content"].as_array() {
                for b in blocks {
                    if b["type"].as_str() == Some("text") {
                        if let Some(t) = b["text"].as_str() {
                            out.push_str(t);
                        }
                    }
                }
            }
            let out = out.trim().to_string();
            if out.is_empty() {
                Err("Anthropic 返回为空".to_string())
            } else {
                Ok(out)
            }
        }
        _ => {
            // OpenAI 兼容（openai/deepseek/baidu/ali/bytedance/zhipu/custom）
            let url = format!("{}/chat/completions", provider_base_url(provider).trim_end_matches('/'));
            let body = json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": user_message }
                ],
                "temperature": 0.7,
                "max_tokens": 2048
            });
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("请求 LLM 失败: {e}"))?;
            let status = resp.status().as_u16();
            let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
            if !(200..300).contains(&status) {
                return Err(llm_error_text(&text, status));
            }
            let v: Value = serde_json::from_str(&text).map_err(|_| "解析 LLM 响应失败".to_string())?;
            v["choices"][0]["message"]["content"]
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "LLM 返回为空".to_string())
        }
    }
}

// ==================== 云控（暂未迁移，返回默认配置） ====================

pub async fn s3rpc_get_cloud_control(params: Value) -> Result<Value, String> {
    let _ = params;
    Ok(json!({
        "success": true,
        "banner_enabled": false,
        "banner_title": "",
        "banner_message": "",
        "banner_show_close": true,
        "login_blocked": false,
        "force_logout_all": false,
        "force_logout_except": ""
    }))
}

/// 是否已配置 S3（供 s3_status 命令使用）
pub fn config_summary() -> Option<S3Config> {
    let lock = CFG.get_or_init(|| Mutex::new(None));
    lock.lock().ok().and_then(|g| g.as_ref().map(|s| s.cfg.clone()))
}

/// 统一 RPC 分发命令：前端 s3.js 通过 invoke('s3rpc_call', { name, params }) 调用。
/// 相比为每个 s3rpc_* 单独注册 #[tauri::command]，单个分发命令更易维护且行为一致。
#[tauri::command]
pub async fn s3rpc_call(name: String, params: Value) -> Result<Value, String> {
    match name.as_str() {
        // ==== 认证 ====
        "check_username_exists" => s3rpc_check_username_exists(params).await,
        "register_user_secure" => s3rpc_register_user_secure(params).await,
        "register_user" => s3rpc_register_user(params).await,
        "verify_login_secure_rate_limited" => s3rpc_verify_login_secure_rate_limited(params).await,
        "verify_login_secure" => s3rpc_verify_login_secure(params).await,
        "verify_login" => s3rpc_verify_login(params).await,
        "verify_session_secure" => s3rpc_verify_session_secure(params).await,
        "verify_session" => s3rpc_verify_session(params).await,
        "change_password_secure" => s3rpc_change_password_secure(params).await,
        "change_password" => s3rpc_change_password(params).await,
        "delete_my_account" => s3rpc_delete_my_account(params).await,
        "record_login" => s3rpc_record_login(params).await,
        // ==== 公聊 ====
        "get_public_messages" => s3rpc_get_public_messages(params).await,
        "send_public_message_secure" => s3rpc_send_public_message_secure(params).await,
        "delete_public_message" => s3rpc_delete_public_message(params).await,
        // ==== 私聊 ====
        "get_private_sessions" => s3rpc_get_private_sessions(params).await,
        "create_private_session" => s3rpc_create_private_session(params).await,
        "get_private_messages" => s3rpc_get_private_messages(params).await,
        "send_private_message" => s3rpc_send_private_message(params).await,
        "mark_private_messages_read" => s3rpc_mark_private_messages_read(params).await,
        "delete_private_session" => s3rpc_delete_private_session(params).await,
        "delete_private_message" => s3rpc_delete_private_message(params).await,
        // ==== 用户资料 ====
        "get_user_profile" => s3rpc_get_user_profile(params).await,
        "update_avatar" => s3rpc_update_avatar(params).await,
        "update_username" => s3rpc_update_username(params).await,
        "upsert_user_profile" => s3rpc_upsert_user_profile(params).await,
        // ==== 云设置同步 ====
        "get_user_settings" => s3rpc_get_user_settings(params).await,
        "update_user_settings" => s3rpc_update_user_settings(params).await,
        "search_users" => s3rpc_search_users(params).await,
        "mention_candidates" => s3rpc_mention_candidates(params).await,
        "toggle_block_user" => s3rpc_toggle_block_user(params).await,
        "get_blocked_users" => s3rpc_get_blocked_users(params).await,
        "check_blocked" => s3rpc_check_blocked(params).await,
        // ==== 媒体 ====
        "upload_media" => s3rpc_upload_media(params).await,
        "get_media_url" => s3rpc_get_media_url(params).await,
        "list_media" => s3rpc_list_media(params).await,
        // ==== 智能体（预留） ====
        "get_agents" => s3rpc_get_agents(params).await,
        "save_agent" => s3rpc_save_agent(params).await,
        "delete_agent_rpc" => s3rpc_delete_agent_rpc(params).await,
        "call_agent_llm_rate_limited" => s3rpc_call_agent_llm_rate_limited(params).await,
        "send_agent_message" => s3rpc_send_agent_message(params).await,
        // ==== 云控（预留） ====
        "get_cloud_control" => s3rpc_get_cloud_control(params).await,
        other => Err(format!("未知 RPC: {}", other)),
    }
}

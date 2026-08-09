// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod s3;
mod s3rpc;

use s3::S3;
use serde_json::json;
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 从 s3-config.json 的 JSON 文本解析出 S3Config；关键字段缺失视为无效，返回 None
fn s3_config_from_json(text: &str) -> Option<s3::S3Config> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let cfg = s3::S3Config {
        endpoint: get("endpoint"),
        region: if get("region").is_empty() { "us-east-1".to_string() } else { get("region") },
        bucket: get("bucket"),
        access_key: get("access_key"),
        secret_key: get("secret_key"),
        path_style: v.get("path_style").and_then(|x| x.as_bool()).unwrap_or(true),
        public_base: get("public_base"),
    };
    if cfg.endpoint.is_empty() || cfg.bucket.is_empty() || cfg.access_key.is_empty() || cfg.secret_key.is_empty() {
        return None;
    }
    Some(cfg)
}

/// 读取 S3 配置，优先级从高到低：
/// 1. 环境变量（CIKACHAT_S3_*，部署/测试覆盖用）
/// 2. 运行目录下的 s3-config.json（tauri dev 时即 src-tauri 目录）
/// 3. 应用配置目录下的 s3-config.json（%APPDATA%\com.cika.chatapp\，已安装应用覆盖用）
/// 4. 编译期内嵌配置（include_str! 打进 exe，打包版开箱即用）
fn load_s3_config(app: &tauri::AppHandle) -> Option<S3> {
    // 1) 环境变量
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    let cfg = s3::S3Config {
        endpoint: env("CIKACHAT_S3_ENDPOINT").unwrap_or_default(),
        region: env("CIKACHAT_S3_REGION").unwrap_or_else(|| "us-east-1".to_string()),
        bucket: env("CIKACHAT_S3_BUCKET").unwrap_or_default(),
        access_key: env("CIKACHAT_S3_ACCESS_KEY").unwrap_or_default(),
        secret_key: env("CIKACHAT_S3_SECRET_KEY").unwrap_or_default(),
        path_style: env("CIKACHAT_S3_PATH_STYLE")
            .map(|v| v != "false" && v != "0")
            .unwrap_or(true),
        public_base: env("CIKACHAT_S3_PUBLIC_BASE").unwrap_or_default(),
    };
    if !cfg.endpoint.is_empty() && !cfg.bucket.is_empty() && !cfg.access_key.is_empty() && !cfg.secret_key.is_empty() {
        return Some(S3::new(cfg));
    }

    // 2) s3-config.json（运行目录 → 应用配置目录）
    for dir in [std::env::current_dir().ok(), app.path().app_config_dir().ok()] {
        if let Some(d) = dir {
            if let Ok(text) = std::fs::read_to_string(d.join("s3-config.json")) {
                if let Some(cfg) = s3_config_from_json(&text) {
                    return Some(S3::new(cfg));
                }
            }
        }
    }

    // 3) 编译期内嵌配置：直接打包进 exe（相对于本文件 src/ 的上一级，即 src-tauri/s3-config.json）
    if let Some(cfg) = s3_config_from_json(include_str!("../s3-config.json")) {
        return Some(S3::new(cfg));
    }

    None
}

/// 返回 S3 配置状态，供前端登录页提示是否已配置存储桶
#[tauri::command]
fn s3_status() -> serde_json::Value {
    if let Some(cfg) = s3rpc::config_summary() {
        let public = if cfg.public_base.is_empty() {
            format!("{}/{}", cfg.endpoint, cfg.bucket)
        } else {
            cfg.public_base
        };
        json!({
            "configured": true,
            "endpoint": cfg.endpoint,
            "region": cfg.region,
            "bucket": cfg.bucket,
            "path_style": cfg.path_style,
            "public_base": public,
            "message": ""
        })
    } else {
        json!({
            "configured": false,
            "message": "S3 存储桶未配置。请在 src-tauri 目录放置 s3-config.json 或设置 CIKACHAT_S3_* 环境变量（详见 docs/s3-config-guide.md）。"
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 初始化 S3 客户端
            let s3 = load_s3_config(app.handle());
            if s3.is_some() {
                s3rpc::set_s3(s3);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            s3_status,
            // 统一 RPC 分发命令：前端 s3.js 的 s3.rpc(name, params) 全部经由它转发
            s3rpc::s3rpc_call,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// KnockChat 已改为通过 Cloudflare Worker 托管 API 访问数据：
// 云存储凭证只存在于 Worker Secret 环境变量与 BELL 管理端配置，
// 客户端（含打包后的 exe）不再包含任何云存储密钥。
// 前端统一通过 src/js/s3.js 以 HTTP 调用 Worker（POST /rpc），
// 此处仅保留 Tauri 壳运行所需的最小代码。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

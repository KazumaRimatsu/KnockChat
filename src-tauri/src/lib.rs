// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// KnockChat 已改为通过 Cloudflare Worker 托管 API 访问数据：
// 云存储凭证只存在于 Worker Secret 环境变量与 BELL 管理端配置，
// 客户端（含打包后的 exe）不再包含任何云存储密钥。
// 前端统一通过 src/js/s3.js 以 HTTP 调用 Worker（POST /rpc），
// 此处仅保留 Tauri 壳运行所需的最小代码。

use tauri_plugin_dialog::DialogExt;

// 保存文件：弹出系统保存对话框并写入字节。
// 打包后的 WebView 不支持 <a download> 触发的 Blob 下载（静默失败），
// 前端保存图片/视频/主题模板/备份等统一改走此命令。
// 返回 true=已保存，false=用户取消。
#[tauri::command]
fn save_binary_file(app: tauri::AppHandle, file_name: String, data: Vec<u8>) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .blocking_save_file();
    match picked {
        Some(path) => {
            let p = path.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&p, &data).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_binary_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

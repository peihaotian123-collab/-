use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;
use url::Url;

fn resolve_server_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("server.js");
        if candidate.exists() {
            return candidate;
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root_dir = manifest_dir.parent().unwrap_or(manifest_dir.as_path());
    root_dir.join("server.js")
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle();
            let data_dir = app_handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法获取数据目录: {e}"))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("无法创建数据目录: {e}"))?;

            let server_path = resolve_server_path(&app_handle);

            Command::new("node")
                .arg(server_path)
                .env("PROMPT_DB_DIR", data_dir)
                .env("PORT", "3000")
                .env("HOST", "127.0.0.1")
                .spawn()
                .map_err(|e| format!("无法启动本地服务: {e}"))?;

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = Url::parse("http://127.0.0.1:3000") {
                    let _ = window.navigate(url);
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

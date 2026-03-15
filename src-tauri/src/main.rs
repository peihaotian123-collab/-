use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
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

fn find_node_binary() -> Option<PathBuf> {
    if let Ok(node_bin) = std::env::var("NODE_BINARY") {
        let candidate = PathBuf::from(node_bin);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let candidates = [
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
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

            let node_binary = find_node_binary();
            if let Some(node_path) = node_binary {
                match Command::new(node_path)
                    .arg(server_path)
                    .env("PROMPT_DB_DIR", data_dir)
                    .env("PORT", "3000")
                    .env("HOST", "127.0.0.1")
                    .spawn()
                {
                    Ok(_) => {
                        let app_handle = app_handle.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(300));
                            if let Some(window) = app_handle.get_webview_window("main") {
                                if let Ok(url) = Url::parse("http://127.0.0.1:3000") {
                                    let _ = window.navigate(url);
                                }
                            }
                        });
                    }
                    Err(err) => {
                        eprintln!("无法启动本地服务: {err}");
                    }
                }
            } else {
                eprintln!("未找到 Node.js，请安装 Node.js 或设置 NODE_BINARY 环境变量。");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

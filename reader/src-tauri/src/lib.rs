#[cfg(not(target_os = "android"))]
compile_error!("Pagewise supports Android only");

mod edge_tts;
mod export_file;
mod fonts;
#[cfg(target_os = "android")]
mod monitored_folder;
mod system_tts;

use std::{collections::HashSet, path::Path, sync::Mutex};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct OpenFilesData {
    pending: Vec<String>,
    allowed: HashSet<String>,
}

#[derive(Default)]
struct OpenFilesState(Mutex<OpenFilesData>);

const SUPPORTED_EXTENSIONS: &[&str] = &["epub", "mobi", "pdf", "txt", "md", "markdown"];

fn is_supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SUPPORTED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn supported_paths(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter()
        .filter(|arg| {
            let path = Path::new(arg);
            path.is_file() && is_supported_path(path)
        })
        .collect()
}

fn queue_open_files(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<OpenFilesState>();
    let mut data = state.0.lock().unwrap();
    for path in paths {
        data.allowed.insert(path.clone());
        if !data.pending.contains(&path) {
            data.pending.push(path);
        }
    }
    drop(data);
    let _ = app.emit("open-files", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn take_open_files(state: tauri::State<'_, OpenFilesState>) -> Vec<String> {
    std::mem::take(&mut state.0.lock().unwrap().pending)
}

#[tauri::command]
fn read_open_file(
    state: tauri::State<'_, OpenFilesState>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    if !state.0.lock().unwrap().allowed.contains(&path) {
        return Err("未获授权的文件".into());
    }
    let file = Path::new(&path);
    if !file.is_file() || !is_supported_path(file) {
        return Err("无效或不支持的文件".into());
    }
    std::fs::read(file)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("读取文件失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::is_supported_path;
    use std::path::Path;

    #[test]
    fn recognizes_only_retained_reader_file_extensions() {
        for name in [
            "book.epub",
            "book.mobi",
            "book.pdf",
            "book.txt",
            "book.md",
            "book.markdown",
        ] {
            assert!(is_supported_path(Path::new(name)), "{name}");
        }
        for name in [
            "book.EPUB",
            "book.MOBI",
            "book.PDF",
            "book.TXT",
            "book.MD",
            "book.MARKDOWN",
        ] {
            assert!(is_supported_path(Path::new(name)), "{name}");
        }
        for name in [
            "archive.zip",
            "book.fb2.zip",
            "book.azw",
            "book.azw3",
            "book.fb2",
            "book.fbz",
            "book.cbz",
            "book.cbr",
            "book.djvu",
            "book.djv",
            "book.html",
            "book.htm",
            "book.xhtml",
            "book",
            "book.epub.apk",
        ] {
            assert!(!is_supported_path(Path::new(name)), "{name}");
        }
    }
}

#[cfg(target_os = "android")]
#[tauri::mobile_entry_point]
pub fn run() {
    let builder = tauri::Builder::default();

    let app = builder
        .manage(OpenFilesState::default())
        .invoke_handler(tauri::generate_handler![
            take_open_files,
            read_open_file,
            monitored_folder::get_monitored_folder,
            monitored_folder::select_monitored_folder,
            monitored_folder::list_monitored_files,
            monitored_folder::read_monitored_file,
            export_file::begin_export,
            export_file::append_export,
            export_file::write_export,
            export_file::delete_export,
            export_file::begin_import_file,
            export_file::append_import_file,
            export_file::publish_import_file,
            export_file::delete_import_file,
            monitored_folder::watch_monitored_folder,
            edge_tts::edge_tts_synthesize,
            system_tts::system_tts_available,
            system_tts::system_tts_speak,
            system_tts::system_tts_stop,
            system_tts::system_tts_status,
            system_tts::system_tts_session,
            system_tts::system_tts_speak_batch,
            fonts::list_system_fonts
        ])
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(monitored_folder::init())
        .plugin(export_file::init())
        .plugin(system_tts::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Android 冷启动与运行中的关联文件均通过系统 Opened 事件进入队列。
        if let tauri::RunEvent::Opened { urls } = event {
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .map(|path| path.to_string_lossy().into_owned());
            queue_open_files(app_handle, supported_paths(paths));
        }
    });
}

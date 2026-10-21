//! Narrow app commands: Android owns the persisted SAF registry and validates membership.
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin},
    Manager,
};

struct FolderPlugin(PluginHandle<tauri::Wry>);

#[derive(Serialize)]
pub struct FolderError {
    code: String,
}

fn error(code: &str) -> FolderError {
    FolderError { code: code.into() }
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("monitored-folder")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("io.pagewise.reader", "MonitoredFolderPlugin")?;
            app.manage(FolderPlugin(handle));
            Ok(())
        })
        .build()
}

async fn call(
    app: tauri::AppHandle,
    command: &'static str,
    args: Value,
) -> Result<Value, FolderError> {
    // run_mobile_plugin blocks for its native response, including a user-driven picker.
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<FolderPlugin>()
            .0
            .run_mobile_plugin(command, args)
            .map_err(|failure| match failure {
                PluginInvokeError::InvokeRejected(response) => FolderError {
                    code: response.code.unwrap_or_else(|| "io_error".into()),
                },
                _ => error("unavailable"),
            })
    })
    .await
    .map_err(|_| error("unavailable"))?
}

fn folder_result(value: Value) -> Result<Value, FolderError> {
    let mut object = value
        .as_object()
        .filter(|object| object.len() == 1)
        .cloned()
        .ok_or_else(|| error("io_error"))?;
    match object.remove("folder") {
        Some(folder) if folder.is_null() || folder.is_object() => Ok(folder),
        _ => Err(error("io_error")),
    }
}

#[tauri::command]
pub async fn get_monitored_folder(app: tauri::AppHandle) -> Result<Value, FolderError> {
    folder_result(call(app, "get", json!({})).await?)
}

#[tauri::command]
pub async fn select_monitored_folder(app: tauri::AppHandle) -> Result<Value, FolderError> {
    folder_result(call(app, "select", json!({})).await?)
}

#[tauri::command]
pub async fn list_monitored_files(
    app: tauri::AppHandle,
    folder_id: String,
) -> Result<Value, FolderError> {
    call(app, "list", json!({ "folderId": folder_id })).await
}

#[tauri::command]
pub async fn read_monitored_file(
    app: tauri::AppHandle,
    folder_id: String,
    document_id: String,
) -> Result<Value, FolderError> {
    call(
        app,
        "read",
        json!({ "folderId": folder_id, "documentId": document_id }),
    )
    .await
}

#[tauri::command]
pub async fn monitored_file_job(
    app: tauri::AppHandle,
    action: String,
    payload: Value,
) -> Result<Value, FolderError> {
    call(app, "job", json!({ "action": action, "payload": payload })).await
}

#[tauri::command]
pub async fn watch_monitored_folder(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<Value, FolderError> {
    call(app, "watch", json!({ "enabled": enabled })).await
}

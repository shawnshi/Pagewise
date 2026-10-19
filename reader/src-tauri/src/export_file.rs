//! App-owned archive export sink. The Android plugin only writes app-generated zip temp
//! files to the content URI chosen by the system save dialog.
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin},
    Manager,
};

struct ExportPluginHandle(PluginHandle<tauri::Wry>);

#[derive(Serialize)]
pub struct ExportError {
    code: String,
}

fn error(code: &str) -> ExportError {
    ExportError { code: code.into() }
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("export-file")
        .setup(|app, api| {
            let handle = api.register_android_plugin("io.pagewise.reader", "ExportPlugin")?;
            app.manage(ExportPluginHandle(handle));
            Ok(())
        })
        .build()
}

async fn call(
    app: tauri::AppHandle,
    command: &'static str,
    args: Value,
) -> Result<Value, ExportError> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<ExportPluginHandle>()
            .0
            .run_mobile_plugin(command, args)
            .map_err(|failure| match failure {
                PluginInvokeError::InvokeRejected(response) => ExportError {
                    code: response.code.unwrap_or_else(|| "io_error".into()),
                },
                _ => error("unavailable"),
            })
    })
    .await
    .map_err(|_| error("unavailable"))?
}

#[tauri::command]
pub async fn begin_export(app: tauri::AppHandle, path: String) -> Result<Value, ExportError> {
    call(app, "begin", json!({ "path": path })).await
}

#[tauri::command]
pub async fn append_export(
    app: tauri::AppHandle,
    path: String,
    data: String,
) -> Result<Value, ExportError> {
    call(app, "append", json!({ "path": path, "data": data })).await
}

#[tauri::command]
pub async fn write_export(
    app: tauri::AppHandle,
    path: String,
    uri: String,
) -> Result<Value, ExportError> {
    call(app, "write", json!({ "path": path, "uri": uri })).await
}

#[tauri::command]
pub async fn delete_export(app: tauri::AppHandle, path: String) -> Result<Value, ExportError> {
    call(app, "delete", json!({ "path": path })).await
}

#[tauri::command]
pub async fn begin_import_file(app: tauri::AppHandle, path: String) -> Result<Value, ExportError> {
    call(app, "beginImport", json!({ "path": path })).await
}

#[tauri::command]
pub async fn append_import_file(
    app: tauri::AppHandle,
    path: String,
    data: String,
) -> Result<Value, ExportError> {
    call(app, "appendImport", json!({ "path": path, "data": data })).await
}

#[tauri::command]
pub async fn publish_import_file(
    app: tauri::AppHandle,
    path: String,
    target: String,
) -> Result<Value, ExportError> {
    call(
        app,
        "publishImport",
        json!({ "path": path, "target": target }),
    )
    .await
}

#[tauri::command]
pub async fn delete_import_file(app: tauri::AppHandle, path: String) -> Result<Value, ExportError> {
    call(app, "deleteImport", json!({ "path": path })).await
}

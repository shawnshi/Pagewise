//! Native management/state IPC. WebView frame bridges expose capability numbers only.
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{
    plugin::{mobile::PluginInvokeError, Builder, PluginHandle, TauriPlugin},
    Manager,
};

struct NativeStateHandle(PluginHandle<tauri::Wry>);
struct NativePagesHandle(PluginHandle<tauri::Wry>);

#[derive(Serialize)]
pub struct NativeStateError {
    code: String,
}

fn error(code: &str) -> NativeStateError {
    NativeStateError { code: code.into() }
}

pub fn init() -> TauriPlugin<tauri::Wry> {
    Builder::new("native-state")
        .setup(|app, api| {
            let handle = api.register_android_plugin("io.pagewise.reader", "NativeStatePlugin")?;
            app.manage(NativeStateHandle(handle));
            Ok(())
        })
        .build()
}

pub fn init_pages() -> TauriPlugin<tauri::Wry> {
    Builder::new("native-pages")
        .setup(|app, api| {
            let handle = api.register_android_plugin("io.pagewise.reader", "NativePagesPlugin")?;
            app.manage(NativePagesHandle(handle));
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn native_page(
    app: tauri::AppHandle,
    action: String,
    payload: Value,
) -> Result<Value, NativeStateError> {
    if !payload.is_object()
        || !matches!(
            action.as_str(),
            "ready" | "show" | "hide" | "reply" | "visibilityTicket"
        )
    {
        return Err(error("invalid_payload"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativePagesHandle>()
            .0
            .run_mobile_plugin("page", json!({"action": action, "payload": payload}))
            .map_err(|failure| match failure {
                PluginInvokeError::InvokeRejected(response) => NativeStateError {
                    code: response.code.unwrap_or_else(|| "native_pages_error".into()),
                },
                _ => error("unavailable"),
            })
    })
    .await
    .map_err(|_| error("unavailable"))?
}

#[tauri::command]
pub async fn native_state(
    app: tauri::AppHandle,
    action: String,
    payload: Value,
    library_root: Option<String>,
) -> Result<Value, NativeStateError> {
    if !payload.is_object() || action.len() > 32 {
        return Err(error("invalid_payload"));
    }
    let mut args = json!({ "action": action, "payload": payload });
    if let Some(root) = library_root {
        args["libraryRoot"] = Value::String(root);
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeStateHandle>()
            .0
            .run_mobile_plugin("state", args)
            .map_err(|failure| match failure {
                PluginInvokeError::InvokeRejected(response) => NativeStateError {
                    code: response.code.unwrap_or_else(|| "native_state_error".into()),
                },
                _ => error("unavailable"),
            })
    })
    .await
    .map_err(|_| error("unavailable"))?
}

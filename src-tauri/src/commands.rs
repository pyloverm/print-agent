use crate::config::{self, AgentConfig, PrinterConfig};
use crate::state::{AgentStatus, AppState, LogEntry};
use crate::{agent, printer};
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn get_config(state: State<AppState>) -> AgentConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_config(app: AppHandle, state: State<AppState>, config: AgentConfig) -> Result<(), String> {
    if config.server_url.trim().is_empty() || config.token.trim().is_empty() {
        return Err("O endereço do servidor e o token são obrigatórios.".into());
    }
    let has_printer = config.printers.kitchen.as_ref().is_some_and(PrinterConfig::is_configured)
        || config.printers.bar.as_ref().is_some_and(PrinterConfig::is_configured);
    if !has_printer {
        return Err("Configure pelo menos uma impressora (cozinha ou bar).".into());
    }

    config::save(&app, &config)?;
    *state.config.lock().unwrap() = config.clone();

    let mut handle_guard = state.handle.lock().unwrap();
    if handle_guard.is_some() {
        if let Some(old) = handle_guard.take() {
            old.abort();
        }
        *handle_guard = Some(agent::spawn(app, config));
    }
    Ok(())
}

#[tauri::command]
pub fn get_status(state: State<AppState>) -> AgentStatus {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_logs(state: State<AppState>) -> Vec<LogEntry> {
    state.logs.lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub fn start_agent(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let mut handle_guard = state.handle.lock().unwrap();
    if handle_guard.is_some() {
        return Ok(());
    }
    let config = state.config.lock().unwrap().clone();
    if !config.is_valid() {
        return Err("Configuração incompleta — preencha o servidor, o token e pelo menos uma impressora.".into());
    }
    *handle_guard = Some(agent::spawn(app, config));
    Ok(())
}

#[tauri::command]
pub fn stop_agent(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    if let Some(handle) = state.handle.lock().unwrap().take() {
        handle.abort();
    }
    let status = AgentStatus {
        running: false,
        ..state.status.lock().unwrap().clone()
    };
    *state.status.lock().unwrap() = status.clone();
    let _ = tauri::Emitter::emit(&app, "agent-status", status);
    Ok(())
}

#[tauri::command]
pub async fn test_printer(printer: PrinterConfig) -> Result<(), String> {
    printer::print_raw(&printer, &printer::test_ticket()).await
}

#[tauri::command]
pub fn get_printers() -> Result<Vec<String>, String> {
    printer::list_printers()
}

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

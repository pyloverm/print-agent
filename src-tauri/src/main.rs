mod commands;

use commands::AgentStateManager;
use std::sync::Arc;

fn main() {
    let state_manager = AgentStateManager::new();
    
    tauri::Builder::default()
        .manage(state_manager.state.clone())
        .manage(state_manager.stats.clone())
        .invoke_handler(tauri::generate_handler![
            commands::agent::get_agent_state,
            commands::agent::start_agent,
            commands::agent::stop_agent,
            commands::agent::restart_agent,
            commands::config::get_config,
            commands::config::save_config,
            commands::logs::get_logs,
            commands::logs::get_log_dates,
            commands::system::get_app_version,
            commands::system::close_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

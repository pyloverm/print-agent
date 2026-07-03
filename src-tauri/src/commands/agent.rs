use crate::models::{AgentState, AgentStats};
use std::sync::{Arc, Mutex};

pub struct AgentStateManager {
    pub state: Arc<Mutex<AgentState>>,
    pub stats: Arc<Mutex<AgentStats>>,
}

impl AgentStateManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(AgentState::Stopped)),
            stats: Arc::new(Mutex::new(AgentStats::new("1.0.0".to_string()))),
        }
    }
}

#[tauri::command]
pub async fn get_agent_state(state: tauri::State<'_, Arc<Mutex<AgentState>>>) -> AgentState {
    *state.lock().unwrap()
}

#[tauri::command]
pub async fn start_agent() -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
pub async fn stop_agent() -> Result<bool, String> {
    Ok(true)
}

#[tauri::command]
pub async fn restart_agent() -> Result<bool, String> {
    Ok(true)
}

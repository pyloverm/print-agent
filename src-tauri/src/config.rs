use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PrinterKind {
    #[default]
    Network,
    Usb,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrinterConfig {
    pub kind: PrinterKind,
    pub host: String,
    pub port: u16,
    pub printer_name: String,
}

impl PrinterConfig {
    pub fn is_configured(&self) -> bool {
        match self.kind {
            PrinterKind::Network => !self.host.trim().is_empty(),
            PrinterKind::Usb => !self.printer_name.trim().is_empty(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PrintersConfig {
    pub kitchen: Option<PrinterConfig>,
    pub bar: Option<PrinterConfig>,
    pub payment: Option<PrinterConfig>,
}

/// Rede de segurança, só usada quando o WebSocket está em baixo.
pub const DEFAULT_FALLBACK_POLL_MS: u64 = 60_000;
const MIN_FALLBACK_POLL_MS: u64 = 15_000;

// `serde(default)` ao nível da struct: um config.json gravado por uma versão
// anterior não tem `realtimeUrl`/`realtimeKey`/`fallbackPollMs`. Sem isto a
// desserialização falhava e o `unwrap_or_default()` do `load()` apagava toda a
// configuração do restaurante na primeira atualização.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    pub server_url: String,
    pub token: String,
    /// Servidor de tempo real (Soketi) e a sua chave pública. Vazios = o agente
    /// arranca à mesma, mas fica preso ao poll de segurança.
    pub realtime_url: String,
    pub realtime_key: String,
    pub fallback_poll_ms: u64,
    pub printers: PrintersConfig,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            token: String::new(),
            realtime_url: String::new(),
            realtime_key: String::new(),
            fallback_poll_ms: DEFAULT_FALLBACK_POLL_MS,
            printers: PrintersConfig::default(),
        }
    }
}

impl AgentConfig {
    pub fn is_valid(&self) -> bool {
        let has_printer = self.printers.kitchen.as_ref().is_some_and(PrinterConfig::is_configured)
            || self.printers.bar.as_ref().is_some_and(PrinterConfig::is_configured);
        !self.server_url.trim().is_empty() && !self.token.trim().is_empty() && has_printer
    }

    pub fn realtime_enabled(&self) -> bool {
        !self.realtime_url.trim().is_empty() && !self.realtime_key.trim().is_empty()
    }

    pub fn fallback_poll_interval(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.fallback_poll_ms.max(MIN_FALLBACK_POLL_MS))
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Não foi possível localizar a pasta de configuração: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Não foi possível criar a pasta de configuração: {e}"))?;
    Ok(dir.join("config.json"))
}

pub fn load(app: &AppHandle) -> AgentConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return AgentConfig::default(),
    };
    match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => AgentConfig::default(),
    }
}

pub fn save(app: &AppHandle, config: &AgentConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let contents = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Falha ao serializar a configuração: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Falha ao gravar a configuração: {e}"))
}

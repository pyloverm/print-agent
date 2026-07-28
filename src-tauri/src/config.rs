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

pub const DEFAULT_SERVER_URL: &str = "https://new.qomanda.eu";
pub const DEFAULT_REALTIME_URL: &str = "https://realtime.qomanda.eu";
pub const DEFAULT_REALTIME_KEY: &str = "a0g4w5Gk3ujFL9wurqHyCdEOmf5fQdLsFLHtHw139pBmZFojPrXQSIWx9Zd6BtxAl2fywhXq379ZG0hSF7jw";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentConfig {
    pub server_url: String,
    pub token: String,
    pub realtime_url: String,
    pub realtime_key: String,
    pub printers: PrintersConfig,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            server_url: DEFAULT_SERVER_URL.to_string(),
            token: String::new(),
            realtime_url: DEFAULT_REALTIME_URL.to_string(),
            realtime_key: DEFAULT_REALTIME_KEY.to_string(),
            printers: PrintersConfig::default(),
        }
    }
}

impl AgentConfig {
    pub fn is_valid(&self) -> bool {
        let has_printer = self.printers.kitchen.as_ref().is_some_and(PrinterConfig::is_configured)
            || self.printers.bar.as_ref().is_some_and(PrinterConfig::is_configured)
            || self.printers.payment.as_ref().is_some_and(PrinterConfig::is_configured);
        let server = if self.server_url.trim().is_empty() { DEFAULT_SERVER_URL } else { self.server_url.trim() };
        !server.is_empty() && !self.token.trim().is_empty() && has_printer
    }

    pub fn realtime_enabled(&self) -> bool {
        let r_url = if self.realtime_url.trim().is_empty() { DEFAULT_REALTIME_URL } else { self.realtime_url.trim() };
        let r_key = if self.realtime_key.trim().is_empty() { DEFAULT_REALTIME_KEY } else { self.realtime_key.trim() };
        !r_url.is_empty() && !r_key.is_empty()
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
    let mut config: AgentConfig = match fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => AgentConfig::default(),
    };
    if config.server_url.trim().is_empty() {
        config.server_url = DEFAULT_SERVER_URL.to_string();
    }
    if config.realtime_url.trim().is_empty() {
        config.realtime_url = DEFAULT_REALTIME_URL.to_string();
    }
    if config.realtime_key.trim().is_empty() {
        config.realtime_key = DEFAULT_REALTIME_KEY.to_string();
    }
    config
}

pub fn save(app: &AppHandle, config: &AgentConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let contents = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Falha ao serializar a configuração: {e}"))?;
    fs::write(&path, contents).map_err(|e| format!("Falha ao gravar a configuração: {e}"))
}

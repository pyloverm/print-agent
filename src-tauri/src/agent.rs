//! Ligação ao servidor Qomanda.
//!
//! MODELO DE FUNCIONAMENTO — porquê WebSocket e não polling:
//!
//! O PC do restaurante está atrás de um NAT (muitas vezes CGNAT): o servidor
//! NÃO o consegue contactar de fora. A solução é o agente abrir UMA ligação de
//! SAÍDA e mantê-la aberta — o NAT deixa sempre sair. O servidor empurra
//! "há trabalho" por esse túnel. Funcionalmente é "o servidor liga ao PC", sem
//! tocar no router do cliente.
//!
//! Porque isto importa (custo): a base de dados Neon suspende-se ao fim de
//! 5 minutos sem consultas, e é o TEMPO ACORDADO que é faturado, não o número
//! de consultas. O agente antigo consultava de 3 em 3 segundos e mantinha a
//! base acordada 24/7. Passar para 60 s NÃO resolveria nada — 60 s < 5 min.
//! Por isso: enquanto o WebSocket está ligado, ZERO consultas. O poll de
//! segurança só corre quando o WebSocket caiu — ou seja, quando já há avaria.

use crate::config::{AgentConfig, PrinterConfig};
use crate::printer::print_raw;
use crate::state::{AgentStatus, AppState};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const CLIENT_NAME: &str = "qomanda-agent";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// O evento que o servidor publica no canal de despertar. Não traz dados: é só
/// "há trabalho" — o talão vem depois pela API autenticada.
const WAKE_EVENT: &str = "job-queued";
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);
/// `activity_timeout` por omissão do protocolo Pusher, usado até o servidor
/// anunciar o seu no `connection_established`.
const DEFAULT_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(120);
/// Pingamos a 75% da janela anunciada: uma fração em vez de uma margem fixa,
/// para funcionar tanto com os 120 s do Soketi (ping a 90 s) como com um valor
/// curto — uma margem fixa de 10 s daria um período negativo se o servidor
/// anunciasse menos do que isso.
const KEEPALIVE_FRACTION: f32 = 0.75;
const MIN_KEEPALIVE: Duration = Duration::from_secs(1);

fn keepalive_period(activity_timeout: Duration) -> Duration {
    activity_timeout.mul_f32(KEEPALIVE_FRACTION).max(MIN_KEEPALIVE)
}
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    station: String,
    data_base64: String,
}

#[derive(Deserialize)]
struct JobsResponse {
    #[serde(default)]
    jobs: Vec<Job>,
}

#[derive(Deserialize)]
struct PusherEnvelope {
    event: String,
    #[serde(default)]
    data: serde_json::Value,
}

fn log(app: &AppHandle, level: &str, message: String) {
    let state = app.state::<AppState>();
    let entry = state.push_log(level, message);
    let _ = app.emit("agent-log", entry);
}

/// Muta o estado no sítio em vez de o substituir: os campos são agora vários e
/// escritos por caminhos diferentes (sessão de tempo real, recolha de jobs), e
/// substituir a struct inteira apagava o que o outro caminho acabara de gravar.
fn update_status(app: &AppHandle, mutate: impl FnOnce(&mut AgentStatus)) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut status = state.status.lock().unwrap();
        mutate(&mut status);
        status.clone()
    };
    let _ = app.emit("agent-status", snapshot);
}

fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

/// Canal de despertar. DEVE ser idêntico ao cálculo de
/// `src/lib/print-agent-channel.ts` no servidor — se divergir, o agente
/// subscreve um canal onde ninguém publica e cai silenciosamente no poll de
/// segurança: imprime na mesma, mas mantém a base de dados acordada, que é
/// exatamente o problema que o tempo real veio resolver.
fn wake_channel(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    format!("print-agent-{}", &hex::encode(digest)[..32])
}

/// O campo "Tempo real" é preenchido à mão e recebe quase sempre um endereço
/// colado do browser (`https://...`). O tungstenite só aceita `ws`/`wss` e
/// rejeita o resto com "URL scheme not supported" — uma mensagem que não diz ao
/// restaurante o que corrigir. Traduzimos aqui, como o `agent.cjs` já fazia:
/// os dois agentes partilham o mesmo config.json e têm de o ler da mesma forma.
fn websocket_base(realtime_url: &str) -> String {
    let trimmed = realtime_url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if trimmed.starts_with("wss://") || trimmed.starts_with("ws://") {
        trimmed.to_string()
    } else {
        // Sem esquema nenhum: assumir TLS, que é o caso em produção.
        format!("wss://{trimmed}")
    }
}

/// Simétrico do `websocket_base`: os dois campos são vizinhos no formulário e
/// trocam-se com facilidade. Um `wss://` no endereço do servidor fazia o
/// reqwest recusar o pedido com "builder error for url" — uma mensagem que não
/// diz ao restaurante qual dos campos está errado.
fn http_base(server_url: &str) -> String {
    let trimmed = server_url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        format!("http://{rest}")
    } else if trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

/// O `data` do `connection_established` vem, no protocolo Pusher, como uma
/// STRING que contém JSON — mas alguns servidores mandam o objeto diretamente.
/// Aceitamos as duas formas; se nenhuma servir, fica o valor por omissão.
fn activity_timeout(data: &serde_json::Value) -> Option<Duration> {
    let seconds = match data {
        serde_json::Value::String(raw) => serde_json::from_str::<serde_json::Value>(raw)
            .ok()?
            .get("activity_timeout")?
            .as_u64()?,
        other => other.get("activity_timeout")?.as_u64()?,
    };
    Some(Duration::from_secs(seconds))
}

fn printer_label(printer: &PrinterConfig) -> String {
    match printer.kind {
        crate::config::PrinterKind::Usb => format!("{} (USB)", printer.printer_name),
        crate::config::PrinterKind::Network => format!("{}:{}", printer.host, printer.port),
    }
}

/// Pede uma recolha. Capacidade 1: se já há uma em fila, este evento não
/// acrescenta nada — a recolha que vai correr já leva tudo o que estiver na
/// fila do servidor. É o que impede 3 tickets do mesmo pedido de lançarem
/// 3 recolhas concorrentes.
fn trigger(tx: &mpsc::Sender<String>, reason: &str) {
    let _ = tx.try_send(reason.to_string());
}

// ── Recolha e impressão ─────────────────────────────────────────────────────

struct Runner {
    app: AppHandle,
    client: reqwest::Client,
    config: AgentConfig,
    server_url: String,
    warned_payment_fallback: bool,
}

impl Runner {
    async fn fetch_jobs(&self) -> Result<Vec<Job>, String> {
        let res = self
            .client
            .get(format!("{}/api/print-agent/jobs", self.server_url))
            .bearer_auth(&self.config.token)
            .send()
            .await
            .map_err(|e| format!("Erro de ligação ao servidor: {e}"))?;

        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(
                "Token inválido — verifique a configuração (Dashboard > Equipa > Impressão).".into(),
            );
        }
        if !res.status().is_success() {
            return Err(format!("Servidor respondeu {}", res.status()));
        }

        let body: JobsResponse = res
            .json()
            .await
            .map_err(|e| format!("Resposta inválida do servidor: {e}"))?;
        Ok(body.jobs)
    }

    async fn report_job(&self, job_id: &str, ok: bool, error: Option<&str>) {
        let _ = self
            .client
            .post(format!("{}/api/print-agent/jobs/{job_id}", self.server_url))
            .bearer_auth(&self.config.token)
            .json(&serde_json::json!({ "ok": ok, "error": error }))
            .send()
            .await;
    }

    /// Os postos do servidor são "kitchen", "bar" e "payment" (o recibo do
    /// cliente / documento fiscal).
    ///
    /// O recibo sai quase sempre no balcão, e muitas casas só têm uma térmica
    /// aí. Por isso, se "payment" não estiver configurado, usamos a do bar e,
    /// em último caso, a da cozinha — com um aviso, porque um recibo de cliente
    /// a sair na cozinha é uma configuração a corrigir, não um funcionamento
    /// normal. Falhar era a alternativa, mas deixaria o cliente à espera de um
    /// talão que nunca sai.
    fn resolve_printer(&mut self, station: &str) -> Option<PrinterConfig> {
        let printers = &self.config.printers;
        let configured = |p: &Option<PrinterConfig>| p.clone().filter(PrinterConfig::is_configured);

        let direct = match station {
            "kitchen" => configured(&printers.kitchen),
            "bar" => configured(&printers.bar),
            "payment" => configured(&printers.payment),
            _ => None,
        };
        if direct.is_some() {
            return direct;
        }

        if station == "payment" {
            let fallback = configured(&printers.bar).or_else(|| configured(&printers.kitchen));
            if let Some(printer) = fallback {
                if !self.warned_payment_fallback {
                    self.warned_payment_fallback = true;
                    log(
                        &self.app,
                        "warn",
                        format!(
                            "Sem impressora \"Pagamento\" configurada — os recibos vão sair em {}.",
                            printer_label(&printer)
                        ),
                    );
                    log(
                        &self.app,
                        "warn",
                        "Ative o posto Pagamento na configuração para os separar.".into(),
                    );
                }
                return Some(printer);
            }
        }
        None
    }

    async fn drain(&mut self, reason: &str) {
        let jobs = match self.fetch_jobs().await {
            Ok(jobs) => jobs,
            Err(err) => {
                log(&self.app, "error", format!("Erro ao recolher jobs: {err}"));
                update_status(&self.app, |s| s.last_error = Some(err));
                return;
            }
        };

        update_status(&self.app, |s| {
            s.last_error = None;
            s.last_activity_at = Some(now());
        });

        if !jobs.is_empty() {
            log(
                &self.app,
                "info",
                format!("{} job(s) recebido(s) ({reason}).", jobs.len()),
            );
        }

        for job in jobs {
            let Some(printer) = self.resolve_printer(&job.station) else {
                let msg = format!(
                    "Sem impressora configurada para o posto \"{}\" no agente.",
                    job.station
                );
                log(
                    &self.app,
                    "warn",
                    format!("{msg} — job {} falhado.", job.id),
                );
                self.report_job(&job.id, false, Some(&msg)).await;
                continue;
            };

            let data = match base64::engine::general_purpose::STANDARD.decode(&job.data_base64) {
                Ok(data) => data,
                Err(e) => {
                    log(
                        &self.app,
                        "error",
                        format!("Job {} com dados inválidos: {e}", job.id),
                    );
                    self.report_job(&job.id, false, Some("Dados do ticket inválidos"))
                        .await;
                    continue;
                }
            };

            match print_raw(&printer, &data).await {
                Ok(()) => {
                    log(
                        &self.app,
                        "success",
                        format!(
                            "Impresso job {} ({}) em {}",
                            job.id,
                            job.station,
                            printer_label(&printer)
                        ),
                    );
                    self.report_job(&job.id, true, None).await;
                }
                Err(err) => {
                    log(
                        &self.app,
                        "error",
                        format!("Falha no job {} ({}): {err}", job.id, job.station),
                    );
                    self.report_job(&job.id, false, Some(&err)).await;
                }
            }
        }
    }
}

// ── WebSocket (protocolo Pusher, servido pelo Soketi) ───────────────────────

/// Corre uma sessão até a ligação cair. Devolve `true` se a subscrição chegou a
/// ser confirmada — é isso que distingue "caiu depois de estar a funcionar"
/// (recomeçar o backoff do início) de "nunca chegou a ligar" (continuar a
/// afastar as tentativas).
async fn realtime_session(
    app: &AppHandle,
    config: &AgentConfig,
    channel: &str,
    tx: &mpsc::Sender<String>,
) -> Result<bool, String> {
    let r_url = if config.realtime_url.trim().is_empty() {
        crate::config::DEFAULT_REALTIME_URL
    } else {
        &config.realtime_url
    };
    let r_key = if config.realtime_key.trim().is_empty() {
        crate::config::DEFAULT_REALTIME_KEY
    } else {
        &config.realtime_key
    };
    let url = format!(
        "{}/app/{}?protocol=7&client={CLIENT_NAME}&version={CLIENT_VERSION}",
        websocket_base(r_url),
        r_key
    );

    let (mut ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("falha ao ligar ao servidor de tempo real: {e}"))?;

    let mut established = false;
    // Keepalive. No protocolo Pusher é o CLIENTE que tem de dar sinal de vida:
    // o servidor fecha a ligação de um cliente calado há mais de
    // `activity_timeout` segundos (120 por omissão). Sem isto a ligação caía de
    // 2 em 2 minutos e cada reconexão fazia uma recolha — ou seja, uma consulta
    // à base de dados a cada 2 minutos, que é precisamente o que o tempo real
    // veio evitar. O valor real vem no `connection_established`.
    let initial = keepalive_period(DEFAULT_ACTIVITY_TIMEOUT);
    let mut keepalive =
        tokio::time::interval_at(tokio::time::Instant::now() + initial, initial);

    loop {
        let message = tokio::select! {
            frame = ws.next() => match frame {
                Some(frame) => frame
                    .map_err(|e| format!("ligação de tempo real interrompida: {e}"))?,
                None => break,
            },
            _ = keepalive.tick() => {
                let ping = serde_json::json!({ "event": "pusher:ping", "data": {} });
                ws.send(Message::Text(ping.to_string()))
                    .await
                    .map_err(|e| format!("falha a enviar o keepalive: {e}"))?;
                continue;
            }
        };

        let text = match message {
            Message::Text(text) => text,
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Message::Close(_) => break,
            // Ping/Pong do próprio protocolo WebSocket: o tungstenite responde
            // sozinho. O ping da Pusher é uma mensagem JSON, tratada abaixo.
            _ => continue,
        };

        let Ok(envelope) = serde_json::from_str::<PusherEnvelope>(&text) else {
            continue;
        };

        match envelope.event.as_str() {
            "pusher:connection_established" => {
                // O servidor anuncia aqui de quanto em quanto tempo espera ver
                // sinal de vida. Pingamos com uma margem antes disso.
                if let Some(timeout) = activity_timeout(&envelope.data) {
                    let period = keepalive_period(timeout);
                    keepalive =
                        tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                }
                // Canal público: nenhuma autorização necessária — o segredo é o
                // próprio nome do canal, derivado do token.
                let subscribe = serde_json::json!({
                    "event": "pusher:subscribe",
                    "data": { "channel": channel },
                });
                ws.send(Message::Text(subscribe.to_string()))
                    .await
                    .map_err(|e| format!("falha ao subscrever o canal: {e}"))?;
            }
            "pusher_internal:subscription_succeeded" => {
                established = true;
                log(
                    app,
                    "success",
                    "Tempo real ligado — à espera de trabalhos.".into(),
                );
                update_status(app, |s| {
                    s.realtime_connected = true;
                    s.last_error = None;
                });
                // Apanhar o que possa ter sido enfileirado enquanto estávamos
                // offline.
                trigger(tx, "ligação estabelecida");
            }
            "pusher:ping" => {
                let pong = serde_json::json!({ "event": "pusher:pong", "data": {} });
                ws.send(Message::Text(pong.to_string()))
                    .await
                    .map_err(|e| format!("falha a responder ao ping: {e}"))?;
            }
            // Resposta ao nosso keepalive: nada a fazer, mas não é lixo.
            "pusher:pong" => {}
            "pusher:error" => {
                log(
                    app,
                    "error",
                    format!("Erro do servidor de tempo real: {}", envelope.data),
                );
            }
            WAKE_EVENT => trigger(tx, "aviso do servidor"),
            _ => {}
        }
    }

    Ok(established)
}

// ── Arranque ────────────────────────────────────────────────────────────────

pub fn spawn(app: AppHandle, config: AgentConfig) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let s_url = if config.server_url.trim().is_empty() {
            crate::config::DEFAULT_SERVER_URL
        } else {
            &config.server_url
        };
        let server_url = http_base(s_url);
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let (tx, mut rx) = mpsc::channel::<String>(1);

        // Worker de recolha, à parte: uma impressão de cada vez, e nunca no
        // caminho das mensagens do WebSocket — uma impressora lenta (10 s de
        // timeout) não pode impedir o agente de responder aos pings e fazer-nos
        // cair a ligação. Termina sozinho quando o `tx` morre com esta tarefa.
        let mut runner = Runner {
            app: app.clone(),
            client,
            config: config.clone(),
            server_url,
            warned_payment_fallback: false,
        };
        tauri::async_runtime::spawn(async move {
            while let Some(reason) = rx.recv().await {
                runner.drain(&reason).await;
            }
        });

        let realtime = config.realtime_enabled();

        update_status(&app, |s| {
            s.running = true;
            s.realtime_configured = realtime;
            s.realtime_connected = false;
            s.last_error = None;
        });
        log(&app, "info", "Qomanda Print Agent iniciado.".into());

        // Recolha inicial: pode haver trabalho em fila desde a última paragem.
        trigger(&tx, "arranque");

        // Sem poll de segurança, o tempo real é o ÚNICO caminho até à fila. Um
        // agente sem servidor de tempo real não imprimiria nada — mais vale
        // dizê-lo e parar do que ficar com um estado "a correr" que engana.
        if !realtime {
            let msg = "Servidor de tempo real não configurado — sem ele o agente não recebe \
                       nenhum talão. Preencha-o na configuração."
                .to_string();
            log(&app, "error", msg.clone());
            update_status(&app, |s| {
                s.running = false;
                s.last_error = Some(msg);
            });
            return;
        }

        log(
            &app,
            "info",
            format!("Tempo real: {}", websocket_base(&config.realtime_url)),
        );

        let channel = wake_channel(&config.token);
        let mut attempts: u32 = 0;

        loop {
            let why = match realtime_session(&app, &config, &channel, &tx).await {
                Ok(true) => {
                    attempts = 0;
                    "ligação fechada".to_string()
                }
                Ok(false) => "ligação fechada antes da subscrição".to_string(),
                Err(err) => err,
            };

            update_status(&app, |s| {
                s.realtime_connected = false;
                s.last_error = Some(why.clone());
            });

            attempts = attempts.saturating_add(1);
            // Backoff exponencial travado a 60 s.
            let backoff = Duration::from_millis(2000u64 << attempts.saturating_sub(1).min(5))
                .min(MAX_RECONNECT_DELAY);
            // Enquanto isto durar não sai nenhum talão: o tempo real é o único
            // caminho até à fila. A recolha feita ao subscrever recupera tudo o
            // que se acumulou entretanto, e o servidor reentrega o que nunca foi
            // confirmado — os talões atrasam-se, não se perdem.
            log(
                &app,
                "warn",
                format!(
                    "Tempo real em baixo ({why}) — nova tentativa em {}s.",
                    backoff.as_secs()
                ),
            );
            tokio::time::sleep(backoff).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normaliza_o_esquema_do_endereco_de_tempo_real() {
        // O caso que apareceu em produção: endereço colado do browser.
        assert_eq!(websocket_base("https://realtime.qomanda.eu"), "wss://realtime.qomanda.eu");
        assert_eq!(websocket_base("http://127.0.0.1:8098"), "ws://127.0.0.1:8098");
        assert_eq!(websocket_base("wss://realtime.qomanda.eu/"), "wss://realtime.qomanda.eu");
        assert_eq!(websocket_base("ws://127.0.0.1:8098"), "ws://127.0.0.1:8098");
        assert_eq!(websocket_base("  realtime.qomanda.eu  "), "wss://realtime.qomanda.eu");
    }

    #[test]
    fn normaliza_o_esquema_do_endereco_do_servidor() {
        // O outro caso que apareceu em produção: os dois campos trocados.
        assert_eq!(http_base("wss://new.qomanda.eu"), "https://new.qomanda.eu");
        assert_eq!(http_base("ws://127.0.0.1:8099"), "http://127.0.0.1:8099");
        assert_eq!(http_base("https://new.qomanda.eu/"), "https://new.qomanda.eu");
        assert_eq!(http_base("http://127.0.0.1:8099"), "http://127.0.0.1:8099");
        assert_eq!(http_base("  new.qomanda.eu  "), "https://new.qomanda.eu");
    }

    #[test]
    fn le_o_activity_timeout_anunciado_pelo_servidor() {
        // Forma do protocolo: `data` é uma string que contém JSON.
        let como_string = serde_json::json!(
            r#"{"socket_id":"1.1","activity_timeout":120}"#
        );
        assert_eq!(activity_timeout(&como_string), Some(Duration::from_secs(120)));

        // Alguns servidores mandam o objeto diretamente.
        let como_objeto = serde_json::json!({ "socket_id": "1.1", "activity_timeout": 60 });
        assert_eq!(activity_timeout(&como_objeto), Some(Duration::from_secs(60)));

        // Sem o campo, fica o valor por omissão.
        assert_eq!(activity_timeout(&serde_json::json!({ "socket_id": "1.1" })), None);
        assert_eq!(activity_timeout(&serde_json::json!("lixo")), None);
    }

    #[test]
    fn o_keepalive_fica_dentro_da_janela_do_servidor() {
        // O caso real: Soketi com 120 s fechava-nos a cada 2 minutos.
        assert_eq!(
            keepalive_period(Duration::from_secs(120)),
            Duration::from_secs(90)
        );
        // Uma janela curta continua a dar um período utilizável — era aqui que
        // uma margem fixa de 10 s produzia um valor negativo.
        assert_eq!(keepalive_period(Duration::from_secs(4)), Duration::from_secs(3));
        assert!(keepalive_period(Duration::from_secs(0)) >= MIN_KEEPALIVE);
    }

    #[test]
    fn o_canal_e_o_sha256_do_token_truncado() {
        // Tem de bater certo com src/lib/print-agent-channel.ts no servidor.
        let channel = wake_channel("qpa_teste_1234567890");
        assert!(channel.starts_with("print-agent-"));
        assert_eq!(channel.len(), "print-agent-".len() + 32);
        assert_eq!(channel, "print-agent-1ac93d6da8c39d1679a3fd01ec618c57");
    }
}

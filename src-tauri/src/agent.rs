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
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const CLIENT_NAME: &str = "qomanda-agent";
const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
/// O evento que o servidor publica no canal de despertar. Não traz dados: é só
/// "há trabalho" — o talão vem depois pela API autenticada.
const WAKE_EVENT: &str = "job-queued";
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);
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
    let url = format!(
        "{}/app/{}?protocol=7&client={CLIENT_NAME}&version={CLIENT_VERSION}",
        config.realtime_url.trim_end_matches('/'),
        config.realtime_key
    );

    let (mut ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("falha ao ligar ao servidor de tempo real: {e}"))?;

    let mut established = false;

    while let Some(frame) = ws.next().await {
        let message = frame.map_err(|e| format!("ligação de tempo real interrompida: {e}"))?;
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
                    s.fallback_polling = false;
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

/// Espera `backoff` antes da próxima tentativa de ligação, mantendo entretanto
/// o poll de segurança na sua cadência. O relógio do poll é contínuo ao longo
/// de toda a avaria — não recomeça a cada tentativa, senão uma sequência de
/// reconexões curtas multiplicava as consultas.
async fn wait_with_fallback_poll(
    tx: &mpsc::Sender<String>,
    backoff: Duration,
    interval: Duration,
    last_poll: &mut Instant,
) {
    let deadline = Instant::now() + backoff;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        let until_poll = interval.saturating_sub(now.duration_since(*last_poll));
        tokio::time::sleep(until_poll.min(deadline - now)).await;
        if last_poll.elapsed() >= interval {
            *last_poll = Instant::now();
            trigger(tx, "poll de segurança");
        }
    }
}

// ── Arranque ────────────────────────────────────────────────────────────────

pub fn spawn(app: AppHandle, config: AgentConfig) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let server_url = config.server_url.trim_end_matches('/').to_string();
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
        let interval = config.fallback_poll_interval();

        update_status(&app, |s| {
            s.running = true;
            s.realtime_configured = realtime;
            s.realtime_connected = false;
            s.fallback_polling = !realtime;
            s.last_error = None;
        });
        log(&app, "info", "Qomanda Print Agent iniciado.".into());

        // Recolha inicial: pode haver trabalho em fila desde a última paragem.
        trigger(&tx, "arranque");

        if !realtime {
            log(
                &app,
                "warn",
                "Servidor de tempo real não configurado — o agente vai funcionar apenas por poll, \
                 o que mantém a base de dados permanentemente acordada."
                    .into(),
            );
            log(
                &app,
                "warn",
                format!(
                    "Poll de segurança ATIVO (tempo real não configurado) — a cada {}s.",
                    interval.as_secs()
                ),
            );
            loop {
                tokio::time::sleep(interval).await;
                trigger(&tx, "poll de segurança");
            }
        }

        log(
            &app,
            "info",
            format!("Tempo real: {}", config.realtime_url.trim_end_matches('/')),
        );

        let channel = wake_channel(&config.token);
        let mut attempts: u32 = 0;
        let mut last_poll = Instant::now();

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
                s.fallback_polling = true;
                s.last_error = Some(why.clone());
            });
            // Sem tempo real, a fila só é vista pelo poll: ativá-lo é o que
            // evita perder um ticket de cozinha durante a avaria.
            log(
                &app,
                "warn",
                format!(
                    "Poll de segurança ATIVO ({why}) — a cada {}s.",
                    interval.as_secs()
                ),
            );

            attempts = attempts.saturating_add(1);
            // Backoff exponencial travado a 60 s.
            let backoff = Duration::from_millis(2000u64 << attempts.saturating_sub(1).min(5))
                .min(MAX_RECONNECT_DELAY);
            wait_with_fallback_poll(&tx, backoff, interval, &mut last_poll).await;
        }
    })
}

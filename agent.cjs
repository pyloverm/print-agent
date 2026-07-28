#!/usr/bin/env node
/**
 * Qomanda Print Agent — agente de impressão self-host (build legado).
 *
 * Instala-se no PC do restaurante (o mesmo que está na rede das impressoras).
 * Imprime os tickets ESC/POS diretamente nas impressoras — de rede (porta
 * 9100) ou USB/local via spooler do Windows — e reporta o resultado.
 *
 * MODELO DE FUNCIONAMENTO — porquê WebSocket e não polling:
 *
 * O PC do restaurante está atrás de um NAT (muitas vezes CGNAT): o servidor
 * NÃO o consegue contactar de fora. A solução é o agente abrir UMA ligação de
 * SAÍDA e mantê-la aberta — o NAT deixa sempre sair. O servidor empurra
 * "há trabalho" por esse túnel. Funcionalmente é "o servidor liga ao PC",
 * sem tocar no router do cliente.
 *
 * Porque isto importa (custo): a base de dados Neon suspende-se ao fim de
 * 5 minutos sem consultas, e é o TEMPO ACORDADO que é faturado, não o número
 * de consultas. O agente antigo consultava de 3 em 3 segundos e mantinha a
 * base acordada 24/7. Passar para 60 s NÃO resolveria nada — 60 s < 5 min.
 * Por isso: enquanto o WebSocket está ligado, ZERO consultas. O poll de
 * segurança só corre quando o WebSocket caiu — ou seja, quando já há avaria.
 *
 * CommonJS + apenas módulos nativos (http/https/net/tls/crypto/fs/
 * child_process/os) — compatível com Node.js 12+, incluindo Windows 7/8
 * quando empacotado com `pkg` (ver package.json). Impressão USB requer
 * Windows (usa powershell.exe + winspool.drv). Para PCs com Windows 10/11,
 * prefira o agente Tauri.
 *
 * Uso:  node agent.cjs [caminho/para/config.json]
 */

"use strict";

const { readFileSync, writeFileSync, unlinkSync } = require("fs");
const { createConnection } = require("net");
const { connect: tlsConnect } = require("tls");
const { createHash, randomBytes } = require("crypto");
const { resolve, join } = require("path");
const { execFile } = require("child_process");
const os = require("os");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// Nota: em versões anteriores, uma configuração em falta matava o processo
// com um "Prima ENTER para fechar". Com a interface web isso deixou de fazer
// sentido — arrancar e mostrar o formulário é precisamente a resposta certa a
// uma configuração incompleta. O agente já não termina sozinho.

// ── Config ──────────────────────────────────────────────────────────────
const configPath = resolve(process.argv[2] || "./config.json");
// Uma configuração em falta deixou de ser fatal: é precisamente o caso em que
// o restaurante precisa da interface para a preencher. O que impede o agente
// de imprimir fica registado em `configIssues()` e aparece no ecrã.
let config = {};
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  config = {};
}

// `serverUrl` e `realtimeUrl` são vizinhos no config.json e trocam-se com
// facilidade — um `wss://` no endereço do servidor daria uma ligação à porta
// errada, e um `https://` no do tempo real um esquema recusado. Normalizar
// aqui é mais barato do que explicar a diferença ao restaurante.
function normalizeUrl(value, kind) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const rest = trimmed.replace(/^(https?|wss?):\/\//, "");
  const secure = /^(https|wss):\/\//.test(trimmed) || !/^[a-z]+:\/\//.test(trimmed);
  if (kind === "ws") return `${secure ? "wss" : "ws"}://${rest}`;
  return `${secure ? "https" : "http"}://${rest}`;
}

const DEFAULT_SERVER_URL = "https://new.qomanda.eu";
const DEFAULT_REALTIME_URL = "https://realtime.qomanda.eu";
const DEFAULT_REALTIME_KEY =
  "a0g4w5Gk3ujFL9wurqHyCdEOmf5fQdLsFLHtHw139pBmZFojPrXQSIWx9Zd6BtxAl2fywhXq379ZG0hSF7jw";
const PRINT_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 10000;
const STATIONS = ["kitchen", "bar", "payment"];

// Estado derivado da configuração. Deixou de ser `const` porque a interface
// web grava alterações em execução — mudar o token muda o canal de despertar,
// e isso obriga a refazer a ligação de tempo real sem reiniciar o agente.
let SERVER_URL = "";
let TOKEN = "";
let PRINTERS = {};
let REALTIME_URL = "";
let REALTIME_KEY = "";
let REALTIME_ENABLED = false;
/**
 * Canal de despertar. DEVE ser idêntico ao cálculo de
 * src/lib/print-agent-channel.ts no servidor — se divergir, o agente escuta um
 * canal onde ninguém publica e nunca recebe um único talão.
 */
let CHANNEL = "";

function applyConfig(next) {
  config = next || {};
  SERVER_URL = normalizeUrl(config.serverUrl || DEFAULT_SERVER_URL, "http");
  TOKEN = String(config.token || "").trim();
  PRINTERS = config.printers || {};
  REALTIME_URL = normalizeUrl(config.realtimeUrl || DEFAULT_REALTIME_URL, "ws");
  REALTIME_KEY = config.realtimeKey || DEFAULT_REALTIME_KEY;
  REALTIME_ENABLED = Boolean(REALTIME_URL && REALTIME_KEY);
  CHANNEL = TOKEN ? `print-agent-${createHash("sha256").update(TOKEN).digest("hex").slice(0, 32)}` : "";
}

/** O que ainda impede o agente de imprimir. Vazio = pronto a funcionar. */
function configIssues() {
  const issues = [];
  if (!TOKEN) issues.push("Falta o token do agente.");
  if (!SERVER_URL) issues.push("Falta o endereço do servidor.");
  if (!REALTIME_ENABLED) issues.push("Falta o servidor de tempo real.");
  const hasPrinter = STATIONS.some(function (station) {
    const p = PRINTERS[station];
    return p && (p.host || p.printerName);
  });
  if (!hasPrinter) issues.push("Nenhuma impressora configurada.");
  return issues;
}

function isReady() {
  return configIssues().length === 0;
}

applyConfig(config);

// ── Registo ─────────────────────────────────────────────────────────────
// Os mesmos eventos vão para a consola (útil quando corre como serviço) e
// para um anel em memória que a interface web lê. Sem ficheiro de log: num PC
// de restaurante ninguém o vai consultar, e crescer sem limite é pior.
const MAX_LOGS = 200;
const logs = [];
const REALTIME_STATE = { connected: false, lastError: null, lastActivityAt: null };

function pushLog(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  const line = `[qomanda-agent] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  return entry;
}

// ── HTTP (sem fetch — compatível com Node 12+) ──────────────────────────
function request(url, options) {
  options = options || {};
  return new Promise((resolvePromise, rejectPromise) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      rejectPromise(err);
      return;
    }
    const lib = target.protocol === "https:" ? https : http;
    const payload = options.body ? Buffer.from(options.body) : null;
    const headers = Object.assign({}, options.headers || {});
    if (payload) headers["Content-Length"] = payload.length;

    const req = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: options.method || "GET",
        headers,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Timeout de ligação ao servidor")));
    req.on("error", rejectPromise);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Impressão TCP 9100 (RAW ESC/POS, impressoras de rede) ───────────────
function printNetwork(printer, data) {
  return new Promise((resolvePrint, rejectPrint) => {
    const socket = createConnection({ host: printer.host, port: printer.port || 9100 });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPrint(new Error(`Timeout ao contactar a impressora ${printer.host}:${printer.port || 9100}`));
    }, PRINT_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write(data, (err) => {
        clearTimeout(timer);
        if (err) {
          socket.destroy();
          rejectPrint(err);
        } else {
          socket.end();
        }
      });
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolvePrint();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      rejectPrint(err);
    });
  });
}

// ── Impressão USB/local (spooler do Windows, datatype RAW) ──────────────
// Sem binding nativo (mantém o build zero-dependências compatível com
// `pkg`/Node 12): escreve os bytes num ficheiro temporário e invoca um
// script PowerShell que chama winspool.drv via P/Invoke — o mesmo
// OpenPrinter/StartDocPrinter/WritePrinter usado pelo agente Tauri.
const RAW_PRINT_POWERSHELL = `
param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$DataPath
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", EntryPoint="ClosePrinter", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern int StartDocPrinter(IntPtr hPrinter, int level, DOCINFOA di);

    [DllImport("winspool.drv", EntryPoint="EndDocPrinter", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint="StartPagePrinter", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint="EndPagePrinter", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint="WritePrinter", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    public static void SendBytesToPrinter(string printerName, byte[] bytes)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "Qomanda Ticket";
        di.pDataType = "RAW";
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("Nao foi possivel abrir a impressora \\"" + printerName + "\\".");
        try
        {
            if (StartDocPrinter(hPrinter, 1, di) == 0)
                throw new Exception("Falha ao iniciar o trabalho de impressao em \\"" + printerName + "\\".");
            try
            {
                if (!StartPagePrinter(hPrinter))
                    throw new Exception("Falha ao iniciar a pagina de impressao em \\"" + printerName + "\\".");
                try
                {
                    int written;
                    if (!WritePrinter(hPrinter, bytes, bytes.Length, out written) || written != bytes.Length)
                        throw new Exception("Falha ao escrever na impressora \\"" + printerName + "\\".");
                }
                finally { EndPagePrinter(hPrinter); }
            }
            finally { EndDocPrinter(hPrinter); }
        }
        finally { ClosePrinter(hPrinter); }
    }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($DataPath)
[RawPrinterHelper]::SendBytesToPrinter($PrinterName, $bytes)
`;

function tempFilePath(suffix) {
  return join(os.tmpdir(), `qomanda-agent-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

function printUsb(printer, data) {
  return new Promise((resolvePrint, rejectPrint) => {
    if (process.platform !== "win32") {
      rejectPrint(new Error("Impressão USB/local só é suportada no Windows."));
      return;
    }

    const scriptPath = tempFilePath(".ps1");
    const dataPath = tempFilePath(".bin");
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        unlinkSync(scriptPath);
      } catch (_err) {}
      try {
        unlinkSync(dataPath);
      } catch (_err) {}
    };

    try {
      writeFileSync(scriptPath, RAW_PRINT_POWERSHELL, "utf8");
      writeFileSync(dataPath, data);
    } catch (err) {
      cleanup();
      rejectPrint(err);
      return;
    }

    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-PrinterName",
        printer.printerName,
        "-DataPath",
        dataPath,
      ],
      { timeout: PRINT_TIMEOUT_MS, windowsHide: true },
      (err, _stdout, stderr) => {
        cleanup();
        if (err) {
          const message = (stderr && stderr.trim()) || err.message;
          rejectPrint(new Error(`Falha ao imprimir em "${printer.printerName}": ${message}`));
          return;
        }
        resolvePrint();
      }
    );
  });
}

function printRaw(printer, data) {
  return printer.kind === "usb" ? printUsb(printer, data) : printNetwork(printer, data);
}

function printerLabel(printer) {
  return printer.kind === "usb" ? `${printer.printerName} (USB)` : `${printer.host}:${printer.port || 9100}`;
}

// ── API Qomanda ─────────────────────────────────────────────────────────
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function fetchJobs() {
  const res = await request(`${SERVER_URL}/api/print-agent/jobs`, { headers });
  if (res.status === 401) {
    throw new Error("Token inválido — verifique a configuração (Dashboard > Equipa > Impressão).");
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`Servidor respondeu ${res.status}`);
  const body = JSON.parse(res.body);
  return body.jobs || [];
}

async function reportJob(jobId, ok, error) {
  try {
    await request(`${SERVER_URL}/api/print-agent/jobs/${jobId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ok, error }),
    });
  } catch (err) {
    pushLog("error", `Falha ao reportar o job ${jobId}: ${err.message}`);
  }
}

// ── Escolha da impressora por posto ─────────────────────────────────────
// O recibo do cliente ("payment") sai quase sempre no balcão, e muitas casas
// só têm uma térmica aí. Por isso, se "payment" não estiver configurado,
// usamos a do bar e, em último caso, a da cozinha — com um aviso, porque um
// recibo de cliente a sair na cozinha é uma configuração a corrigir, não um
// funcionamento normal. Falhar era a alternativa, mas deixaria o cliente à
// espera de um talão que nunca sai.
let warnedPaymentFallback = false;

function resolvePrinter(station) {
  const direct = PRINTERS[station];
  if (direct) return direct;

  if (station === "payment") {
    const fallback = PRINTERS.bar || PRINTERS.kitchen;
    if (fallback) {
      if (!warnedPaymentFallback) {
        warnedPaymentFallback = true;
        pushLog(
          "warn",
          `Sem impressora "Pagamento" configurada — os recibos vão sair em ${printerLabel(fallback)}.`
        );
        pushLog("warn", "Configure o posto Pagamento para os separar.");
      }
      return fallback;
    }
  }
  return null;
}

// ── Recolha e impressão ─────────────────────────────────────────────────
// Um único drain de cada vez: vários eventos seguidos (3 tickets num pedido)
// não devem lançar 3 recolhas concorrentes sobre a mesma fila.
let draining = false;
let drainAgain = false;

async function drainJobs(reason) {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    const jobs = await fetchJobs();
    REALTIME_STATE.lastActivityAt = new Date().toISOString();
    REALTIME_STATE.lastError = null;
    if (jobs.length > 0) {
      pushLog("info", `${jobs.length} job(s) recebido(s) (${reason}).`);
    }

    for (const job of jobs) {
      const printer = resolvePrinter(job.station);
      if (!printer) {
        pushLog("warn", `Sem impressora configurada para "${job.station}" — job ${job.id} falhado.`);
        await reportJob(job.id, false, `Sem impressora configurada para o posto "${job.station}" no agente.`);
        continue;
      }

      const data = Buffer.from(job.dataBase64, "base64");
      try {
        await printRaw(printer, data);
        pushLog("success", `Impresso job ${job.id} (${job.station}) em ${printerLabel(printer)}`);
        await reportJob(job.id, true);
      } catch (err) {
        pushLog("error", `Falha no job ${job.id} (${job.station}): ${err.message}`);
        await reportJob(job.id, false, err.message);
      }
    }
  } catch (err) {
    REALTIME_STATE.lastError = err.message;
    pushLog("error", `Erro ao recolher jobs: ${err.message}`);
  } finally {
    draining = false;
    if (drainAgain) {
      drainAgain = false;
      drainJobs("evento durante recolha anterior");
    }
  }
}

// ── WebSocket mínimo (RFC 6455) ─────────────────────────────────────────
// O Node 12 — o runtime embutido no .exe para Windows 7 — não tem `WebSocket`
// global; só chegou no Node 22. E acrescentar o pacote `ws` quebrava a
// promessa "zero dependências" que mantém este ficheiro empacotável com
// `pkg`. Do lado do cliente o protocolo é pequeno: um handshake HTTP com
// Upgrade, frames mascarados a sair, frames não mascarados a entrar.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const HANDSHAKE_TIMEOUT_MS = 15000;

/**
 * Liga-se a `url` e devolve `{ sendText, close }`, ou `null` se a URL for
 * inválida. `handlers` recebe `onOpen`, `onMessage(texto)` e `onClose(motivo)`
 * — `onClose` é chamado exatamente uma vez, seja qual for a causa.
 */
function openWebSocket(url, handlers) {
  let target;
  try {
    target = new URL(url);
  } catch (err) {
    return null;
  }

  const secure = target.protocol === "wss:" || target.protocol === "https:";
  const port = Number(target.port) || (secure ? 443 : 80);
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");

  const socket = secure
    ? tlsConnect({ host: target.hostname, port, servername: target.hostname })
    : createConnection({ host: target.hostname, port });

  let closed = false;
  let handshakeDone = false;
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = 0;
  let fragments = [];

  const handshakeTimer = setTimeout(() => {
    finish("timeout no handshake do servidor de tempo real");
  }, HANDSHAKE_TIMEOUT_MS);

  function finish(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(handshakeTimer);
    socket.destroy();
    handlers.onClose(reason);
  }

  function sendFrame(opcode, payload) {
    if (closed || socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | opcode; // FIN=1: nunca fragmentamos o que enviamos
    // Todo o tráfego cliente → servidor é obrigatoriamente mascarado.
    const mask = randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  }

  function readHandshake() {
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    const head = buffer.slice(0, end).toString("latin1");
    buffer = buffer.slice(end + 4);

    const lines = head.split("\r\n");
    if (!/^HTTP\/1\.[01] 101(\s|$)/.test(lines[0])) {
      finish(`o servidor de tempo real recusou a ligação (${lines[0]})`);
      return;
    }
    // Confirmar o Sec-WebSocket-Accept: é o que distingue um servidor
    // WebSocket de um proxy que devolveu 101 por engano.
    let accept = null;
    for (let i = 1; i < lines.length; i++) {
      const sep = lines[i].indexOf(":");
      if (sep === -1) continue;
      if (lines[i].slice(0, sep).trim().toLowerCase() === "sec-websocket-accept") {
        accept = lines[i].slice(sep + 1).trim();
      }
    }
    if (accept !== expectedAccept) {
      finish("resposta de handshake inválida do servidor de tempo real");
      return;
    }

    handshakeDone = true;
    clearTimeout(handshakeTimer);
    handlers.onOpen();
  }

  function handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OPCODE.PING:
        sendFrame(OPCODE.PONG, payload);
        return;
      case OPCODE.PONG:
        return;
      case OPCODE.CLOSE:
        sendFrame(OPCODE.CLOSE, Buffer.alloc(0));
        finish("ligação fechada pelo servidor");
        return;
      case OPCODE.CONTINUATION:
        fragments.push(payload);
        break;
      case OPCODE.TEXT:
      case OPCODE.BINARY:
        fragmentOpcode = opcode;
        fragments = [payload];
        break;
      default:
        return;
    }
    if (!fin) return;
    const full = Buffer.concat(fragments);
    fragments = [];
    if (fragmentOpcode === OPCODE.TEXT || fragmentOpcode === OPCODE.BINARY) {
      handlers.onMessage(full.toString("utf8"));
    }
  }

  function readFrames() {
    for (;;) {
      if (closed || buffer.length < 2) return;
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        // Um aviso "há trabalho" tem dezenas de bytes. Um frame de 4 GB é um
        // servidor avariado ou hostil — recusar é melhor do que tentar
        // acumulá-lo em memória.
        if (buffer.readUInt32BE(offset) !== 0) {
          finish("frame de tempo real demasiado grande");
          return;
        }
        len = buffer.readUInt32BE(offset + 4);
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return;

      // Cópia: `slice` partilha a memória do buffer acumulado.
      const payload = Buffer.from(buffer.slice(offset, offset + len));
      buffer = buffer.slice(offset + len);
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      handleFrame(fin, opcode, payload);
    }
  }

  socket.on(secure ? "secureConnect" : "connect", () => {
    const hostHeader = port === (secure ? 443 : 80) ? target.hostname : `${target.hostname}:${port}`;
    socket.write(
      `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n"
    );
  });

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshakeDone) readHandshake();
    if (handshakeDone) readFrames();
  });

  socket.on("error", (err) => finish(`erro de ligação ao tempo real: ${err.message}`));
  socket.on("close", () => finish("ligação fechada"));

  return {
    sendText(text) {
      sendFrame(OPCODE.TEXT, Buffer.from(text, "utf8"));
    },
    close() {
      finish("fechado pelo agente");
    },
  };
}

// ── Tempo real (protocolo Pusher, servido pelo Soketi) ──────────────────
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let keepaliveTimer = null;

// Keepalive. No protocolo Pusher é o CLIENTE que tem de dar sinal de vida: o
// servidor fecha a ligação de um cliente calado há mais de `activity_timeout`
// segundos (120 por omissão). Sem isto a ligação caía de 2 em 2 minutos e cada
// reconexão fazia uma recolha — ou seja, uma consulta à base de dados a cada
// 2 minutos, que é precisamente o que o tempo real veio evitar.
// Pingamos a 75% da janela anunciada: uma fração em vez de uma margem fixa,
// para funcionar tanto com os 120 s do Soketi (ping a 90 s) como com um valor
// curto — uma margem fixa de 10 s daria um período negativo se o servidor
// anunciasse menos do que isso.
const DEFAULT_ACTIVITY_TIMEOUT_MS = 120000;
const KEEPALIVE_FRACTION = 0.75;
const MIN_KEEPALIVE_MS = 1000;

/**
 * O `data` do `connection_established` vem, no protocolo Pusher, como uma
 * STRING que contém JSON — mas alguns servidores mandam o objeto diretamente.
 */
function activityTimeoutMs(data) {
  let parsed = data;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      return null;
    }
  }
  if (!parsed || typeof parsed.activity_timeout !== "number") return null;
  return parsed.activity_timeout * 1000;
}

function startKeepalive(timeoutMs) {
  stopKeepalive();
  const window = timeoutMs || DEFAULT_ACTIVITY_TIMEOUT_MS;
  const period = Math.max(MIN_KEEPALIVE_MS, Math.floor(window * KEEPALIVE_FRACTION));
  keepaliveTimer = setInterval(() => {
    if (ws) ws.sendText(JSON.stringify({ event: "pusher:ping", data: {} }));
  }, period);
}

function stopKeepalive() {
  if (!keepaliveTimer) return;
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function connectRealtime() {
  if (!REALTIME_ENABLED) return;

  const url = `${REALTIME_URL}/app/${REALTIME_KEY}?protocol=7&client=qomanda-agent&version=1.0.0`;

  ws = openWebSocket(url, {
    onOpen() {
      reconnectAttempts = 0;
    },

    onMessage(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        return;
      }

      switch (msg.event) {
        case "pusher:connection_established":
          // O servidor anuncia aqui de quanto em quanto tempo espera ver sinal
          // de vida. Pingamos com uma margem antes disso.
          startKeepalive(activityTimeoutMs(msg.data));
          // Canal público: nenhuma autorização necessária — o segredo é o
          // próprio nome do canal, derivado do token.
          ws.sendText(JSON.stringify({ event: "pusher:subscribe", data: { channel: CHANNEL } }));
          break;

        case "pusher_internal:subscription_succeeded":
          REALTIME_STATE.connected = true;
          REALTIME_STATE.lastError = null;
          pushLog("success", "Tempo real ligado — à espera de trabalhos.");
          // Apanhar o que possa ter sido enfileirado enquanto estávamos offline.
          drainJobs("ligação estabelecida");
          break;

        case "pusher:ping":
          ws.sendText(JSON.stringify({ event: "pusher:pong", data: {} }));
          break;

        case "pusher:error":
          pushLog("error", `Erro do servidor de tempo real: ${JSON.stringify(msg.data)}`);
          break;

        case "job-queued":
          drainJobs("aviso do servidor");
          break;
      }
    },

    onClose(reason) {
      scheduleReconnect(reason);
    },
  });

  if (!ws) scheduleReconnect(`URL de tempo real inválida: ${REALTIME_URL}`);
}

function scheduleReconnect(why) {
  ws = null;
  stopKeepalive();
  REALTIME_STATE.connected = false;
  REALTIME_STATE.lastError = why;
  if (reconnectTimer) return;
  reconnectAttempts++;
  // Backoff exponencial travado a 60 s.
  const delay = Math.min(2000 * Math.pow(2, Math.min(reconnectAttempts - 1, 5)), 60000);
  // Enquanto isto durar não sai nenhum talão: o tempo real é o único caminho
  // até à fila. A recolha feita ao subscrever recupera tudo o que se acumulou
  // entretanto, e o servidor reentrega o que nunca foi confirmado — os talões
  // atrasam-se, não se perdem.
  pushLog("warn", `Tempo real em baixo (${why}) — nova tentativa em ${delay / 1000}s.`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRealtime();
  }, delay);
}

/**
 * Aplica uma configuração nova sem reiniciar o agente. Mudar o token muda o
 * canal de despertar, por isso a ligação de tempo real tem de ser refeita —
 * senão o agente continuava a escutar o canal do token antigo.
 */
function reloadConfig(next) {
  const before = { channel: CHANNEL, url: REALTIME_URL, key: REALTIME_KEY };
  applyConfig(next);
  writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
  warnedPaymentFallback = false;
  pushLog("info", "Configuração gravada.");

  const realtimeChanged =
    CHANNEL !== before.channel || REALTIME_URL !== before.url || REALTIME_KEY !== before.key;
  if (!realtimeChanged) return;

  // Recomeçar do zero: uma configuração acabada de corrigir não deve esperar
  // pelos 60 s do backoff da configuração anterior.
  reconnectAttempts = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close(); // o onClose agenda a reconexão com os valores novos
  } else {
    startRealtime();
  }
}

function startRealtime() {
  if (!isReady()) {
    pushLog("warn", `Configuração incompleta: ${configIssues().join(" ")}`);
    return;
  }
  connectRealtime();
  // Recolha inicial: pode haver trabalho em fila desde a última paragem.
  drainJobs("arranque");
}

// ── Impressoras instaladas no Windows ───────────────────────────────────
// `Get-Printer` só existe a partir do Windows 8 — neste agente, cujo motivo
// de existir é o Windows 7, tem de ser WMI, que funciona no PowerShell 2.0.
function listWindowsPrinters() {
  return new Promise((resolvePrinters) => {
    if (process.platform !== "win32") {
      resolvePrinters([]);
      return;
    }
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-WmiObject -Class Win32_Printer | ForEach-Object { $_.Name }",
      ],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolvePrinters([]);
          return;
        }
        const names = String(stdout)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        resolvePrinters(names);
      }
    );
  });
}

// Talão de teste ESC/POS: inicializa, centra, imprime, avança e corta.
function testTicket() {
  const ESC = 0x1b;
  const GS = 0x1d;
  const head = Buffer.from([ESC, 0x40, ESC, 0x61, 0x01]);
  const body = Buffer.from("QOMANDA\nTeste de impressao\nOK\n\n\n", "latin1");
  const cut = Buffer.from([GS, 0x56, 0x00]);
  return Buffer.concat([head, body, cut]);
}

// ── Interface web local ─────────────────────────────────────────────────
// O agente Tauri tem formulário, teste de impressora e registo em direto; no
// Windows 7 havia só uma consola preta e um JSON para editar à mão. Servimos
// a mesma coisa a partir do próprio agente: o módulo `http` já cá está, por
// isso não custa nenhuma dependência e continua a caber num único .exe.
//
// Só escuta em 127.0.0.1 — a página mostra o token do agente, e expô-lo à
// rede do restaurante seria entregá-lo a qualquer dispositivo do Wi-Fi. A
// chave de sessão na URL impede ainda que uma página aberta noutro separador
// do navegador consiga falar com o agente.
const UI_PORT = Number(config.uiPort) || 7654;
const UI_KEY = randomBytes(16).toString("hex");

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        rejectBody(new Error("Pedido demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (err) {
        rejectBody(new Error("JSON inválido"));
      }
    });
    req.on("error", rejectBody);
  });
}

function currentState() {
  return {
    config: {
      serverUrl: config.serverUrl || DEFAULT_SERVER_URL,
      token: config.token || "",
      realtimeUrl: config.realtimeUrl || DEFAULT_REALTIME_URL,
      realtimeKey: config.realtimeKey || DEFAULT_REALTIME_KEY,
      printers: PRINTERS,
    },
    status: {
      ready: isReady(),
      issues: configIssues(),
      realtimeConnected: REALTIME_STATE.connected,
      lastError: REALTIME_STATE.lastError,
      lastActivityAt: REALTIME_STATE.lastActivityAt,
    },
    logs: logs,
  };
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/state" && req.method === "GET") {
    sendJson(res, 200, currentState());
    return;
  }

  if (pathname === "/api/printers" && req.method === "GET") {
    const printers = await listWindowsPrinters();
    sendJson(res, 200, { printers });
    return;
  }

  if (pathname === "/api/config" && req.method === "POST") {
    const next = await readBody(req);
    reloadConfig(next);
    sendJson(res, 200, currentState());
    return;
  }

  if (pathname === "/api/test" && req.method === "POST") {
    const printer = await readBody(req);
    if (!printer || (!printer.host && !printer.printerName)) {
      sendJson(res, 400, { error: "Indique o IP ou o nome da impressora." });
      return;
    }
    try {
      await printRaw(printer, testTicket());
      pushLog("success", `Talão de teste enviado para ${printerLabel(printer)}`);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      pushLog("error", `Falha no teste de impressão: ${err.message}`);
      sendJson(res, 200, { ok: false, error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Não encontrado" });
}

function startWebUi() {
  const server = http.createServer((req, res) => {
    let parsed;
    try {
      parsed = new URL(req.url, `http://127.0.0.1:${UI_PORT}`);
    } catch (err) {
      res.writeHead(400).end();
      return;
    }
    const pathname = parsed.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      // A chave vai na URL; a página guarda-a e usa-a nos pedidos seguintes.
      if (parsed.searchParams.get("k") !== UI_KEY) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Abra a interface pelo endereço que o agente mostrou na consola.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(renderPage());
      return;
    }

    if (pathname.indexOf("/api/") === 0) {
      if (parsed.searchParams.get("k") !== UI_KEY) {
        sendJson(res, 403, { error: "Chave de sessão inválida." });
        return;
      }
      handleApi(req, res, pathname).catch((err) => {
        sendJson(res, 500, { error: err.message });
      });
      return;
    }

    res.writeHead(404).end();
  });

  server.on("error", (err) => {
    pushLog("error", `Não foi possível abrir a interface na porta ${UI_PORT}: ${err.message}`);
    pushLog("warn", 'Defina outra porta com "uiPort" no config.json.');
  });

  server.listen(UI_PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${UI_PORT}/?k=${UI_KEY}`;
    pushLog("info", `Interface: ${url}`);
    openBrowser(url);
  });
}

// A página é servida ao Internet Explorer 11 — o navegador por omissão de um
// Windows 7 acabado de instalar. Daí ES5 puro no cliente: nada de `fetch`,
// `const`, arrow functions ou template literals, que rebentariam lá sem
// qualquer mensagem útil para o restaurante.
function renderPage() {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Qomanda Print Agent</title>
<style>
  body { font-family: Segoe UI, Tahoma, sans-serif; background: #f1f5f9; color: #0f172a;
         margin: 0; padding: 24px; font-size: 14px; }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #64748b; margin: 0 0 20px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
          padding: 16px; margin-bottom: 16px; }
  .status { display: flex; align-items: center; }
  .dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 10px; background: #94a3b8; }
  .dot.ok { background: #16a34a; }
  .dot.err { background: #dc2626; }
  .status-text { font-weight: 600; }
  .status-meta { color: #64748b; font-size: 12.5px; }
  label { display: block; font-size: 12.5px; color: #475569; margin: 12px 0 4px; }
  input[type=text], input[type=password], select {
    width: 100%; padding: 7px 9px; border: 1px solid #cbd5e1; border-radius: 5px;
    font-size: 14px; box-sizing: border-box; font-family: inherit; }
  .station { border-top: 1px solid #e2e8f0; padding-top: 12px; margin-top: 12px; }
  .station-head { font-weight: 600; }
  .row { margin-top: 6px; }
  .row > * { vertical-align: middle; }
  button { background: #1e293b; color: #fff; border: 0; border-radius: 5px;
           padding: 8px 14px; font-size: 13px; cursor: pointer; font-family: inherit; }
  button.sec { background: #e2e8f0; color: #0f172a; }
  button[disabled] { opacity: .5; cursor: default; }
  .note { font-size: 12.5px; padding: 6px 0; }
  .note.ok { color: #16a34a; }
  .note.err { color: #dc2626; }
  .issues { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
            border-radius: 6px; padding: 10px; margin-bottom: 12px; font-size: 13px; }
  #logs { height: 240px; overflow-y: auto; background: #0f172a; color: #e2e8f0;
          border-radius: 6px; padding: 10px; font-family: Consolas, monospace; font-size: 12px; }
  #logs div { padding: 1px 0; white-space: pre-wrap; }
  .l-error { color: #fca5a5; } .l-warn { color: #fcd34d; } .l-success { color: #86efac; }
  .l-time { color: #64748b; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Qomanda Print Agent</h1>
  <p class="sub">Impressão automática dos talões nas impressoras do restaurante.</p>

  <div class="card status">
    <span class="dot" id="dot"></span>
    <div>
      <div class="status-text" id="statusText">A carregar...</div>
      <div class="status-meta" id="statusMeta"></div>
    </div>
  </div>

  <div class="card">
    <div id="issues"></div>
    <label>Token do agente <span style="color:#94a3b8">(Dashboard &rarr; Equipa &rarr; Impressão)</span></label>
    <input type="text" id="token" autocomplete="off">

    <div id="stations"></div>

    <div class="row" style="margin-top:16px">
      <button type="button" id="save">Guardar</button>
      <span class="note" id="saveNote"></span>
    </div>
  </div>

  <div class="card">
    <div style="font-weight:600;margin-bottom:8px">Atividade</div>
    <div id="logs"></div>
  </div>
</div>

<script>
(function () {
  var KEY = (location.search.match(/[?&]k=([^&]+)/) || [])[1] || "";
  var STATIONS = [
    { id: "kitchen", label: "Cozinha" },
    { id: "bar", label: "Bar" },
    { id: "payment", label: "Pagamento" }
  ];
  var windowsPrinters = [];
  var state = null;

  function api(method, path, body, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, "/api/" + path + "?k=" + KEY, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
      cb(xhr.status, data);
    };
    xhr.send(body ? JSON.stringify(body) : null);
  }

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function stationHtml(st, printer) {
    var kind = printer && printer.kind === "usb" ? "usb" : "network";
    var host = printer && printer.host ? printer.host : "";
    var port = printer && printer.port ? printer.port : 9100;
    var name = printer && printer.printerName ? printer.printerName : "";
    var on = printer ? " checked" : "";
    var h = '<div class="station">';
    h += '<label class="station-head"><input type="checkbox" data-on="' + st.id + '"' + on + '> ' + st.label + '</label>';
    h += '<div data-body="' + st.id + '"' + (printer ? "" : ' style="display:none"') + '>';
    h += '<div class="row">';
    h += '<label style="display:inline;margin-right:12px"><input type="radio" name="k-' + st.id + '" data-kind="' + st.id + '" value="network"' + (kind === "network" ? " checked" : "") + '> Rede (IP)</label>';
    h += '<label style="display:inline"><input type="radio" name="k-' + st.id + '" data-kind="' + st.id + '" value="usb"' + (kind === "usb" ? " checked" : "") + '> USB / Local</label>';
    h += "</div>";
    h += '<div class="row" data-net="' + st.id + '"' + (kind === "network" ? "" : ' style="display:none"') + '>';
    h += '<input type="text" data-host="' + st.id + '" value="' + esc(host) + '" placeholder="192.168.1.50" style="width:200px;display:inline-block">';
    h += ' <input type="text" data-port="' + st.id + '" value="' + esc(port) + '" style="width:80px;display:inline-block">';
    h += "</div>";
    h += '<div class="row" data-usb="' + st.id + '"' + (kind === "usb" ? "" : ' style="display:none"') + '>';
    h += printerSelect(st.id, name);
    h += "</div>";
    h += '<div class="row"><button type="button" class="sec" data-test="' + st.id + '">Testar</button> <span class="note" data-note="' + st.id + '"></span></div>';
    h += "</div></div>";
    return h;
  }

  function printerSelect(id, current) {
    if (!windowsPrinters.length) {
      return '<input type="text" data-name="' + id + '" value="' + esc(current) +
        '" placeholder="Nome exato da impressora no Windows">';
    }
    var h = '<select data-name="' + id + '"><option value="">Selecione...</option>';
    var found = false;
    for (var i = 0; i < windowsPrinters.length; i++) {
      var p = windowsPrinters[i];
      if (p === current) found = true;
      h += '<option value="' + esc(p) + '"' + (p === current ? " selected" : "") + ">" + esc(p) + "</option>";
    }
    if (current && !found) h += '<option value="' + esc(current) + '" selected>' + esc(current) + "</option>";
    return h + "</select>";
  }

  function renderStations() {
    var h = "";
    for (var i = 0; i < STATIONS.length; i++) {
      h += stationHtml(STATIONS[i], state.config.printers[STATIONS[i].id]);
    }
    el("stations").innerHTML = h;
    bindStations();
  }

  function bindStations() {
    for (var i = 0; i < STATIONS.length; i++) {
      (function (id) {
        var on = document.querySelector('[data-on="' + id + '"]');
        on.onclick = function () {
          document.querySelector('[data-body="' + id + '"]').style.display = on.checked ? "" : "none";
        };
        var radios = document.querySelectorAll('[data-kind="' + id + '"]');
        for (var r = 0; r < radios.length; r++) {
          radios[r].onclick = function () {
            var usb = this.value === "usb";
            document.querySelector('[data-net="' + id + '"]').style.display = usb ? "none" : "";
            document.querySelector('[data-usb="' + id + '"]').style.display = usb ? "" : "none";
          };
        }
        document.querySelector('[data-test="' + id + '"]').onclick = function () {
          var note = document.querySelector('[data-note="' + id + '"]');
          note.className = "note";
          note.innerHTML = "A testar...";
          api("POST", "test", readStation(id), function (status, data) {
            if (data && data.ok) {
              note.className = "note ok";
              note.innerHTML = "Talão enviado.";
            } else {
              note.className = "note err";
              note.innerHTML = esc((data && data.error) || "Falhou.");
            }
          });
        };
      })(STATIONS[i].id);
    }
  }

  function readStation(id) {
    var kindEl = document.querySelector('[data-kind="' + id + '"]:checked');
    var kind = kindEl ? kindEl.value : "network";
    var nameEl = document.querySelector('[data-name="' + id + '"]');
    return {
      kind: kind,
      host: kind === "network" ? document.querySelector('[data-host="' + id + '"]').value : "",
      port: parseInt(document.querySelector('[data-port="' + id + '"]').value, 10) || 9100,
      printerName: kind === "usb" && nameEl ? nameEl.value : ""
    };
  }

  function renderStatus() {
    var s = state.status;
    var dot = el("dot"), text = el("statusText"), meta = el("statusMeta");
    if (s.realtimeConnected) {
      dot.className = "dot ok";
      text.innerHTML = "Tempo real ligado";
      meta.innerHTML = "À espera de trabalhos — sem consultas ao servidor.";
    } else if (!s.ready) {
      dot.className = "dot";
      text.innerHTML = "Configuração incompleta";
      meta.innerHTML = "Preencha os campos abaixo para começar a imprimir.";
    } else {
      dot.className = "dot err";
      text.innerHTML = "Sem ligação ao tempo real";
      meta.innerHTML = esc(s.lastError || "A reconectar...");
    }
    el("issues").innerHTML = s.issues.length
      ? '<div class="issues">' + esc(s.issues.join(" ")) + "</div>"
      : "";
  }

  function renderLogs() {
    var box = el("logs");
    var stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    var h = "";
    for (var i = 0; i < state.logs.length; i++) {
      var entry = state.logs[i];
      var t = entry.ts.substring(11, 19);
      h += '<div class="l-' + entry.level + '"><span class="l-time">' + t + "</span>  " + esc(entry.message) + "</div>";
    }
    box.innerHTML = h;
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function refresh(first) {
    api("GET", "state", null, function (status, data) {
      if (!data) return;
      var firstLoad = !state;
      state = data;
      renderStatus();
      renderLogs();
      if (firstLoad) {
        el("token").value = state.config.token || "";
        renderStations();
      }
    });
  }

  el("save").onclick = function () {
    var note = el("saveNote");
    var printers = {};
    for (var i = 0; i < STATIONS.length; i++) {
      var id = STATIONS[i].id;
      if (document.querySelector('[data-on="' + id + '"]').checked) printers[id] = readStation(id);
    }
    var next = {
      serverUrl: state.config.serverUrl,
      token: el("token").value,
      realtimeUrl: state.config.realtimeUrl,
      realtimeKey: state.config.realtimeKey,
      printers: printers
    };
    el("save").disabled = true;
    note.className = "note";
    note.innerHTML = "A guardar...";
    api("POST", "config", next, function (status, data) {
      el("save").disabled = false;
      if (status === 200 && data) {
        state = data;
        note.className = "note ok";
        note.innerHTML = "Guardado.";
        renderStatus();
      } else {
        note.className = "note err";
        note.innerHTML = esc((data && data.error) || "Falha ao guardar.");
      }
    });
  };

  // As impressoras do Windows primeiro: o formulário precisa delas para
  // mostrar a lista em vez de um campo de texto onde se erra o nome.
  api("GET", "printers", null, function (status, data) {
    if (data && data.printers) windowsPrinters = data.printers;
    refresh(true);
    setInterval(refresh, 2000);
  });
})();
</script>
</body>
</html>`;
}

// Instalado como serviço (NSSM) não há sessão de ambiente de trabalho onde
// abrir seja útil, e nos testes é só uma janela a saltar. A interface
// continua lá — só não se abre sozinha.
function shouldOpenBrowser() {
  if (process.env.QOMANDA_NO_BROWSER) return false;
  return config.openBrowser !== false;
}

function openBrowser(url) {
  if (process.platform !== "win32" || !shouldOpenBrowser()) return;
  // O "" é o título da janela: sem ele, o `start` interpreta a URL entre aspas
  // como título e não abre nada.
  execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true }, () => {});
}

// ── Arranque ────────────────────────────────────────────────────────────
pushLog("info", "Qomanda Print Agent iniciado.");
pushLog("info", `Servidor: ${SERVER_URL}`);
if (REALTIME_ENABLED) pushLog("info", `Tempo real: ${REALTIME_URL}`);

startWebUi();
startRealtime();

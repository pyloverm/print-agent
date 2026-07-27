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

// ── Erros fatais ────────────────────────────────────────────────────────
// Ao abrir o .exe com duplo clique, o Windows fecha a janela da consola
// assim que o processo termina — um erro fatal seria ilegível num piscar de
// olhos. Se a consola for interativa (duplo clique ou terminal), esperamos
// por ENTER antes de sair; em serviços/NSSM (stdin não é TTY) saímos logo.
let hasFatalError = false;
function fatal(...lines) {
  if (hasFatalError) return; // já há um prompt "ENTER para fechar" pendente
  hasFatalError = true;
  for (const line of lines) console.error(`[qomanda-agent] ${line}`);
  if (process.stdin.isTTY) {
    console.error("\nPrima ENTER para fechar...");
    process.stdin.resume();
    process.stdin.once("data", () => process.exit(1));
  } else {
    process.exit(1);
  }
}

// ── Config ──────────────────────────────────────────────────────────────
const configPath = resolve(process.argv[2] || "./config.json");
let config = {};
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (err) {
  fatal(`Impossível ler a configuração em ${configPath}`, "Copie config.example.json para config.json e preencha-o.");
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

const SERVER_URL = normalizeUrl(config.serverUrl, "http");
const TOKEN = config.token || "";
const PRINTERS = config.printers || {};
const REALTIME_URL = normalizeUrl(config.realtimeUrl, "ws");
const REALTIME_KEY = config.realtimeKey || "";
// Rede de segurança, só usada quando o WebSocket está em baixo.
const FALLBACK_POLL_MS = Math.max(15000, config.fallbackPollMs || 60000);
const PRINT_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 10000;

if (!SERVER_URL || !TOKEN) {
  fatal("serverUrl e token são obrigatórios na configuração.");
}
if (Object.keys(PRINTERS).length === 0) {
  fatal("Configure pelo menos uma impressora (ex: kitchen, bar, payment) com host e port.");
}

const REALTIME_ENABLED = Boolean(REALTIME_URL && REALTIME_KEY);

/**
 * Canal de despertar. DEVE ser idêntico ao cálculo de
 * src/lib/print-agent-channel.ts no servidor — se divergir, o agente escuta um
 * canal onde ninguém publica e cai silenciosamente no poll de segurança.
 */
const CHANNEL = `print-agent-${createHash("sha256").update(TOKEN).digest("hex").slice(0, 32)}`;

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
    console.error(`[qomanda-agent] Falha ao reportar o job ${jobId}:`, err.message);
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
        console.warn(
          `[qomanda-agent] Sem impressora "payment" configurada — os recibos vão sair em ${printerLabel(fallback)}.`
        );
        console.warn('[qomanda-agent] Acrescente "payment" a "printers" no config.json para os separar.');
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
    if (jobs.length > 0) {
      console.log(`[qomanda-agent] ${jobs.length} job(s) recebido(s) (${reason}).`);
    }

    for (const job of jobs) {
      const printer = resolvePrinter(job.station);
      if (!printer) {
        console.warn(`[qomanda-agent] Sem impressora configurada para "${job.station}" — job ${job.id} falhado.`);
        await reportJob(job.id, false, `Sem impressora configurada para o posto "${job.station}" no agente.`);
        continue;
      }

      const data = Buffer.from(job.dataBase64, "base64");
      try {
        await printRaw(printer, data);
        console.log(`[qomanda-agent] ✓ Impresso job ${job.id} (${job.station}) em ${printerLabel(printer)}`);
        await reportJob(job.id, true);
      } catch (err) {
        console.error(`[qomanda-agent] ✗ Falha no job ${job.id} (${job.station}):`, err.message);
        await reportJob(job.id, false, err.message);
      }
    }
  } catch (err) {
    console.error(`[qomanda-agent] Erro ao recolher jobs: ${err.message}`);
  } finally {
    draining = false;
    if (drainAgain) {
      drainAgain = false;
      drainJobs("evento durante recolha anterior");
    }
  }
}

// ── Poll de segurança (só enquanto o WebSocket estiver em baixo) ─────────
let fallbackTimer = null;

function startFallbackPolling(why) {
  if (fallbackTimer) return;
  console.warn(`[qomanda-agent] Poll de segurança ATIVO (${why}) — a cada ${FALLBACK_POLL_MS / 1000}s.`);
  fallbackTimer = setInterval(() => drainJobs("poll de segurança"), FALLBACK_POLL_MS);
}

function stopFallbackPolling() {
  if (!fallbackTimer) return;
  clearInterval(fallbackTimer);
  fallbackTimer = null;
  console.log("[qomanda-agent] Poll de segurança DESATIVADO (tempo real ligado).");
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
          // Canal público: nenhuma autorização necessária — o segredo é o
          // próprio nome do canal, derivado do token.
          ws.sendText(JSON.stringify({ event: "pusher:subscribe", data: { channel: CHANNEL } }));
          break;

        case "pusher_internal:subscription_succeeded":
          console.log("[qomanda-agent] Tempo real ligado — à espera de trabalhos.");
          stopFallbackPolling();
          // Apanhar o que possa ter sido enfileirado enquanto estávamos offline.
          drainJobs("ligação estabelecida");
          break;

        case "pusher:ping":
          ws.sendText(JSON.stringify({ event: "pusher:pong", data: {} }));
          break;

        case "pusher:error":
          console.error(`[qomanda-agent] Erro do servidor de tempo real: ${JSON.stringify(msg.data)}`);
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
  // Sem tempo real, a fila só é vista pelo poll: ativá-lo é o que evita
  // perder um ticket de cozinha durante a avaria.
  startFallbackPolling(why);

  if (reconnectTimer) return;
  reconnectAttempts++;
  // Backoff exponencial travado a 60 s.
  const delay = Math.min(2000 * Math.pow(2, Math.min(reconnectAttempts - 1, 5)), 60000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRealtime();
  }, delay);
}

// ── Arranque ────────────────────────────────────────────────────────────
if (!hasFatalError) {
  console.log(`[qomanda-agent] Qomanda Print Agent iniciado.`);
  console.log(`[qomanda-agent] Servidor: ${SERVER_URL}`);
  console.log(
    `[qomanda-agent] Impressoras: ${Object.entries(PRINTERS)
      .map(([st, p]) => `${st} → ${printerLabel(p)}`)
      .join(" · ")}`
  );

  if (REALTIME_ENABLED) {
    console.log(`[qomanda-agent] Tempo real: ${REALTIME_URL}`);
    connectRealtime();
  } else {
    console.warn("[qomanda-agent] ATENÇÃO: realtimeUrl/realtimeKey não configurados.");
    console.warn("[qomanda-agent] O agente vai funcionar apenas por poll, o que mantém a base de dados");
    console.warn("[qomanda-agent] permanentemente acordada. Configure o tempo real assim que possível.");
    startFallbackPolling("tempo real não configurado");
  }

  // Recolha inicial: pode haver trabalho em fila desde a última paragem.
  drainJobs("arranque");
}

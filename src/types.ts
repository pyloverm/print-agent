export type PrinterKind = 'network' | 'usb';

export interface PrinterConfig {
  kind: PrinterKind;
  host: string;
  port: number;
  printerName: string;
}

export interface PrintersConfig {
  kitchen: PrinterConfig | null;
  bar: PrinterConfig | null;
}

export interface AgentConfig {
  serverUrl: string;
  token: string;
  pollMs: number;
  printers: PrintersConfig;
}

export interface LogEntry {
  ts: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface AgentStatus {
  running: boolean;
  lastPollOk: boolean | null;
  lastError: string | null;
  lastPollAt: string | null;
}

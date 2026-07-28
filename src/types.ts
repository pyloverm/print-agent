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
  payment: PrinterConfig | null;
}

export interface AgentConfig {
  serverUrl: string;
  token: string;
  /** Servidor de tempo real (Soketi) e a sua chave pública. Vazios = poll permanente. */
  realtimeUrl: string;
  realtimeKey: string;
  printers: PrintersConfig;
}

export interface LogEntry {
  ts: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface AgentStatus {
  running: boolean;
  realtimeConfigured: boolean;
  realtimeConnected: boolean;
  lastError: string | null;
  /** Último contacto bem-sucedido com o servidor. */
  lastActivityAt: string | null;
}

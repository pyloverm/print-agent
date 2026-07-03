export interface AgentStats {
  totalJobs: number;
  successfulJobs: number;
  failedJobs: number;
  totalErrors: number;
  lastSync: string | null;
  lastPrint: string | null;
  lastError: string | null;
  startedAt: string | null;
  state: string;
  version: string;
}

export interface PrinterConfig {
  name: string;
  host: string;
  port: number;
  station: string;
  enabled: boolean;
}

export interface AppConfig {
  serverUrl: string;
  token: string;
  pollIntervalMs: number;
  printTimeoutMs: number;
  restaurantName: string;
  printers: Record<string, PrinterConfig>;
  autoStart: boolean;
  minimizeToTray: boolean;
  startOnStartup: boolean;
}

export type StationType = 'kitchen' | 'bar' | 'dessert' | 'pizza' | 'grill' | 'other';

export const STATION_TYPES: StationType[] = [
  'kitchen', 'bar', 'dessert', 'pizza', 'grill', 'other'
];

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  source: string;
}

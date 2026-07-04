import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentConfig, AgentStatus, LogEntry, PrinterConfig } from '../types';

export const getConfig = () => invoke<AgentConfig>('get_config');
export const saveConfig = (config: AgentConfig) => invoke<void>('save_config', { config });
export const getStatus = () => invoke<AgentStatus>('get_status');
export const getLogs = () => invoke<LogEntry[]>('get_logs');
export const startAgent = () => invoke<void>('start_agent');
export const stopAgent = () => invoke<void>('stop_agent');
export const testPrinter = (printer: PrinterConfig) => invoke<void>('test_printer', { printer });
export const getPrinters = () => invoke<string[]>('get_printers');
export const getAutostart = () => invoke<boolean>('get_autostart');
export const setAutostart = (enabled: boolean) => invoke<void>('set_autostart', { enabled });

export const onAgentLog = (cb: (entry: LogEntry) => void): Promise<UnlistenFn> =>
  listen<LogEntry>('agent-log', (event) => cb(event.payload));

export const onAgentStatus = (cb: (status: AgentStatus) => void): Promise<UnlistenFn> =>
  listen<AgentStatus>('agent-status', (event) => cb(event.payload));

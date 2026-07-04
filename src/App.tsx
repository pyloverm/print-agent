import { useEffect, useState } from 'react';
import ConfigForm from './components/ConfigForm';
import StatusBar from './components/StatusBar';
import LogPanel from './components/LogPanel';
import {
  getAutostart,
  getConfig,
  getLogs,
  getStatus,
  onAgentLog,
  onAgentStatus,
  saveConfig,
  setAutostart,
  startAgent,
  stopAgent,
  testPrinter,
} from './lib/tauri';
import type { AgentConfig, AgentStatus, LogEntry } from './types';

const EMPTY_STATUS: AgentStatus = {
  running: false,
  lastPollOk: null,
  lastError: null,
  lastPollAt: null,
};

function App() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [status, setStatus] = useState<AgentStatus>(EMPTY_STATUS);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autostart, setAutostartState] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    getConfig().then(setConfig);
    getStatus().then(setStatus);
    getLogs().then(setLogs);
    getAutostart().then(setAutostartState);

    const unlistenLog = onAgentLog((entry) => setLogs((prev) => [...prev.slice(-199), entry]));
    const unlistenStatus = onAgentStatus(setStatus);

    return () => {
      unlistenLog.then((fn) => fn());
      unlistenStatus.then((fn) => fn());
    };
  }, []);

  async function handleSave(next: AgentConfig) {
    await saveConfig(next);
    setConfig(next);
  }

  async function handleToggleAgent() {
    setToggling(true);
    try {
      if (status.running) {
        await stopAgent();
      } else {
        await startAgent();
      }
    } finally {
      setToggling(false);
    }
  }

  async function handleAutostartChange(checked: boolean) {
    setAutostartState(checked);
    try {
      await setAutostart(checked);
    } catch {
      setAutostartState(!checked);
    }
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>Qomanda Print Agent</h1>
        <p>Impressão automática de tickets nas impressoras do restaurante.</p>
      </header>

      <StatusBar status={status} onToggle={handleToggleAgent} busy={toggling} />

      <label className="autostart-toggle">
        <input type="checkbox" checked={autostart} onChange={(e) => handleAutostartChange(e.target.checked)} />
        Iniciar automaticamente com o Windows
      </label>

      <div className="app__grid">
        {config && <ConfigForm config={config} onSave={handleSave} onTestPrinter={testPrinter} />}
        <LogPanel logs={logs} />
      </div>
    </div>
  );
}

export default App;

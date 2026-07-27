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
  realtimeConfigured: false,
  realtimeConnected: false,
  fallbackPolling: false,
  lastError: null,
  lastActivityAt: null,
};

function App() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [status, setStatus] = useState<AgentStatus>(EMPTY_STATUS);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autostart, setAutostartState] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getConfig().then(setConfig), getStatus().then(setStatus), getLogs().then(setLogs), getAutostart().then(setAutostartState)]).finally(
      () => setLoading(false)
    );

    const unlistenLog = onAgentLog((entry) => setLogs((prev) => [...prev.slice(-199), entry]));
    const unlistenStatus = onAgentStatus((next) => {
      setStatus(next);
      setActionError(null);
    });

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
    setActionError(null);
    try {
      if (status.running) {
        await stopAgent();
      } else {
        await startAgent();
      }
    } catch (err) {
      setActionError(String(err));
    } finally {
      setToggling(false);
    }
  }

  async function handleAutostartChange(checked: boolean) {
    setAutostartState(checked);
    setActionError(null);
    try {
      await setAutostart(checked);
    } catch (err) {
      setAutostartState(!checked);
      setActionError(String(err));
    }
  }

  if (loading) {
    return (
      <div className="app app--loading">
        <div className="app-loader">
          <span className="app-loader__spinner" />
          A carregar...
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__header-icon" aria-hidden="true">
          🖨️
        </div>
        <div>
          <h1>Qomanda Print Agent</h1>
          <p>Impressão automática de tickets nas impressoras do restaurante.</p>
        </div>
      </header>

      <StatusBar status={status} onToggle={handleToggleAgent} busy={toggling} />

      {actionError && (
        <div className="banner banner--error" role="alert">
          <span>{actionError}</span>
          <button className="banner__dismiss" onClick={() => setActionError(null)} aria-label="Dispensar">
            ×
          </button>
        </div>
      )}

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

import type { LogEntry } from '../types';

interface Props {
  logs: LogEntry[];
}

const LEVEL_ICON: Record<LogEntry['level'], string> = {
  info: 'ℹ',
  success: '✓',
  warn: '!',
  error: '✕',
};

export default function LogPanel({ logs }: Props) {
  const ordered = [...logs].reverse();

  return (
    <div className="log-panel">
      <div className="log-panel__header">
        <h2>Atividade</h2>
        {logs.length > 0 && <span className="log-panel__count">{logs.length}</span>}
      </div>
      <div className="log-panel__list">
        {ordered.length === 0 && <div className="log-panel__empty">Sem atividade ainda.</div>}
        {ordered.map((entry, i) => (
          <div key={i} className={`log-entry log-entry--${entry.level}`}>
            <span className={`log-entry__icon log-entry__icon--${entry.level}`}>{LEVEL_ICON[entry.level]}</span>
            <span className="log-entry__time">{new Date(entry.ts).toLocaleTimeString()}</span>
            <span className="log-entry__message">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

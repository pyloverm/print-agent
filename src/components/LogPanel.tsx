import type { LogEntry } from '../types';

interface Props {
  logs: LogEntry[];
}

export default function LogPanel({ logs }: Props) {
  const ordered = [...logs].reverse();

  return (
    <div className="log-panel">
      <h2>Atividade</h2>
      <div className="log-panel__list">
        {ordered.length === 0 && <div className="log-panel__empty">Sem atividade ainda.</div>}
        {ordered.map((entry, i) => (
          <div key={i} className={`log-entry log-entry--${entry.level}`}>
            <span className="log-entry__time">{new Date(entry.ts).toLocaleTimeString()}</span>
            <span className="log-entry__message">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

import type { AgentStatus } from '../types';

interface Props {
  status: AgentStatus;
  onToggle: () => void;
  busy: boolean;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleTimeString();
}

export default function StatusBar({ status, onToggle, busy }: Props) {
  const dotClass = !status.running
    ? 'status-dot status-dot--off'
    : status.lastPollOk === false
    ? 'status-dot status-dot--error'
    : 'status-dot status-dot--ok';

  return (
    <div className="status-bar">
      <div className="status-bar__info">
        <span className={dotClass} />
        <div>
          <div className="status-bar__label">
            {status.running ? 'Agente em execução' : 'Agente parado'}
          </div>
          <div className="status-bar__meta">Última verificação: {formatTime(status.lastPollAt)}</div>
        </div>
      </div>
      <button className="btn" onClick={onToggle} disabled={busy}>
        {status.running ? 'Parar' : 'Iniciar'}
      </button>
      {status.lastError && <div className="status-bar__error">{status.lastError}</div>}
    </div>
  );
}

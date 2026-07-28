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

/**
 * Sem poll de segurança, o tempo real é o único caminho até à fila: se a
 * ligação estiver em baixo, nenhum talão sai. Isso é uma avaria a vermelho, não
 * um aviso — se aparecesse como um estado intermédio tolerável, ninguém a
 * corrigiria e os pedidos ficariam por imprimir sem que a casa desse por isso.
 */
function describe(status: AgentStatus): { tone: 'off' | 'ok' | 'error'; label: string; meta: string } {
  if (!status.running) {
    return { tone: 'off', label: 'Agente parado', meta: 'Nenhum talão será impresso.' };
  }
  if (status.realtimeConnected) {
    return {
      tone: 'ok',
      label: 'Tempo real ligado',
      meta: 'À espera de trabalhos — sem consultas ao servidor.',
    };
  }
  if (!status.realtimeConfigured) {
    return {
      tone: 'error',
      label: 'Tempo real por configurar',
      meta: 'Sem ele não chega nenhum talão. Preencha-o na configuração.',
    };
  }
  return {
    tone: 'error',
    label: 'Sem ligação ao tempo real',
    meta: 'Nenhum talão sai enquanto isto durar — a reconectar.',
  };
}

export default function StatusBar({ status, onToggle, busy }: Props) {
  const { tone, label, meta } = describe(status);
  const dotClass = `status-dot status-dot--${tone}${tone === 'ok' ? ' status-dot--pulse' : ''}`;

  return (
    <div className="status-bar">
      <div className="status-bar__info">
        <span className={dotClass} />
        <div>
          <div className="status-bar__label" aria-live="polite">
            {label}
          </div>
          <div className="status-bar__meta">
            {meta} · Última atividade: {formatTime(status.lastActivityAt)}
          </div>
        </div>
      </div>
      <button className={`btn ${status.running ? 'btn--stop' : 'btn--primary'}`} onClick={onToggle} disabled={busy}>
        {busy ? 'A processar...' : status.running ? 'Parar' : 'Iniciar'}
      </button>
      {status.lastError && <div className="status-bar__error">{status.lastError}</div>}
    </div>
  );
}

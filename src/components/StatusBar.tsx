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
 * Três estados visíveis, não dois. "A funcionar" com o poll de segurança ligado
 * é uma avaria — os talões saem, mas com atraso e a manter a base de dados
 * acordada. Se aparecesse como um verde igual ao normal, ninguém a corrigiria.
 */
function describe(status: AgentStatus): { tone: 'off' | 'ok' | 'warn' | 'error'; label: string; meta: string } {
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
      tone: 'warn',
      label: 'Modo degradado — tempo real por configurar',
      meta: 'A consultar o servidor em ciclo. Preencha o tempo real na configuração.',
    };
  }
  return {
    tone: status.fallbackPolling ? 'warn' : 'error',
    label: 'Poll de segurança ativo',
    meta: 'Sem ligação ao servidor de tempo real — a reconectar.',
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

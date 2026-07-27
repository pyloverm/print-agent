import { useEffect, useState } from 'react';
import { getPrinters } from '../lib/tauri';
import type { AgentConfig, PrinterConfig, PrinterKind } from '../types';

interface Props {
  config: AgentConfig;
  onSave: (config: AgentConfig) => Promise<void>;
  onTestPrinter: (printer: PrinterConfig) => Promise<void>;
}

interface StationState {
  enabled: boolean;
  kind: PrinterKind;
  host: string;
  port: string;
  printerName: string;
}

function toStationState(printer: PrinterConfig | null): StationState {
  return {
    enabled: printer !== null,
    kind: printer?.kind ?? 'network',
    host: printer?.host ?? '',
    port: String(printer?.port ?? 9100),
    printerName: printer?.printerName ?? '',
  };
}

type TestState = { status: 'idle' } | { status: 'testing' } | { status: 'ok' } | { status: 'error'; message: string };

const STATION_ICON: Record<'kitchen' | 'bar' | 'payment', string> = {
  kitchen: '🍳',
  bar: '🍹',
  payment: '🧾',
};

export default function ConfigForm({ config, onSave, onTestPrinter }: Props) {
  const [serverUrl, setServerUrl] = useState(config.serverUrl);
  const [token, setToken] = useState(config.token);
  const [showToken, setShowToken] = useState(false);
  const [realtimeUrl, setRealtimeUrl] = useState(config.realtimeUrl);
  const [realtimeKey, setRealtimeKey] = useState(config.realtimeKey);
  const [fallbackPollMs, setFallbackPollMs] = useState(String(config.fallbackPollMs));
  const [kitchen, setKitchen] = useState<StationState>(toStationState(config.printers.kitchen));
  const [bar, setBar] = useState<StationState>(toStationState(config.printers.bar));
  const [payment, setPayment] = useState<StationState>(toStationState(config.printers.payment));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [windowsPrinters, setWindowsPrinters] = useState<string[]>([]);
  const [testState, setTestState] = useState<{ kitchen: TestState; bar: TestState; payment: TestState }>({
    kitchen: { status: 'idle' },
    bar: { status: 'idle' },
    payment: { status: 'idle' },
  });

  useEffect(() => {
    getPrinters()
      .then(setWindowsPrinters)
      .catch(() => setWindowsPrinters([]));
  }, []);

  function stationToPrinter(station: StationState): PrinterConfig | null {
    if (!station.enabled) return null;
    const port = parseInt(station.port, 10);
    return {
      kind: station.kind,
      host: station.host.trim(),
      port: Number.isFinite(port) ? port : 9100,
      printerName: station.printerName.trim(),
    };
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await onSave({
        serverUrl: serverUrl.trim(),
        token: token.trim(),
        realtimeUrl: realtimeUrl.trim(),
        realtimeKey: realtimeKey.trim(),
        fallbackPollMs: parseInt(fallbackPollMs, 10) || 60000,
        printers: {
          kitchen: stationToPrinter(kitchen),
          bar: stationToPrinter(bar),
          payment: stationToPrinter(payment),
        },
      });
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(name: 'kitchen' | 'bar' | 'payment', station: StationState) {
    const printer = stationToPrinter(station);
    if (!printer) return;
    if (printer.kind === 'network' && !printer.host) return;
    if (printer.kind === 'usb' && !printer.printerName) return;
    setTestState((s) => ({ ...s, [name]: { status: 'testing' } }));
    try {
      await onTestPrinter(printer);
      setTestState((s) => ({ ...s, [name]: { status: 'ok' } }));
    } catch (err) {
      setTestState((s) => ({ ...s, [name]: { status: 'error', message: String(err) } }));
    }
  }

  function renderStation(name: 'kitchen' | 'bar' | 'payment', label: string, station: StationState, setStation: (s: StationState) => void) {
    const test = testState[name];
    const canTest = station.kind === 'network' ? !!station.host : !!station.printerName;
    return (
      <div className={`printer-row ${station.enabled ? 'printer-row--enabled' : ''}`}>
        <label className="printer-row__toggle">
          <input
            type="checkbox"
            checked={station.enabled}
            onChange={(e) => setStation({ ...station, enabled: e.target.checked })}
          />
          <span className={`printer-row__icon printer-row__icon--${name}`}>{STATION_ICON[name]}</span>
          {label}
        </label>
        {station.enabled && (
          <div className="printer-row__body">
            <div className="printer-row__kind">
              <label>
                <input
                  type="radio"
                  name={`${name}-kind`}
                  checked={station.kind === 'network'}
                  onChange={() => setStation({ ...station, kind: 'network' })}
                />
                Rede (IP)
              </label>
              <label>
                <input
                  type="radio"
                  name={`${name}-kind`}
                  checked={station.kind === 'usb'}
                  onChange={() => setStation({ ...station, kind: 'usb' })}
                />
                USB / Local
              </label>
            </div>

            <div className="printer-row__fields">
              {station.kind === 'network' ? (
                <>
                  <input
                    type="text"
                    placeholder="IP da impressora (ex: 192.168.1.50)"
                    value={station.host}
                    onChange={(e) => setStation({ ...station, host: e.target.value })}
                  />
                  <input
                    type="number"
                    placeholder="Porta"
                    value={station.port}
                    onChange={(e) => setStation({ ...station, port: e.target.value })}
                  />
                </>
              ) : windowsPrinters.length > 0 ? (
                <select
                  value={station.printerName}
                  onChange={(e) => setStation({ ...station, printerName: e.target.value })}
                >
                  <option value="">Selecione uma impressora...</option>
                  {windowsPrinters.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder="Nome da impressora no Windows"
                  value={station.printerName}
                  onChange={(e) => setStation({ ...station, printerName: e.target.value })}
                />
              )}
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => handleTest(name, station)}
                disabled={test.status === 'testing' || !canTest}
              >
                {test.status === 'testing' ? 'A testar...' : 'Testar'}
              </button>
              {test.status === 'ok' && <span className="printer-row__result printer-row__result--ok">Impressão enviada</span>}
              {test.status === 'error' && <span className="printer-row__result printer-row__result--error">{test.message}</span>}
            </div>
            {station.kind === 'usb' && windowsPrinters.length === 0 && (
              <div className="printer-row__hint">
                Nenhuma impressora encontrada no Windows — verifique se está instalada e ligada.
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <form className="config-form" onSubmit={handleSave}>
      <h2>Configuração</h2>

      <label className="field">
        <span>Endereço do servidor Qomanda</span>
        <input
          type="text"
          placeholder="https://o-seu-dominio-qomanda.com"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          required
        />
      </label>

      <label className="field">
        <span>Token do agente</span>
        <div className="field__with-action">
          <input
            type={showToken ? 'text' : 'password'}
            placeholder="qpa_..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
          <button type="button" className="btn btn--secondary" onClick={() => setShowToken((v) => !v)}>
            {showToken ? 'Ocultar' : 'Mostrar'}
          </button>
        </div>
      </label>

      <div className="field">
        <span>Tempo real</span>
        <p className="field__hint">
          O agente fica à espera que o servidor o avise, em vez de perguntar de tempos a tempos. Sem
          estes dois campos imprime na mesma, mas em modo degradado — ver o README.
        </p>
        <input
          type="text"
          placeholder="wss://realtime.o-seu-dominio-qomanda.com"
          value={realtimeUrl}
          onChange={(e) => setRealtimeUrl(e.target.value)}
        />
        <input
          type="text"
          placeholder="Chave pública do servidor de tempo real"
          value={realtimeKey}
          onChange={(e) => setRealtimeKey(e.target.value)}
        />
        {!(realtimeUrl.trim() && realtimeKey.trim()) && (
          <div className="form-warning">
            Por preencher: o agente vai consultar o servidor de {Math.round((parseInt(fallbackPollMs, 10) || 60000) / 1000)} em{' '}
            {Math.round((parseInt(fallbackPollMs, 10) || 60000) / 1000)} segundos, permanentemente.
          </div>
        )}
      </div>

      <label className="field field--narrow">
        <span>Poll de segurança (ms)</span>
        <input
          type="number"
          min={15000}
          step={1000}
          value={fallbackPollMs}
          onChange={(e) => setFallbackPollMs(e.target.value)}
        />
        <span className="field__hint">Só usado enquanto o tempo real estiver em baixo. Mínimo 15 s.</span>
      </label>

      <div className="field">
        <span>Impressoras</span>
        {renderStation('kitchen', 'Cozinha', kitchen, setKitchen)}
        {renderStation('bar', 'Bar', bar, setBar)}
        {renderStation('payment', 'Pagamento', payment, setPayment)}
      </div>

      {error && <div className="form-error">{error}</div>}
      {saved && !error && <div className="form-success">Configuração guardada.</div>}

      <button className="btn btn--primary" type="submit" disabled={saving}>
        {saving ? 'A guardar...' : 'Guardar'}
      </button>
    </form>
  );
}

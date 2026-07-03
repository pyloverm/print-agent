import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api';

export function useAgent() {
  const [state, setState] = useState<string>('stopped');
  const [stats, setStats] = useState<any>(null);

  const startAgent = useCallback(async () => {
    try {
      await invoke('start_agent');
      setState('running');
      return true;
    } catch (err) {
      console.error('Failed to start agent:', err);
      return false;
    }
  }, []);

  const stopAgent = useCallback(async () => {
    try {
      await invoke('stop_agent');
      setState('stopped');
      return true;
    } catch (err) {
      console.error('Failed to stop agent:', err);
      return false;
    }
  }, []);

  const restartAgent = useCallback(async () => {
    try {
      await invoke('restart_agent');
      return true;
    } catch (err) {
      console.error('Failed to restart agent:', err);
      return false;
    }
  }, []);

  return {
    state,
    stats,
    startAgent,
    stopAgent,
    restartAgent,
  };
}

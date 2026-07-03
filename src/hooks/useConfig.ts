import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api';

export function useConfig() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);

  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      const loadedConfig = await invoke('get_config');
      setConfig(loadedConfig);
    } catch (err) {
      console.error('Failed to load config:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const saveConfig = useCallback(async (newConfig: any) => {
    try {
      await invoke('save_config', { config: newConfig });
      setConfig(newConfig);
      return true;
    } catch (err) {
      console.error('Failed to save config:', err);
      return false;
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  return {
    config,
    loading,
    loadConfig,
    saveConfig,
  };
}

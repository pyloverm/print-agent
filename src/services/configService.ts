import { invoke } from '@tauri-apps/api';

class ConfigService {
  private static instance: ConfigService;

  private constructor() {}

  public static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  async getConfig() {
    try {
      return await invoke('get_config');
    } catch (error) {
      console.error('Failed to get config:', error);
      throw new Error('Failed to load configuration');
    }
  }

  async saveConfig(config: any) {
    try {
      await invoke('save_config', { config });
    } catch (error) {
      console.error('Failed to save config:', error);
      throw new Error('Failed to save configuration');
    }
  }
}

export default ConfigService.getInstance();

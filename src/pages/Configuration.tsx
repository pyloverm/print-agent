import React from 'react';
import { useConfig } from '@/hooks';

export const Configuration: React.FC = () => {
  const { config, loading, saveConfig } = useConfig();

  if (loading) return <div>Loading...</div>;
  if (!config) return <div>No configuration found</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Configuration</h1>
      <div className="space-y-4">
        <div>
          <label className="block mb-2">Server URL</label>
          <input
            type="text"
            value={config.serverUrl || ''}
            onChange={(e) => saveConfig({...config, serverUrl: e.target.value})}
            className="w-full p-2 border rounded"
          />
        </div>
        <div>
          <label className="block mb-2">Token</label>
          <input
            type="password"
            value={config.token || ''}
            onChange={(e) => saveConfig({...config, token: e.target.value})}
            className="w-full p-2 border rounded"
          />
        </div>
      </div>
    </div>
  );
};

export default Configuration;

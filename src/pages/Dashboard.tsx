import React from 'react';
import { useAgent } from '@/hooks';

export const Dashboard: React.FC = () => {
  const { state, startAgent, stopAgent, restartAgent } = useAgent();

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Qomanda Print Agent</h1>
      <p className="mb-6">Agent Status: {state}</p>
      <div className="flex gap-4">
        <button onClick={startAgent} className="bg-blue-500 text-white px-4 py-2 rounded">
          Start Agent
        </button>
        <button onClick={stopAgent} className="bg-red-500 text-white px-4 py-2 rounded">
          Stop Agent
        </button>
        <button onClick={restartAgent} className="bg-green-500 text-white px-4 py-2 rounded">
          Restart Agent
        </button>
      </div>
    </div>
  );
};

export default Dashboard;

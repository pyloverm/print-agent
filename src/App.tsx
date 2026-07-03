import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';

function App() {
  return (
    <Router>
      <div className="min-h-screen bg-gray-50">
        <h1>Qomanda Print Agent</h1>
        <p>Desktop application for restaurant printing</p>
      </div>
    </Router>
  );
}

export default App;

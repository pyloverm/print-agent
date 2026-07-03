import React from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import { Dashboard, Configuration, Printers, Logs, About } from '@/pages';

function App() {
  return (
    <Router>
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-white shadow-sm">
          <div className="max-w-6xl mx-auto px-4">
            <div className="flex justify-between h-16">
              <div className="flex space-x-8">
                <NavLink
                  to="/"
                  className={({ isActive }) => 
                    `py-4 px-2 ${isActive ? 'border-b-2 border-blue-500' : 'text-gray-500'}`
                  }
                >
                  Dashboard
                </NavLink>
                <NavLink
                  to="/configuration"
                  className={({ isActive }) => 
                    `py-4 px-2 ${isActive ? 'border-b-2 border-blue-500' : 'text-gray-500'}`
                  }
                >
                  Configuration
                </NavLink>
                <NavLink
                  to="/printers"
                  className={({ isActive }) => 
                    `py-4 px-2 ${isActive ? 'border-b-2 border-blue-500' : 'text-gray-500'}`
                  }
                >
                  Printers
                </NavLink>
                <NavLink
                  to="/logs"
                  className={({ isActive }) => 
                    `py-4 px-2 ${isActive ? 'border-b-2 border-blue-500' : 'text-gray-500'}`
                  }
                >
                  Logs
                </NavLink>
                <NavLink
                  to="/about"
                  className={({ isActive }) => 
                    `py-4 px-2 ${isActive ? 'border-b-2 border-blue-500' : 'text-gray-500'}`
                  }
                >
                  About
                </NavLink>
              </div>
            </div>
          </div>
        </nav>
        
        <main className="max-w-6xl mx-auto px-4 py-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/configuration" element={<Configuration />} />
            <Route path="/printers" element={<Printers />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/about" element={<About />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;

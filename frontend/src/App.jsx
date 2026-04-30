import { Outlet } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import './App.css';

export function App() {
  return (
    <div className="app">
      <Navbar />
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}

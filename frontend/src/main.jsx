import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { WalletProvider } from './context/WalletContext'
import { App } from './App'
import { Dashboard } from './pages/Dashboard'
import AMMPage from './pages/AMMPage'
import { OrderBookPage } from './pages/OrderBookPage'
import { Portfolio } from './pages/Portfolio'
import { UserDashboard } from './pages/UserDashboard'
import { AdminPanel } from './pages/AdminPanel'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<App />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/amm" element={<AMMPage />} />
            <Route path="/orderbook" element={<OrderBookPage />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/kyc" element={<UserDashboard />} />
            <Route path="/admin" element={<AdminPanel />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  </React.StrictMode>,
)

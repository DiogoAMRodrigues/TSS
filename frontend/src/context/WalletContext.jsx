/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect } from 'react';
import { BrowserProvider } from 'ethers';

const WalletContext = createContext();

export function WalletProvider({ children }) {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState(null);

  // Check if MetaMask is available
  const hasMetaMask = () => typeof window !== 'undefined' && window.ethereum;

  // Connect wallet
  const connectWallet = async () => {
    if (!hasMetaMask()) {
      setError('MetaMask not installed');
      return;
    }

    try {
      setIsConnecting(true);
      setError(null);

      // Request account access with timeout
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('MetaMask not responding. Please unlock your wallet and try again.')), 30000)
      );
      const accounts = await Promise.race([
        window.ethereum.request({
          method: 'eth_requestAccounts'
        }),
        timeout
      ]);

      const ethersProvider = new BrowserProvider(window.ethereum);
      const ethersSigner = await ethersProvider.getSigner();
      const userAddress = accounts[0];
      const network = await ethersProvider.getNetwork();

      setProvider(ethersProvider);
      setSigner(ethersSigner);
      setAddress(userAddress);
      setChainId(Number(network.chainId));
    } catch (err) {
      setError(err.message || 'Failed to connect wallet');
      console.error('Wallet connection error:', err);
    } finally {
      setIsConnecting(false);
    }
  };

  // Disconnect wallet
  const disconnectWallet = () => {
    setProvider(null);
    setSigner(null);
    setAddress(null);
    setChainId(null);
    setError(null);
  };

  // Listen for account changes
  useEffect(() => {
    if (!hasMetaMask()) return;

    const handleAccountsChanged = (accounts) => {
      if (accounts.length === 0) {
        disconnectWallet();
      } else if (accounts[0] !== address) {
        setAddress(accounts[0]);
      }
    };

    const handleChainChanged = (chainIdHex) => {
      setChainId(Number(chainIdHex));
    };

    window.ethereum.on('accountsChanged', handleAccountsChanged);
    window.ethereum.on('chainChanged', handleChainChanged);

    return () => {
      window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
      window.ethereum.removeListener('chainChanged', handleChainChanged);
    };
  }, [address]);

  const value = {
    provider,
    signer,
    address,
    chainId,
    isConnecting,
    error,
    connectWallet,
    disconnectWallet,
    isConnected: !!address,
    hasMetaMask: hasMetaMask()
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within WalletProvider');
  }
  return context;
}

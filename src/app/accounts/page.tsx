"use client";
import React, { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase/client';
import InternalLayout from '@/components/InternalLayout';

type Account = { id: string; name: string; market: string; createdAt: string };

export default function AccountsPage() {
  const [rows, setRows] = useState<Account[]>([]);
  const [name, setName] = useState('');
  const [market, setMarket] = useState('SPOT');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncDays, setSyncDays] = useState(7);
  const [syncSymbols, setSyncSymbols] = useState(['BTCBRL', 'ETHBRL', 'BNBBRL']);

  const refresh = async () => {
    const user = auth.currentUser;
    if (!user) return;
    
    const token = await user.getIdToken();
    fetch('/api/accounts', {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((r) => r.json())
      .then((d) => setRows(d.results || []));
  };

  useEffect(() => {
    refresh();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('User not authenticated');
      
      const token = await user.getIdToken();
      await fetch('/api/accounts', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name, market, apiKey, apiSecret }),
      });
      setName(''); setApiKey(''); setApiSecret(''); setMarket('SPOT');
      refresh();
    } finally {
      setLoading(false);
    }
  };

  const syncAll = async () => {
    setSyncing(true);
    setSyncMessage('Sincronizando trades...');
    setShowSyncModal(false);
    
    try {
      const user = auth.currentUser;
      if (!user) {
        setSyncMessage('Erro: usuário não autenticado');
        return;
      }
      
      const token = await user.getIdToken();
      const response = await fetch('/api/jobs/sync-all', { 
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ days: syncDays, symbols: syncSymbols })
      });
      const result = await response.json();
      console.log('Sync result:', result);
      
      if (result.error) {
        setSyncMessage(`Erro: ${result.error}`);
      } else if (result.results && result.results.length > 0) {
        const total = result.results.reduce((acc: number, r: { inserted: number }) => acc + r.inserted, 0);
        setSyncMessage(`Sucesso! ${total} trades sincronizados`);
      } else {
        setSyncMessage('Nenhum trade encontrado para sincronizar');
      }
      
      refresh(); // Atualizar lista de contas
    } catch (error) {
      setSyncMessage(`Erro ao sincronizar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
      console.error('Sync error:', error);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMessage(''), 3000);
    }
  };

  const deleteAccount = async (accountId: string) => {
    if (!confirm('Tem certeza que deseja excluir esta conta?')) return;
    
    try {
      const user = auth.currentUser;
      if (!user) return;
      
      const token = await user.getIdToken();
      await fetch(`/api/accounts/${accountId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      refresh();
    } catch (error) {
      console.error('Delete error:', error);
      alert('Erro ao excluir conta');
    }
  };

  const syncAccount = async (accountId: string) => {
    try {
      const user = auth.currentUser;
      if (!user) return;
      
      const token = await user.getIdToken();
      const response = await fetch('/api/jobs/sync-all', { 
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      const result = await response.json();
      
      if (result.results && result.results.length > 0) {
        const accountResult = result.results.find((r: { accountId: string; inserted: number }) => r.accountId === accountId);
        if (accountResult) {
          alert(`${accountResult.inserted} trades sincronizados para esta conta`);
        } else {
          alert('Nenhum trade encontrado para sincronizar');
        }
      } else {
        alert('Nenhum trade encontrado para sincronizar');
      }
      
      refresh();
    } catch (error) {
      console.error('Sync error:', error);
      alert('Erro ao sincronizar');
    }
  };

  return (
    <InternalLayout>
      <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl text-white mb-1 sm:mb-2">Accounts</h1>
          <p className="text-sm sm:text-base text-slate-400">Gerencie suas contas da Binance</p>
        </div>
      </div>
      {/* Adicionar Nova Conta */}
      <div className="relative overflow-hidden border-white/10 bg-gradient-to-br from-white/5 to-white/[0.02] backdrop-blur-sm rounded-xl">
        <div className="p-6">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shadow-lg">
              <span className="text-white text-xl">+</span>
            </div>
            <div>
              <h2 className="text-xl text-white font-semibold">Adicionar Nova Conta</h2>
              <p className="text-slate-400 text-sm">Configure uma nova conta da Binance</p>
            </div>
          </div>

          <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
            <div>
              <label className="flex items-center gap-2 text-slate-300 text-sm mb-2">
                <span>👤</span>
                Nome
              </label>
              <input 
                className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400" 
                value={name} 
                onChange={(e) => setName(e.target.value)} 
                placeholder="Ex: Conta Principal"
                required 
              />
            </div>
            <div>
              <label className="flex items-center gap-2 text-slate-300 text-sm mb-2">
                <span>📊</span>
                Market
              </label>
              <select 
                className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                value={market} 
                onChange={(e) => setMarket(e.target.value)}
              >
                <option value="SPOT">SPOT</option>
                <option value="FUTURES">FUTURES</option>
                <option value="BOTH">BOTH</option>
              </select>
            </div>
            <div>
              <label className="flex items-center gap-2 text-slate-300 text-sm mb-2">
                <span>🔑</span>
                API Key
              </label>
              <input 
                className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400" 
                value={apiKey} 
                onChange={(e) => setApiKey(e.target.value)} 
                placeholder="Sua API Key da Binance"
                required 
              />
            </div>
            <div>
              <label className="flex items-center gap-2 text-slate-300 text-sm mb-2">
                <span>🔒</span>
                API Secret
              </label>
              <input 
                className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-400" 
                value={apiSecret} 
                onChange={(e) => setApiSecret(e.target.value)} 
                placeholder="Sua API Secret da Binance"
                required 
              />
            </div>
            <div className="md:col-span-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mt-4">
              <button 
                className="bg-gradient-to-r from-blue-500 to-cyan-500 text-white px-4 sm:px-6 py-2 rounded-lg font-medium hover:from-blue-600 hover:to-cyan-600 transition-all duration-200 flex items-center justify-center gap-2 text-sm sm:text-base" 
                disabled={loading} 
                type="submit"
              >
                <span>✓</span>
                Salvar
              </button>
              <button 
                className={`${syncing ? 'bg-blue-500/20 border-blue-500/30' : 'bg-white/10 hover:bg-white/20'} text-white px-4 sm:px-6 py-2 rounded-lg font-medium transition-all duration-200 flex items-center justify-center gap-2 text-sm sm:text-base ${syncing ? 'cursor-wait' : 'cursor-pointer'}`}
                disabled={loading || syncing} 
                type="button" 
                onClick={() => setShowSyncModal(true)}
              >
                <span className={syncing ? 'animate-spin' : ''}>🔄</span>
                <span className="hidden sm:inline">{syncing ? 'Sincronizando...' : 'Sincronizar agora'}</span>
                <span className="sm:hidden">{syncing ? 'Sincronizando...' : 'Sincronizar'}</span>
              </button>
              {syncMessage && (
                <div className={`px-3 py-2 rounded text-sm ${syncMessage.includes('Erro') ? 'bg-red-500/20 text-red-400' : syncMessage.includes('Sucesso') ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'}`}>
                  {syncMessage}
                </div>
              )}
            </div>
          </form>
        </div>
      </div>

      {/* Contas Cadastradas */}
      <div className="relative overflow-hidden border-white/10 bg-gradient-to-br from-white/5 to-white/[0.02] backdrop-blur-sm rounded-xl">
        <div className="p-6">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-lg">
              <span className="text-white text-xl">👥</span>
            </div>
            <div>
              <h2 className="text-xl text-white font-semibold">Contas Cadastradas</h2>
              <p className="text-slate-400 text-sm">{rows.length} conta(s) ativa(s)</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead>
                <tr className="bg-gradient-to-r from-white/10 to-white/5">
                  <th className="text-left text-white border-b border-white/10 p-2 sm:p-4 font-medium text-xs sm:text-base">
                    <div className="flex items-center gap-1 sm:gap-2">
                      <span>👤</span>
                      <span className="hidden sm:inline">Nome</span>
                    </div>
                  </th>
                  <th className="text-left text-white border-b border-white/10 p-2 sm:p-4 font-medium text-xs sm:text-base">
                    <div className="flex items-center gap-1 sm:gap-2">
                      <span>📊</span>
                      <span className="hidden sm:inline">Market</span>
                    </div>
                  </th>
                  <th className="text-left text-white border-b border-white/10 p-2 sm:p-4 font-medium text-xs sm:text-base hidden sm:table-cell">
                    <div className="flex items-center gap-1 sm:gap-2">
                      <span>📅</span>
                      Criado em
                    </div>
                  </th>
                  <th className="text-left text-white border-b border-white/10 p-2 sm:p-4 font-medium text-xs sm:text-base">
                    Ações
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {rows.map((r, index) => (
                  <tr key={r.id} className={`hover:bg-white/5 transition-colors ${index % 2 === 0 ? 'bg-white/5' : 'bg-white/10'}`}>
                    <td className="p-2 sm:p-4 text-white text-xs sm:text-base">
                      <div className="flex items-center gap-1 sm:gap-2">
                        <span>👤</span>
                        {r.name}
                      </div>
                    </td>
                    <td className="p-2 sm:p-4">
                      <span className={`px-2 sm:px-3 py-1 rounded-full text-xs font-medium ${
                        r.market === 'SPOT' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' :
                        r.market === 'FUTURES' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30' :
                        'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                      }`}>
                        {r.market}
                      </span>
                    </td>
                    <td className="p-2 sm:p-4 text-white text-xs sm:text-base hidden sm:table-cell">
                      <div className="flex items-center gap-1 sm:gap-2">
                        <span>📅</span>
                        {new Date(r.createdAt).toLocaleString('pt-BR')}
                      </div>
                    </td>
                    <td className="p-2 sm:p-4">
                      <div className="flex items-center gap-1 sm:gap-2">
                        <button 
                          className="p-1.5 sm:p-2 hover:bg-white/10 rounded-lg transition-colors" 
                          title="Sincronizar"
                          onClick={() => syncAccount(r.id)}
                        >
                          <span className="text-slate-400 hover:text-white text-sm sm:text-base">🔄</span>
                        </button>
                        <button 
                          className="p-1.5 sm:p-2 hover:bg-red-500/20 rounded-lg transition-colors" 
                          title="Excluir"
                          onClick={() => deleteAccount(r.id)}
                        >
                          <span className="text-slate-400 hover:text-red-400 text-sm sm:text-base">🗑️</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Modal de Sincronização */}
      {showSyncModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-slate-900 rounded-xl p-4 sm:p-6 max-w-md w-full border border-white/10 my-auto">
            <h3 className="text-lg sm:text-xl text-white font-semibold mb-3 sm:mb-4">Configurar sincronização</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-slate-300 text-sm mb-2">Dias para buscar</label>
                <input 
                  type="number"
                  value={syncDays}
                  onChange={(e) => setSyncDays(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                  min="1"
                  max="30"
                />
              </div>

              <div>
                <label className="block text-slate-300 text-sm mb-2">Moedas (uma por linha)</label>
                <textarea 
                  value={syncSymbols.join('\n')}
                  onChange={(e) => setSyncSymbols(e.target.value.split('\n').filter(s => s.trim()))}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white h-32"
                  placeholder="BTCBRL&#10;ETHBRL&#10;BNBBRL"
                />
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={syncAll}
                  className="flex-1 bg-gradient-to-r from-blue-500 to-cyan-500 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200"
                >
                  Sincronizar
                </button>
                <button 
                  onClick={() => setShowSyncModal(false)}
                  className="flex-1 bg-white/10 hover:bg-white/20 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Dica de Segurança */}
      <div className="relative overflow-hidden border-blue-500/20 bg-gradient-to-r from-blue-500/10 to-cyan-500/5 backdrop-blur-sm rounded-xl">
        <div className="p-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center shadow-lg">
              <span className="text-white text-xl">⚙️</span>
            </div>
            <div>
              <h3 className="text-lg text-white font-semibold">Dica de Segurança</h3>
              <p className="text-slate-300 text-sm mt-1">
                Para gerar suas chaves de API, acesse sua conta Binance → API Management. 
                Certifique-se de habilitar permissão de <strong>leitura de trades</strong> e adicionar seu IP à lista de permissões.
                Nunca compartilhe suas chaves.
              </p>
            </div>
          </div>
        </div>
      </div>
      </div>
    </InternalLayout>
  );
}
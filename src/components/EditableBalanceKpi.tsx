"use client";
import { useState, useEffect } from 'react';
import { auth } from '@/lib/firebase/client';
import { onAuthStateChanged } from 'firebase/auth';

type EditableBalanceKpiProps = {
  label: string;
  value: string;
  icon?: string;
  color?: 'blue' | 'green' | 'red' | 'purple' | 'orange';
  month: string;
};

const colorClasses = {
  blue: 'from-blue-500 to-cyan-500',
  green: 'from-emerald-500 to-green-500',
  red: 'from-red-500 to-red-600',
  purple: 'from-purple-500 to-pink-500',
  orange: 'from-orange-500 to-amber-500',
};

const bgColors = {
  blue: 'from-blue-500/10 to-cyan-500/10',
  green: 'from-emerald-500/10 to-green-500/10',
  red: 'from-red-500/10 to-red-600/10',
  purple: 'from-purple-500/10 to-pink-500/10',
  orange: 'from-orange-500/10 to-amber-500/10',
};

function EditableBalanceKpi({ label, value, icon = '💳', color = 'purple', month }: EditableBalanceKpiProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [displayValue, setDisplayValue] = useState(value);
  const [isLoading, setIsLoading] = useState(false);
  const [currentBalanceBRL, setCurrentBalanceBRL] = useState('0');
  const [currentBalanceUSDT, setCurrentBalanceUSDT] = useState('0');
  const [loadingBalance, setLoadingBalance] = useState(false);

  const fetchInitialBalance = async () => {
    try {
      const user = auth.currentUser;
      if (!user || !month) return;

      const token = await user.getIdToken();
      const response = await fetch(`/api/monthly-balance?month=${encodeURIComponent(month)}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setDisplayValue(data.balance || '0');
        setEditValue(data.balance || '0');
      }
    } catch (error) {
      console.error('[EditableBalanceKpi] Error fetching initial balance:', error);
    }
  };

  useEffect(() => {
    // Wait for auth state to be ready before fetching balance
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        fetchCurrentBalance();
        fetchInitialBalance();
      }
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    // Buscar saldo inicial quando o mês mudar
    if (month) {
      fetchInitialBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const fetchCurrentBalance = async () => {
    setLoadingBalance(true);
    try {
      const user = auth.currentUser;
      if (!user) {
        console.error('[EditableBalanceKpi] User not authenticated');
        return;
      }

      const token = await user.getIdToken();
      console.log('[EditableBalanceKpi] Fetching balance from /api/balance');
      
      const response = await fetch('/api/balance', {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      console.log('[EditableBalanceKpi] Response status:', response.status);

      if (response.ok) {
        const data = await response.json();
        console.log('[EditableBalanceKpi] Balance data:', data);
        setCurrentBalanceBRL(data.balance || '0');
        setCurrentBalanceUSDT(data.balanceUSDT || '0');
      } else {
        const errorText = await response.text();
        console.error('[EditableBalanceKpi] Failed to fetch balance:', response.status, errorText);
      }
    } catch (error) {
      console.error('[EditableBalanceKpi] Error fetching current balance:', error);
    } finally {
      setLoadingBalance(false);
    }
  };

  const handleEdit = () => {
    setIsEditing(true);
    setEditValue(value);
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const user = auth.currentUser;
      if (!user) {
        alert('Usuário não autenticado');
        setIsEditing(false);
        setIsLoading(false);
        return;
      }

      const token = await user.getIdToken();
      
      const response = await fetch('/api/monthly-balance', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ month, initialBalance: editValue })
      });

      if (response.ok) {
        const result = await response.json();
        setIsEditing(false);
        setDisplayValue(result.balance || editValue);
      } else {
        alert('Erro ao salvar saldo');
      }
    } catch (error) {
      console.error('Error saving balance:', error);
      alert('Erro ao salvar saldo');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditValue(value);
  };

  if (isEditing) {
    return (
      <div className="relative overflow-hidden border-white/10 bg-gradient-to-br from-white/5 to-white/[0.02] backdrop-blur-sm rounded-xl p-4 sm:p-6">
        <div className="space-y-4">
          <label className="text-slate-400 text-sm">{label}</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Ex: 1000"
            />
            <button
              onClick={handleSave}
              disabled={isLoading}
              className="px-3 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors disabled:opacity-50"
              title="Salvar"
            >
              ✓
            </button>
            <button
              onClick={handleCancel}
              disabled={isLoading}
              className="px-3 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors disabled:opacity-50"
              title="Cancelar"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden border-white/10 bg-gradient-to-br from-white/5 to-white/[0.02] backdrop-blur-sm hover:from-white/10 hover:to-white/5 transition-all duration-300 group rounded-xl">
      <div className={`absolute inset-0 bg-gradient-to-br ${bgColors[color]} opacity-0 group-hover:opacity-100 transition-opacity duration-300`} />
      
      <div className="relative p-4 sm:p-6">
        <div className="flex items-center justify-between mb-3 sm:mb-4">
          <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br ${colorClasses[color]} flex items-center justify-center shadow-lg`}>
            <span className="text-white text-lg sm:text-xl">{icon}</span>
          </div>
          <button 
            onClick={handleEdit}
            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            title="Editar saldo"
          >
            <span className="text-white text-sm">✏️</span>
          </button>
        </div>

        <p className="text-slate-400 text-xs sm:text-sm mb-1">{label}</p>
        <p className="text-white text-xl sm:text-2xl tracking-tight break-words">R$ {Number(displayValue).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        
        {/* Saldo Atual */}
        <div className="mt-2 sm:mt-3 pt-2 sm:pt-3 border-t border-white/10">
          <p className="text-slate-400 text-xs mb-1">Saldo Atual Total (Binance)</p>
          <p className="text-white text-sm sm:text-lg tracking-tight flex flex-wrap items-center gap-1 sm:gap-2">
            {loadingBalance ? (
              <span className="animate-pulse text-slate-400">Carregando...</span>
            ) : (
              <>
                <span className={`font-semibold ${Number(currentBalanceBRL) >= Number(displayValue) ? 'text-green-400' : 'text-red-400'}`}>
                  R$ {Number(currentBalanceBRL).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="text-slate-500 text-sm">({Number(currentBalanceUSDT).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT)</span>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

export default EditableBalanceKpi;

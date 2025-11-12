"use client";
import { useState, useEffect } from 'react';
import { auth } from '@/lib/firebase/client';

type EditableCashflowBalanceProps = {
  calculatedBalance: string; // Saldo calculado baseado em depósitos/saques
  savedBalance: string; // Saldo editável salvo pelo usuário
  month: string; // YYYY-MM
  onUpdate?: () => void;
};

export function EditableCashflowBalance({ 
  calculatedBalance, 
  savedBalance, 
  month,
  onUpdate 
}: EditableCashflowBalanceProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(savedBalance || '0');
  const [displayValue, setDisplayValue] = useState(savedBalance || calculatedBalance || '0');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Atualizar displayValue quando savedBalance ou calculatedBalance mudarem
    if (savedBalance && savedBalance !== '0') {
      setDisplayValue(savedBalance);
      setEditValue(savedBalance);
    } else {
      setDisplayValue(calculatedBalance || '0');
      setEditValue(calculatedBalance || '0');
    }
  }, [savedBalance, calculatedBalance]);

  const handleEdit = () => {
    setIsEditing(true);
    setEditValue(displayValue);
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
        if (onUpdate) onUpdate();
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
    setEditValue(displayValue);
  };

  const handleRestore = async () => {
    if (calculatedBalance === displayValue) {
      return; // Já está no valor calculado
    }

    setIsLoading(true);
    try {
      const user = auth.currentUser;
      if (!user) {
        alert('Usuário não autenticado');
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
        body: JSON.stringify({ month, initialBalance: calculatedBalance })
      });

      if (response.ok) {
        const result = await response.json();
        setDisplayValue(result.balance || calculatedBalance);
        setEditValue(result.balance || calculatedBalance);
        if (onUpdate) onUpdate();
      } else {
        alert('Erro ao restaurar saldo');
      }
    } catch (error) {
      console.error('Error restoring balance:', error);
      alert('Erro ao restaurar saldo');
    } finally {
      setIsLoading(false);
    }
  };

  if (isEditing) {
    return (
      <div className="bg-gradient-to-r from-purple-500/10 to-pink-500/5 backdrop-blur-sm rounded-lg border border-white/10 p-4">
        <div className="space-y-4">
          <label className="text-slate-300 text-sm font-semibold">Saldo Inicial do Mês</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
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

  const formatCurrency = (value: string | number): string => {
    const num = Number(value || 0);
    return new Intl.NumberFormat('pt-BR', { 
      style: 'currency', 
      currency: 'BRL',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(num);
  };

  const isDifferentFromCalculated = calculatedBalance && displayValue !== calculatedBalance;

  return (
    <div className="bg-gradient-to-r from-purple-500/10 to-pink-500/5 backdrop-blur-sm rounded-lg border border-white/10 p-4 relative group">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl">💳</span>
          <label className="text-slate-300 text-sm font-semibold">Saldo Inicial do Mês</label>
        </div>
        <div className="flex items-center gap-2">
          {isDifferentFromCalculated && (
            <button
              onClick={handleRestore}
              disabled={isLoading}
              className="p-1.5 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 transition-colors disabled:opacity-50"
              title="Restaurar valor calculado"
            >
              <span className="text-blue-400 text-xs">↻</span>
            </button>
          )}
          <button 
            onClick={handleEdit}
            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            title="Editar saldo"
          >
            <span className="text-white text-sm">✏️</span>
          </button>
        </div>
      </div>
      <p className="text-white text-2xl font-bold">
        {formatCurrency(displayValue)}
      </p>
      {isDifferentFromCalculated && (
        <p className="text-xs text-slate-400 mt-1">
          Calculado: {formatCurrency(calculatedBalance)}
        </p>
      )}
    </div>
  );
}


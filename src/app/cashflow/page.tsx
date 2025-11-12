"use client";
import React, { useEffect, useState } from 'react';
import InternalLayout from '@/components/InternalLayout';
import { auth } from '@/lib/firebase/client';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { EditableCashflowBalance } from '@/components/EditableCashflowBalance';

declare global {
  interface Window {
    __cashflowPollInterval?: NodeJS.Timeout | null;
  }
}

type CashflowRow = {
  id: string;
  accountId: string;
  accountName: string;
  type: string;
  asset: string;
  amount: string;
  at: string;
  note: string | null;
};

function formatCurrency(value: string | number): string {
  const num = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', { 
    style: 'currency', 
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
}

function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function getMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Função para obter período baseado na seleção (igual ao dashboard)
function getPeriodFilter(period: string, earliestDate?: string | null): { month?: string; startDate?: string; endDate?: string } {
  const now = new Date();
  switch (period) {
    case 'all': {
      // Se temos data mais antiga, usar ela, senão usar 2020-01-01 como fallback
      const start = earliestDate || '2020-01-01';
      const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return { startDate: start, endDate: end };
    }
    case 'today': {
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return { month: today };
    }
    case 'week': {
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      const weekStartStr = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
      const weekEndStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return { startDate: weekStartStr, endDate: weekEndStr };
    }
    case 'month':
      return { month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` };
    case 'year': {
      const yearStart = `${now.getFullYear()}-01-01`;
      const yearEnd = `${now.getFullYear()}-12-31`;
      return { startDate: yearStart, endDate: yearEnd };
    }
    default:
      return { month: getMonth() };
  }
}

export default function CashflowPage() {
  const [rows, setRows] = useState<CashflowRow[]>([]);
  const [total, setTotal] = useState(0);
  const [tradesCount, setTradesCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [period, setPeriod] = useState('month');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [periodDropdownOpen, setPeriodDropdownOpen] = useState(false);
  const [customDateOpen, setCustomDateOpen] = useState(false);
  const [monthSelectOpen, setMonthSelectOpen] = useState(false);
  const [type, setType] = useState<string>('');
  const [asset, setAsset] = useState<string>('');
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [calculatedInitialBalance, setCalculatedInitialBalance] = useState('0');
  const [savedInitialBalance, setSavedInitialBalance] = useState('0');
  const [currentMonth, setCurrentMonth] = useState('');
  const [summary, setSummary] = useState<{
    totalDeposits: string;
    totalWithdrawals: string;
    netCashflow: string;
  } | null>(null);
  const [earliestDate, setEarliestDate] = useState<string | null>(null);

  const periodOptions = [
    { value: 'all', label: '🌐 Todos' },
    { value: 'today', label: '📅 Hoje' },
    { value: 'week', label: '📆 Esta Semana' },
    { value: 'month', label: '📅 Este Mês' },
    { value: 'month-select', label: '📆 Selecionar Mês' },
    { value: 'year', label: '📅 Este Ano' },
    { value: 'custom', label: '🔧 Personalizado' },
  ];

  const getPeriodLabel = () => {
    if (period === 'month-select' && selectedMonth) {
      const date = new Date(selectedMonth + '-01');
      return `📅 ${date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}`;
    }
    if (period === 'custom' && startDate && endDate) {
      return `🔧 ${new Date(startDate).toLocaleDateString('pt-BR')} - ${new Date(endDate).toLocaleDateString('pt-BR')}`;
    }
    const option = periodOptions.find(opt => opt.value === period);
    return option ? option.label : '📅 Este Mês';
  };
  
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncStartDate, setSyncStartDate] = useState('');
  const [syncEndDate, setSyncEndDate] = useState('');
  const [syncProgress, setSyncProgress] = useState<{
    jobId: string | null;
    percent: number;
    message: string;
    status: 'running' | 'completed' | 'error';
    result?: { inserted: number; updated: number };
    error?: string;
  } | null>(null);

  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importAccountId, setImportAccountId] = useState('');
  const [importProgress, setImportProgress] = useState<{
    jobId: string | null;
    percent: number;
    message: string;
    status: 'running' | 'completed' | 'error';
    result?: { inserted: number; updated: number };
    error?: string;
  } | null>(null);

  useEffect(() => {
    const fetchEarliestDate = async () => {
      const user = auth.currentUser;
      if (!user) return;

      try {
        const token = await user.getIdToken();
        const response = await fetch('/api/data-range', {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });

        if (response.ok) {
          const data = await response.json();
          if (data.earliestDate) {
            setEarliestDate(data.earliestDate);
          }
        }
      } catch (error) {
        console.error('Error fetching earliest date:', error);
      }
    };

    fetchEarliestDate();
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      const params = new URLSearchParams();
      
      // Aplicar lógica de período igual ao dashboard
      if (period === 'custom' && startDate && endDate) {
        params.set('startDate', startDate);
        params.set('endDate', endDate);
      } else if (period === 'month-select' && selectedMonth) {
        const [year, monthNum] = selectedMonth.split('-').map(Number);
        const monthStart = `${year}-${String(monthNum).padStart(2, '0')}-01`;
        const monthEnd = new Date(year, monthNum, 0).toISOString().split('T')[0];
        params.set('startDate', monthStart);
        params.set('endDate', monthEnd);
      } else {
        const periodFilter = getPeriodFilter(period, earliestDate);
        if (periodFilter.startDate && periodFilter.endDate) {
          params.set('startDate', periodFilter.startDate);
          params.set('endDate', periodFilter.endDate);
        } else if (periodFilter.month) {
          const [year, monthNum] = periodFilter.month.split('-').map(Number);
          const monthStart = `${year}-${String(monthNum).padStart(2, '0')}-01`;
          const monthEnd = new Date(year, monthNum, 0).toISOString().split('T')[0];
          params.set('startDate', monthStart);
          params.set('endDate', monthEnd);
        }
      }
      
      if (type) params.set('type', type);
      if (asset) params.set('asset', asset);
      params.set('page', page.toString());
      params.set('pageSize', pageSize.toString());

      try {
        const res = await fetch(`/api/cashflow?${params.toString()}`, {
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!res.ok) {
          console.error('Error fetching cashflow:', res.status);
          return;
        }

        const data = await res.json();
        setTotal(data.total);
        setRows(data.rows || []);
        setTradesCount(data.tradesCount || 0);
        setCalculatedInitialBalance(data.calculatedInitialBalance || '0');
        setSavedInitialBalance(data.savedInitialBalance || '0');
        setCurrentMonth(data.month || '');
        // Usar summary da API (valores de TODAS as transações filtradas)
        if (data.summary) {
          setSummary({
            totalDeposits: data.summary.totalDeposits || '0',
            totalWithdrawals: data.summary.totalWithdrawals || '0',
            netCashflow: data.summary.netCashflow || '0',
          });
        } else {
          // Fallback: calcular dos rows (compatibilidade)
          const totalDeposits = (data.rows || [])
            .filter((r: CashflowRow) => r.type === 'DEPOSIT' && !r.note?.includes('Expired'))
            .reduce((sum: number, r: CashflowRow) => sum + Number(r.amount), 0);
          const totalWithdrawals = (data.rows || [])
            .filter((r: CashflowRow) => r.type === 'WITHDRAWAL' && !r.note?.includes('Expired'))
            .reduce((sum: number, r: CashflowRow) => sum + Math.abs(Number(r.amount)), 0);
          setSummary({
            totalDeposits: totalDeposits.toString(),
            totalWithdrawals: totalWithdrawals.toString(),
            netCashflow: (totalDeposits - totalWithdrawals).toString(),
          });
        }
      } catch (error) {
        console.error('Error fetching cashflow:', error);
      }
    };

    fetchData();
  }, [page, pageSize, period, startDate, endDate, selectedMonth, type, asset, earliestDate]);

  useEffect(() => {
    const fetchAccounts = async () => {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      try {
        const res = await fetch('/api/accounts', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (res.ok) {
          const data = await res.json();
          setAccounts(data.results || []);
          if (data.results && data.results.length > 0 && !selectedAccount) {
            setSelectedAccount(data.results[0].id);
            setImportAccountId(data.results[0].id);
          }
        }
      } catch (error) {
        console.error('Error fetching accounts:', error);
      }
    };

    fetchAccounts();
  }, [selectedAccount]);

  const syncCashflow = async () => {
    try {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      const response = await fetch('/api/cashflow/sync', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate: syncStartDate || undefined,
          endDate: syncEndDate || undefined,
        }),
      });

      const result = await response.json();

      if (result.error) {
        alert(`Erro: ${result.error}`);
        return;
      }

      if (result.jobId) {
        setSyncProgress({
          jobId: result.jobId,
          percent: 0,
          message: 'Iniciando sincronização...',
          status: 'running',
        });

        const pollInterval = setInterval(async () => {
          try {
            const statusResponse = await fetch(`/api/jobs/sync-status?jobId=${result.jobId}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const status = await statusResponse.json();

            if (status.error) {
              if (pollInterval) clearInterval(pollInterval);
              setSyncProgress(null);
              alert(`Erro: ${status.error}`);
              return;
            }

            setSyncProgress({
              jobId: status.jobId,
              percent: status.percent || 0,
              message: status.message || 'Processando...',
              status: status.status,
              result: status.result,
              error: status.error,
            });

            if (status.status === 'completed') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                if (status.result) {
                  alert(`Sincronização concluída! ${status.result.inserted || 0} inseridos, ${status.result.updated || 0} atualizados.`);
                }
                setSyncProgress(null);
                setShowSyncModal(false);
                window.location.reload();
              }, 2000);
            } else if (status.status === 'error') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                alert(`Erro na sincronização: ${status.error || 'Erro desconhecido'}`);
                setSyncProgress(null);
              }, 2000);
            }
          } catch (error) {
            console.error('Error polling status:', error);
            if (pollInterval) clearInterval(pollInterval);
          }
        }, 1000);

        window.__cashflowPollInterval = pollInterval;
      } else {
        alert('Erro: jobId não retornado');
      }
    } catch (error) {
      alert(`Erro ao sincronizar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
      setSyncProgress(null);
    }
  };

  const importCSV = async () => {
    if (!importFile || !importAccountId) {
      alert('Selecione um arquivo CSV e uma conta');
      return;
    }

    try {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      const formData = new FormData();
      formData.append('file', importFile);
      formData.append('accountId', importAccountId);

      const response = await fetch('/api/cashflow/import-csv', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      const result = await response.json();

      if (result.error) {
        alert(`Erro: ${result.error}`);
        return;
      }

      if (result.jobId) {
        setImportProgress({
          jobId: result.jobId,
          percent: 0,
          message: 'Iniciando importação...',
          status: 'running',
        });

        const pollInterval = setInterval(async () => {
          try {
            const statusResponse = await fetch(`/api/jobs/sync-status?jobId=${result.jobId}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const status = await statusResponse.json();

            if (status.error) {
              if (pollInterval) clearInterval(pollInterval);
              setImportProgress(null);
              alert(`Erro: ${status.error}`);
              return;
            }

            setImportProgress({
              jobId: status.jobId,
              percent: status.percent || 0,
              message: status.message || 'Processando...',
              status: status.status,
              result: status.result,
              error: status.error,
            });

            if (status.status === 'completed') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                if (status.result) {
                  alert(`Importação concluída! ${status.result.inserted || 0} inseridos, ${status.result.updated || 0} atualizados.`);
                }
                setImportProgress(null);
                setShowImportModal(false);
                setImportFile(null);
                window.location.reload();
              }, 2000);
            } else if (status.status === 'error') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                alert(`Erro na importação: ${status.error || 'Erro desconhecido'}`);
                setImportProgress(null);
              }, 2000);
            }
          } catch (error) {
            console.error('Error polling status:', error);
            if (pollInterval) clearInterval(pollInterval);
          }
        }, 1000);

        window.__cashflowPollInterval = pollInterval;
      } else {
        alert('Erro: jobId não retornado');
      }
    } catch (error) {
      alert(`Erro ao importar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
      setImportProgress(null);
    }
  };

  const columnHelper = createColumnHelper<CashflowRow>();

  const columns = [
    columnHelper.accessor('at', {
      header: 'Data/Hora',
      cell: (info) => formatDateTime(info.getValue()),
    }),
    columnHelper.accessor('accountName', {
      header: 'Conta',
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('type', {
      header: 'Tipo',
      cell: (info) => {
        const type = info.getValue();
        const isDeposit = type === 'DEPOSIT';
        return (
          <span className={`px-2 py-1 rounded text-xs font-semibold ${
            isDeposit ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {isDeposit ? '💰 Depósito' : '💸 Saque'}
          </span>
        );
      },
    }),
    columnHelper.accessor('asset', {
      header: 'Moeda',
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('amount', {
      header: 'Valor',
      cell: (info) => {
        const amount = Number(info.getValue());
        const isPositive = amount >= 0;
        return (
          <span className={isPositive ? 'text-green-400' : 'text-red-400'}>
            {formatCurrency(amount)}
          </span>
        );
      },
    }),
    columnHelper.accessor('note', {
      header: 'Observações',
      cell: (info) => info.getValue() || '-',
    }),
  ];

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: Math.ceil(total / pageSize),
  });

  const totalPages = Math.ceil(total / pageSize);

  // Usar valores do summary (calculados de TODAS as transações filtradas, não apenas da página atual)
  const totalDeposits = summary ? Number(summary.totalDeposits) : 0;
  const totalWithdrawals = summary ? Number(summary.totalWithdrawals) : 0;
  const netCashflow = summary ? Number(summary.netCashflow) : 0;

  return (
    <InternalLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Depósitos e Saques</h1>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            <button
              onClick={() => setShowSyncModal(true)}
              className="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-semibold py-2 px-4 sm:px-6 rounded-lg transition-all duration-200 flex items-center justify-center gap-2 text-sm sm:text-base"
            >
              <span>🔄</span>
              <span className="hidden sm:inline">Sincronizar via API</span>
              <span className="sm:hidden">Sincronizar</span>
            </button>
            <button
              onClick={() => setShowImportModal(true)}
              className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-semibold py-2 px-4 sm:px-6 rounded-lg transition-all duration-200 flex items-center justify-center gap-2 text-sm sm:text-base"
            >
              <span>📄</span>
              <span className="hidden sm:inline">Importar CSV</span>
              <span className="sm:hidden">Importar</span>
            </button>
          </div>
        </div>

        {/* Saldo Inicial Editável */}
        <EditableCashflowBalance
          calculatedBalance={calculatedInitialBalance}
          savedBalance={savedInitialBalance}
          month={currentMonth || (() => {
            // Se não há currentMonth, usar mês do startDate ou mês atual
            if (startDate) {
              return startDate.substring(0, 7);
            }
            const now = new Date();
            return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          })()}
          onUpdate={() => {
            // Recarregar dados após atualização
            const fetchData = async () => {
              const user = auth.currentUser;
              if (!user) return;

              const token = await user.getIdToken();
              const params = new URLSearchParams();
              
              if (startDate) params.set('startDate', startDate);
              if (endDate) params.set('endDate', endDate);
              if (type) params.set('type', type);
              if (asset) params.set('asset', asset);
              params.set('page', page.toString());
              params.set('pageSize', pageSize.toString());

              try {
                const res = await fetch(`/api/cashflow?${params.toString()}`, {
                  cache: 'no-store',
                  headers: {
                    Authorization: `Bearer ${token}`,
                  },
                });

                if (res.ok) {
                  const data = await res.json();
                  setSavedInitialBalance(data.savedInitialBalance || '0');
                  setCalculatedInitialBalance(data.calculatedInitialBalance || '0');
                  setCurrentMonth(data.month || '');
                }
              } catch (error) {
                console.error('Error fetching cashflow:', error);
              }
            };
            fetchData();
          }}
        />

        {/* KPIs */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          <div className="bg-gradient-to-r from-green-500/10 to-emerald-500/5 backdrop-blur-sm rounded-lg border border-white/10 p-3 sm:p-4">
            <div className="text-xl sm:text-2xl font-bold text-green-400">
              {formatCurrency(totalDeposits)}
            </div>
            <div className="text-xs sm:text-sm text-slate-400">Total de Depósitos</div>
          </div>
          <div className="bg-gradient-to-r from-red-500/10 to-pink-500/5 backdrop-blur-sm rounded-lg border border-white/10 p-3 sm:p-4">
            <div className="text-xl sm:text-2xl font-bold text-red-400">
              {formatCurrency(totalWithdrawals)}
            </div>
            <div className="text-xs sm:text-sm text-slate-400">Total de Saques</div>
          </div>
          <div className="bg-gradient-to-r from-blue-500/10 to-indigo-500/5 backdrop-blur-sm rounded-lg border border-white/10 p-3 sm:p-4">
            <div className="text-xl sm:text-2xl font-bold text-blue-400">
              {formatCurrency(netCashflow)}
            </div>
            <div className="text-xs sm:text-sm text-slate-400">Fluxo de Caixa Líquido</div>
          </div>
        </div>

        {/* Filtros */}
        <div className="bg-slate-900/50 backdrop-blur-sm rounded-lg border border-white/10 p-3 sm:p-4 space-y-3 sm:space-y-4 relative z-20">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            <div className="relative z-30">
              <label className="block text-sm font-medium text-slate-300 mb-1">⏰ Período</label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setPeriodDropdownOpen(!periodDropdownOpen)}
                  className="w-full flex items-center justify-between gap-2 border border-white/10 bg-white/5 text-white rounded-lg px-4 py-2.5 hover:bg-white/10 transition-colors focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <span>{getPeriodLabel()}</span>
                  <span className={`transition-transform ${periodDropdownOpen ? 'rotate-180' : ''}`}>⌄</span>
                </button>
                {periodDropdownOpen && (
                  <>
                    <div 
                      className="fixed inset-0 z-[100]" 
                      onClick={() => setPeriodDropdownOpen(false)}
                    />
                    <div className="absolute z-[110] mt-1 w-full bg-slate-800 border border-white/10 rounded-lg shadow-xl overflow-hidden">
                      {periodOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setPeriod(option.value);
                            setPeriodDropdownOpen(false);
                            if (option.value === 'custom') {
                              setCustomDateOpen(true);
                              setMonthSelectOpen(false);
                            } else if (option.value === 'month-select') {
                              setMonthSelectOpen(true);
                              setCustomDateOpen(false);
                            } else {
                              setCustomDateOpen(false);
                              setMonthSelectOpen(false);
                              setSelectedMonth('');
                            }
                          }}
                          className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors ${
                            period === option.value 
                              ? 'bg-blue-500/20 text-blue-400' 
                              : 'bg-transparent text-slate-200'
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {period === 'month-select' && monthSelectOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-[100]" 
                    onClick={() => {
                      setMonthSelectOpen(false);
                      if (!selectedMonth) {
                        setPeriod('month');
                      }
                    }}
                  />
                  <div className="absolute top-full left-0 mt-2 z-[110] bg-slate-800 border border-white/10 rounded-lg shadow-xl p-4 min-w-[200px]">
                    <div className="flex flex-col">
                      <label className="text-sm font-medium text-slate-300 mb-2">📅 Selecionar Mês</label>
                      <input 
                        type="month" 
                        value={selectedMonth} 
                        onChange={(e) => {
                          setSelectedMonth(e.target.value);
                          setMonthSelectOpen(false);
                          setPeriodDropdownOpen(false);
                        }}
                        className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                        required
                      />
                    </div>
                  </div>
                </>
              )}
              {period === 'custom' && customDateOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-[100]" 
                    onClick={() => {
                      setCustomDateOpen(false);
                      if (!startDate || !endDate) {
                        setPeriod('month');
                      }
                    }}
                  />
                  <div className="absolute top-full left-0 mt-2 z-[110] bg-slate-800 border border-white/10 rounded-lg shadow-xl p-4 flex flex-col gap-2 min-w-[250px]">
                    <div className="flex flex-col">
                      <label className="text-sm font-medium text-slate-300 mb-1">📅 Data Inicial</label>
                      <input 
                        type="date" 
                        value={startDate} 
                        onChange={(e) => setStartDate(e.target.value)} 
                        className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                        required
                      />
                    </div>
                    <div className="flex flex-col">
                      <label className="text-sm font-medium text-slate-300 mb-1">📅 Data Final</label>
                      <input 
                        type="date" 
                        value={endDate} 
                        onChange={(e) => {
                          setEndDate(e.target.value);
                          if (startDate && e.target.value) {
                            setCustomDateOpen(false);
                          }
                        }}
                        min={startDate}
                        className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                        required
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
            <div>
              <label className="block text-sm text-slate-300 mb-2">Tipo</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white [&>option]:bg-slate-800 [&>option]:text-white"
              >
                <option value="" className="bg-slate-800 text-white">Todos</option>
                <option value="DEPOSIT" className="bg-slate-800 text-white">Depósito</option>
                <option value="WITHDRAWAL" className="bg-slate-800 text-white">Saque</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-300 mb-2">Moeda</label>
              <input
                type="text"
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
                placeholder="Ex: BRL"
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
              />
            </div>
          </div>
          {/* Informações de disponibilidade */}
          <div className="pt-2 border-t border-white/10">
            <div className="flex flex-wrap gap-3 sm:gap-4 text-xs sm:text-sm text-slate-400">
              <span>
                <span className="text-slate-300 font-semibold">{total.toLocaleString('pt-BR')}</span> transações disponíveis
              </span>
              <span>
                <span className="text-slate-300 font-semibold">{tradesCount.toLocaleString('pt-BR')}</span> trades disponíveis
              </span>
              {total > 0 && (
                <span>
                  <span className="text-slate-300 font-semibold">{Math.ceil(total / pageSize)}</span> página{Math.ceil(total / pageSize) !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Tabela */}
        <div className="bg-slate-900/50 backdrop-blur-sm rounded-lg border border-white/10 overflow-hidden relative z-10">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-800/50">
                {table.getHeaderGroups().map(headerGroup => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map(header => (
                      <th
                        key={header.id}
                        className="px-4 py-3 text-left text-sm font-semibold text-slate-300"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-white/5">
                {table.getRowModel().rows.map(row => (
                  <tr key={row.id} className="hover:bg-white/5 transition-colors">
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id} className="px-4 py-3 text-sm text-slate-300">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length === 0 && (
            <div className="text-center py-12 text-slate-400">
              Nenhum registro encontrado
            </div>
          )}

          {/* Paginação */}
          {totalPages > 1 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-0 px-3 sm:px-4 py-3 border-t border-white/10">
              <div className="text-xs sm:text-sm text-slate-400 text-center sm:text-left">
                Mostrando {((page - 1) * pageSize) + 1} a {Math.min(page * pageSize, total)} de {total}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 bg-white/5 border border-white/10 rounded text-xs sm:text-sm text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/10"
                >
                  Anterior
                </button>
                <span className="px-3 py-1 text-xs sm:text-sm text-slate-300">
                  Página {page} de {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1 bg-white/5 border border-white/10 rounded text-xs sm:text-sm text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/10"
                >
                  Próxima
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal de Sincronização */}
        {showSyncModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
            <div className="bg-slate-900 rounded-xl p-4 sm:p-6 max-w-md w-full border border-white/10 my-auto">
              <h3 className="text-lg sm:text-xl text-white font-semibold mb-3 sm:mb-4">
                {syncProgress !== null ? 'Sincronizando' : 'Sincronizar via API'}
              </h3>
              {syncProgress !== null ? (
                <div className="space-y-4">
                  <div className="w-full bg-white/5 rounded-full h-2">
                    <div
                      className="bg-gradient-to-r from-blue-500 to-cyan-500 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${syncProgress.percent}%` }}
                    />
                  </div>
                  <div className="text-sm text-slate-300">{syncProgress.message}</div>
                  {syncProgress.status === 'completed' && syncProgress.result && (
                    <div className="text-sm text-green-400">
                      <div className="font-semibold mb-1">✓ Sincronização concluída!</div>
                      <div>
                        {syncProgress.result.inserted || 0} inseridos, {syncProgress.result.updated || 0} atualizados
                      </div>
                    </div>
                  )}
                  {syncProgress.status === 'error' && (
                    <div className="text-sm text-red-400">
                      <div className="font-semibold mb-1">✗ Erro na sincronização</div>
                      <div>{syncProgress.error || 'Erro desconhecido'}</div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-slate-300 text-sm mb-2">📅 Data inicial (opcional)</label>
                    <input
                      type="date"
                      value={syncStartDate}
                      onChange={(e) => setSyncStartDate(e.target.value)}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    />
                    <p className="text-xs text-slate-400 mt-1">Deixe vazio para últimos 30 dias</p>
                  </div>
                  <div>
                    <label className="block text-slate-300 text-sm mb-2">📅 Data final (opcional)</label>
                    <input
                      type="date"
                      value={syncEndDate}
                      onChange={(e) => setSyncEndDate(e.target.value)}
                      min={syncStartDate}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    />
                    <p className="text-xs text-slate-400 mt-1">Deixe vazio para hoje</p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={syncCashflow}
                      disabled={!!syncProgress}
                      className="flex-1 bg-gradient-to-r from-blue-500 to-cyan-500 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Sincronizar
                    </button>
                    <button
                      onClick={() => {
                        if (window.__cashflowPollInterval) {
                          clearInterval(window.__cashflowPollInterval);
                          window.__cashflowPollInterval = null;
                        }
                        setShowSyncModal(false);
                        setSyncProgress(null);
                        setSyncStartDate('');
                        setSyncEndDate('');
                      }}
                      className="flex-1 bg-white/10 hover:bg-white/20 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Modal de Importação CSV */}
        {showImportModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
            <div className="bg-slate-900 rounded-xl p-4 sm:p-6 max-w-md w-full border border-white/10 my-auto">
              <h3 className="text-lg sm:text-xl text-white font-semibold mb-3 sm:mb-4">
                {importProgress !== null ? 'Importando CSV' : 'Importar CSV'}
              </h3>
              {importProgress !== null ? (
                <div className="space-y-4">
                  <div className="w-full bg-white/5 rounded-full h-2">
                    <div
                      className="bg-gradient-to-r from-purple-500 to-pink-500 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${importProgress.percent}%` }}
                    />
                  </div>
                  <div className="text-sm text-slate-300">{importProgress.message}</div>
                  {importProgress.status === 'completed' && importProgress.result && (
                    <div className="text-sm text-green-400">
                      <div className="font-semibold mb-1">✓ Importação concluída!</div>
                      <div>
                        {importProgress.result.inserted || 0} inseridos, {importProgress.result.updated || 0} atualizados
                      </div>
                    </div>
                  )}
                  {importProgress.status === 'error' && (
                    <div className="text-sm text-red-400">
                      <div className="font-semibold mb-1">✗ Erro na importação</div>
                      <div>{importProgress.error || 'Erro desconhecido'}</div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-slate-300 text-sm mb-2">Conta</label>
                    <select
                      value={importAccountId}
                      onChange={(e) => setImportAccountId(e.target.value)}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    >
                      <option value="">Selecione uma conta</option>
                      {accounts.map(acc => (
                        <option key={acc.id} value={acc.id}>{acc.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-300 text-sm mb-2">Arquivo CSV</label>
                    <input
                      type="file"
                      accept=".csv"
                      onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      Formato esperado: Data (UTC), Tipo, Moeda, Valor, Taxa, Método, Status, Número do Pedido
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={importCSV}
                      disabled={!importFile || !importAccountId || !!importProgress}
                      className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Importar
                    </button>
                    <button
                      onClick={() => {
                        if (window.__cashflowPollInterval) {
                          clearInterval(window.__cashflowPollInterval);
                          window.__cashflowPollInterval = null;
                        }
                        setShowImportModal(false);
                        setImportProgress(null);
                        setImportFile(null);
                      }}
                      className="flex-1 bg-white/10 hover:bg-white/20 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </InternalLayout>
  );
}


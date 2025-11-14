"use client";
import { useEffect, useState } from 'react';
import { Card } from '@/components/Card';
import { Kpi } from '@/components/Kpi';
import { PnlLineChart } from '@/components/PnlLineChart';
import InternalLayout from '@/components/InternalLayout';
import EditableBalanceKpi from '@/components/EditableBalanceKpi';
import { auth } from '@/lib/firebase/client';
import { onAuthStateChanged } from 'firebase/auth';

type TradeRow = { executedAt: string | Date; realizedPnl: string };
type TradesResponse = {
  rows: TradeRow[];
  total: number;
  summary: { pnlMonth: string; feesTotal: string; avgFeePct: string; tradesCount: number; winRate: number; initialBalance: string };
};

async function fetchTrades(month: string, startDate?: string, endDate?: string): Promise<TradesResponse> {
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated');
  
  const token = await user.getIdToken();
  const params = new URLSearchParams({ month });
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  const url = `/api/trades?${params.toString()}`;
  const res = await fetch(url, { 
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!res.ok) throw new Error('failed to fetch');
  return res.json();
}

function getMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Função para obter período baseado na seleção
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

function aggregateDaily(rows: TradeRow[]) {
  const map = new Map<string, number>();
  for (const r of rows) {
    const d = new Date(r.executedAt).toISOString().slice(0, 10);
    const prev = map.get(d) || 0;
    map.set(d, prev + Number(r.realizedPnl || 0));
  }
  return Array.from(map.entries()).map(([date, pnl]) => ({ date, pnl }));
}

export default function DashboardPage() {
  const [data, setData] = useState<TradesResponse | null>(null);
  const [previousPeriodData, setPreviousPeriodData] = useState<TradesResponse | null>(null);
  const [currentBalanceBRL, setCurrentBalanceBRL] = useState('0');
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [currentMonthInitialBalance, setCurrentMonthInitialBalance] = useState('0');
  const [loadingInitialBalance, setLoadingInitialBalance] = useState(false);
  const [period, setPeriod] = useState('month');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [periodDropdownOpen, setPeriodDropdownOpen] = useState(false);
  const [customDateOpen, setCustomDateOpen] = useState(false);
  const [monthSelectOpen, setMonthSelectOpen] = useState(false);
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
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setData(null);
        return;
      }

      // Buscar balance e saldo inicial
      fetchCurrentBalance();
      fetchCurrentMonthInitialBalance();

      // Buscar trades
      let monthParam: string | undefined;
      let startDateParam: string | undefined;
      let endDateParam: string | undefined;

      if (period === 'custom' && startDate && endDate) {
        // Período customizado: usar startDate e endDate
        monthParam = `${startDate}_${endDate}`;
        startDateParam = startDate;
        endDateParam = endDate;
      } else if (period === 'month-select' && selectedMonth) {
        // Mês selecionado: usar o mês escolhido
        monthParam = selectedMonth;
      } else {
        // Outros períodos: usar getPeriodFilter (passar earliestDate para 'all')
        const periodFilter = getPeriodFilter(period, earliestDate);
        monthParam = periodFilter.month;
        startDateParam = periodFilter.startDate;
        endDateParam = periodFilter.endDate;
      }

      try {
        const tradesData = await fetchTrades(monthParam || '', startDateParam, endDateParam);
        setData(tradesData);

        // Buscar dados do período anterior para comparação
        let previousMonthParam: string | undefined;
        let previousStartDateParam: string | undefined;
        let previousEndDateParam: string | undefined;

        if (period === 'month') {
          // Mês anterior
          const now = new Date();
          const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          previousMonthParam = `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, '0')}`;
        } else if (period === 'week') {
          // Semana anterior
          const now = new Date();
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - now.getDay() - 7);
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekStart.getDate() + 6);
          previousStartDateParam = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
          previousEndDateParam = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, '0')}-${String(weekEnd.getDate()).padStart(2, '0')}`;
        } else if (period === 'year') {
          // Ano anterior
          const now = new Date();
          const previousYear = now.getFullYear() - 1;
          previousStartDateParam = `${previousYear}-01-01`;
          previousEndDateParam = `${previousYear}-12-31`;
        } else if (period === 'month-select' && selectedMonth) {
          // Mês anterior ao selecionado
          const selected = new Date(selectedMonth + '-01');
          const previous = new Date(selected.getFullYear(), selected.getMonth() - 1, 1);
          previousMonthParam = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
        }

        if (previousMonthParam || (previousStartDateParam && previousEndDateParam)) {
          try {
            const previousData = await fetchTrades(previousMonthParam || '', previousStartDateParam, previousEndDateParam);
            setPreviousPeriodData(previousData);
            console.log('Previous period data loaded:', previousData?.summary);
          } catch (err) {
            console.error('Error fetching previous period data:', err);
            setPreviousPeriodData(null);
          }
        } else {
          setPreviousPeriodData(null);
        }
      } catch (err) {
        console.error('Error fetching trades:', err);
        setData(null);
      }
    });

    return () => unsubscribe();
  }, [period, startDate, endDate, selectedMonth, earliestDate]);

  const fetchCurrentBalance = async () => {
    setLoadingBalance(true);
    try {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      const response = await fetch('/api/balance', {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (response.ok) {
        const balanceData = await response.json();
        setCurrentBalanceBRL(balanceData.balance || '0');
      }
    } catch (error) {
      console.error('Error fetching current balance:', error);
    } finally {
      setLoadingBalance(false);
    }
  };

  const fetchCurrentMonthInitialBalance = async () => {
    setLoadingInitialBalance(true);
    try {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      const currentMonth = getMonth();
      const response = await fetch(`/api/monthly-balance?month=${encodeURIComponent(currentMonth)}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setCurrentMonthInitialBalance(data.balance || '0');
      }
    } catch (error) {
      console.error('Error fetching current month initial balance:', error);
    } finally {
      setLoadingInitialBalance(false);
    }
  };

  if (!data) return <InternalLayout><div className="text-white">Carregando...</div></InternalLayout>;

  const { summary, rows } = data;
  const daily = aggregateDaily(rows);
  
  // Calcular PnL de hoje
  const today = new Date().toISOString().slice(0, 10);
  const todayPnl = daily.find(d => d.date === today)?.pnl || 0;

  // Calcular ROI baseado no saldo da Binance (sempre usa saldo inicial do mês atual, não filtrado)
  const calculateROIBinance = () => {
    if (currentMonthInitialBalance === '0' || loadingBalance || loadingInitialBalance) return null;
    const initialBalance = Number(currentMonthInitialBalance);
    const currentBalance = Number(currentBalanceBRL);
    if (initialBalance === 0) return null;
    const roiBinance = ((currentBalance - initialBalance) / initialBalance) * 100;
    const isPositive = roiBinance >= 0;
    return (
      <span className={isPositive ? 'text-green-400' : 'text-red-400'}>
        ROI Binance: {isPositive ? '+' : ''}{roiBinance.toFixed(2)}%
      </span>
    );
  };

  // Calcular PnL baseado no saldo da Binance (sempre usa saldo inicial do mês atual, não filtrado)
  const calculatePnLBinance = () => {
    if (currentMonthInitialBalance === '0' || loadingBalance || loadingInitialBalance) return null;
    const initialBalance = Number(currentMonthInitialBalance);
    const currentBalance = Number(currentBalanceBRL);
    const pnlBinance = currentBalance - initialBalance;
    const isPositive = pnlBinance >= 0;
    return (
      <span className={isPositive ? 'text-green-400' : 'text-red-400'}>
        PnL Binance: {isPositive ? '+' : ''}R$ {pnlBinance.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
  };

  // Calcular variação percentual do PnL comparado com período anterior
  const calculatePnLTrend = () => {
    if (!data) return null;
    const currentPnL = Number(data.summary.pnlMonth);
    
    // Se houver dados do período anterior, calcular variação
    if (previousPeriodData) {
      const previousPnL = Number(previousPeriodData.summary.pnlMonth);
      if (previousPnL !== 0) {
        const variation = ((currentPnL - previousPnL) / Math.abs(previousPnL)) * 100;
        return {
          value: variation >= 0 ? `+${variation.toFixed(1)}%` : `${variation.toFixed(1)}%`,
          trend: variation >= 0 ? 'up' : 'down'
        };
      }
    }
    
    // Se não houver comparação, mostrar como percentual do saldo inicial (se houver)
    const initialBalance = Number(data.summary.initialBalance);
    if (initialBalance > 0) {
      const pctOfInitial = (currentPnL / initialBalance) * 100;
      return {
        value: pctOfInitial >= 0 ? `+${pctOfInitial.toFixed(1)}%` : `${pctOfInitial.toFixed(1)}%`,
        trend: pctOfInitial >= 0 ? 'up' : 'down'
      };
    }
    
    // Se não houver saldo inicial, mostrar o valor absoluto do PnL (sempre que houver dados)
    // Mesmo que seja 0, vamos mostrar para manter consistência
    const absValue = Math.abs(currentPnL);
    return {
      value: currentPnL >= 0 ? `+R$ ${absValue.toFixed(2)}` : `-R$ ${absValue.toFixed(2)}`,
      trend: currentPnL >= 0 ? 'up' : 'down'
    };
  };

  // Calcular variação percentual do ROI comparado com período anterior
  const calculateROITrend = () => {
    if (!data) return null;
    const currentInitialBalance = Number(data.summary.initialBalance);
    if (currentInitialBalance === 0) return null;
    
    const currentROI = (Number(data.summary.pnlMonth) / currentInitialBalance) * 100;
    
    // Se houver dados do período anterior, calcular variação
    if (previousPeriodData) {
      const previousInitialBalance = Number(previousPeriodData.summary.initialBalance);
      if (previousInitialBalance > 0) {
        const previousROI = (Number(previousPeriodData.summary.pnlMonth) / previousInitialBalance) * 100;
        const variation = currentROI - previousROI;
        return {
          value: variation >= 0 ? `+${variation.toFixed(1)}%` : `${variation.toFixed(1)}%`,
          trend: variation >= 0 ? 'up' : 'down'
        };
      }
    }
    
    // Se não houver comparação, mostrar o ROI atual como indicador
    if (currentROI !== 0) {
      return {
        value: currentROI >= 0 ? `+${currentROI.toFixed(1)}%` : `${currentROI.toFixed(1)}%`,
        trend: currentROI >= 0 ? 'up' : 'down'
      };
    }
    
    return null;
  };

  // Contar trades de hoje
  const getTodayTradesCount = () => {
    if (!data) return 0;
    const today = new Date().toISOString().slice(0, 10);
    return data.rows.filter(row => {
      const rowDate = new Date(row.executedAt).toISOString().slice(0, 10);
      return rowDate === today;
    }).length;
  };

  return (
    <InternalLayout>
      <div className="space-y-4 sm:space-y-6 lg:space-y-8">
      {/* Page Title */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl sm:text-3xl text-white mb-1 sm:mb-2">Dashboard</h2>
          <p className="text-sm sm:text-base text-slate-400">Visão geral dos seus trades</p>
        </div>
        <div className="relative w-full sm:w-auto">
          <button 
            onClick={() => setPeriodDropdownOpen(!periodDropdownOpen)}
            className="w-full sm:w-auto bg-white/10 hover:bg-white/15 text-white border border-white/20 px-3 sm:px-4 py-2 rounded-lg flex items-center justify-between gap-2 text-sm sm:text-base"
          >
            <span className="truncate">{getPeriodLabel()}</span>
            <span className={`transition-transform flex-shrink-0 ${periodDropdownOpen ? 'rotate-180' : ''}`}>⌄</span>
          </button>
          {periodDropdownOpen && (
            <>
              <div 
                className="fixed inset-0 z-10" 
                onClick={() => setPeriodDropdownOpen(false)}
              />
              <div className="absolute z-20 mt-1 right-0 sm:right-0 left-0 sm:left-auto w-full sm:w-48 bg-slate-800 border border-white/10 rounded-lg shadow-xl overflow-hidden">
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
                      period === option.value ? 'bg-blue-500/20 text-blue-400' : 'text-white'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {period === 'month-select' && monthSelectOpen && (
            <>
              <div 
                className="fixed inset-0 z-25" 
                onClick={() => {
                  setMonthSelectOpen(false);
                  if (!selectedMonth) {
                    setPeriod('month');
                  }
                }}
              />
              <div className="absolute top-full right-0 sm:right-0 left-0 sm:left-auto mt-2 z-30 bg-slate-800 border border-white/10 rounded-lg shadow-xl p-4 w-full sm:w-auto min-w-[200px]">
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
                className="fixed inset-0 z-25" 
                onClick={() => {
                  setCustomDateOpen(false);
                  if (!startDate || !endDate) {
                    setPeriod('month');
                  }
                }}
              />
              <div className="absolute top-full right-0 sm:right-0 left-0 sm:left-auto mt-2 z-30 bg-slate-800 border border-white/10 rounded-lg shadow-xl p-4 flex flex-col gap-2 w-full sm:w-auto min-w-[250px]">
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
      </div>

      {/* KPIs Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <EditableBalanceKpi
          label="Saldo Inicial"
          value={summary.initialBalance}
          icon="💳"
          color="purple"
          month={
            period === 'month-select' && selectedMonth 
              ? selectedMonth 
              : period === 'custom' && startDate
              ? startDate.substring(0, 7) // Extrai YYYY-MM da data inicial
              : period === 'year' 
                ? getMonth() 
                : (getPeriodFilter(period, earliestDate).month || getMonth())
          }
        />
        <Kpi 
          label="PnL Total" 
          value={`R$ ${Number(summary.pnlMonth).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} 
          icon="💰" 
          color="blue"
          trend={(() => {
            const trend = calculatePnLTrend();
            return trend ? trend.trend : (Number(summary.pnlMonth) >= 0 ? 'up' : 'down');
          })()}
          trendValue={(() => {
            const trend = calculatePnLTrend();
            if (trend) {
              console.log('PnL Trend calculated:', trend);
              return trend.value;
            }
            console.log('PnL Trend is null - data:', data?.summary, 'previousPeriodData:', previousPeriodData?.summary);
            // Se não houver comparação, não mostrar nada (ou podemos mostrar o valor absoluto)
            return undefined;
          })()}
          subValue={
            (loadingBalance || loadingInitialBalance)
              ? <span className="text-slate-400 animate-pulse">Carregando...</span>
              : calculatePnLBinance()
          }
        />
        <Kpi 
          label="ROI Acumulado" 
          value={summary.initialBalance !== '0' 
            ? `${((Number(summary.pnlMonth) / Number(summary.initialBalance)) * 100).toFixed(2)}%`
            : '0,00%'
          } 
          icon="📈" 
          color="green"
          trend={(() => {
            const trend = calculateROITrend();
            return trend ? trend.trend : (Number(summary.pnlMonth) >= 0 ? 'up' : 'down');
          })()}
          trendValue={(() => {
            const trend = calculateROITrend();
            return trend ? trend.value : undefined;
          })()}
          subValue={
            (loadingBalance || loadingInitialBalance)
              ? <span className="text-slate-400 animate-pulse">Carregando...</span>
              : calculateROIBinance()
          }
        />
        <Kpi 
          label="Total de Trades" 
          value={summary.tradesCount} 
          icon="📊" 
          color="orange"
          trend={getTodayTradesCount() > 0 ? 'up' : 'neutral'}
          trendValue={getTodayTradesCount() > 0 ? `+${getTodayTradesCount()} hoje` : undefined}
        />
      </div>

      {/* PnL Chart */}
      <Card title="PnL Diário" icon="📊" subtitle="Evolução do lucro/prejuízo">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-4 mb-4">
          <div className="text-sm text-slate-400">Últimos 30 dias</div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-xs text-slate-400">Hoje</p>
              <p className={`flex items-center gap-1 text-sm sm:text-base ${todayPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                <span>{todayPnl >= 0 ? '↗️' : '↘️'}</span>
                R$ {Math.abs(todayPnl).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
          </div>
        </div>
        {daily.length > 0 ? (
          <div className="w-full overflow-x-auto">
            <div className="min-w-[600px]">
              <PnlLineChart data={daily} />
            </div>
          </div>
        ) : (
          <div className="h-64 sm:h-96 flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl">
            <div className="text-center px-4">
              <div className="text-4xl sm:text-6xl mb-4">📊</div>
              <h3 className="text-base sm:text-lg font-semibold text-slate-300 mb-2">Nenhum dado disponível</h3>
              <p className="text-sm sm:text-base text-slate-500">Adicione trades para ver o gráfico de PnL</p>
            </div>
          </div>
        )}
      </Card>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="relative overflow-hidden rounded-xl border-white/10 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 backdrop-blur-sm hover:from-emerald-500/20 hover:to-emerald-500/10 transition-all duration-300 cursor-pointer group">
          <div className="p-6 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-emerald-500 flex items-center justify-center group-hover:scale-110 transition-transform">
              <span className="text-white text-xl">📈</span>
            </div>
            <div>
              <p className="text-white">Nova Operação</p>
              <p className="text-sm text-slate-400">Registrar trade</p>
            </div>
          </div>
        </div>

        <div className="relative overflow-hidden rounded-xl border-white/10 bg-gradient-to-br from-blue-500/10 to-blue-500/5 backdrop-blur-sm hover:from-blue-500/20 hover:to-blue-500/10 transition-all duration-300 cursor-pointer group">
          <div className="p-6 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-500 flex items-center justify-center group-hover:scale-110 transition-transform">
              <span className="text-white text-xl">📊</span>
            </div>
            <div>
              <p className="text-white">Análise Detalhada</p>
              <p className="text-sm text-slate-400">Ver relatório</p>
            </div>
          </div>
        </div>

        <div className="relative overflow-hidden rounded-xl border-white/10 bg-gradient-to-br from-purple-500/10 to-purple-500/5 backdrop-blur-sm hover:from-purple-500/20 hover:to-purple-500/10 transition-all duration-300 cursor-pointer group">
          <div className="p-6 flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-purple-500 flex items-center justify-center group-hover:scale-110 transition-transform">
              <span className="text-white text-xl">💰</span>
            </div>
            <div>
              <p className="text-white">Gerenciar Carteira</p>
              <p className="text-sm text-slate-400">Adicionar fundos</p>
            </div>
          </div>
        </div>
      </div>
      </div>
    </InternalLayout>
  );
}



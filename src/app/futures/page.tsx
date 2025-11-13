"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { Toolbar } from '@/components/Toolbar';
import InternalLayout from '@/components/InternalLayout';
import { auth } from '@/lib/firebase/client';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';

// Estender Window para incluir __syncPollInterval e __tradesImportPollInterval
declare global {
  interface Window {
    __syncPollInterval?: NodeJS.Timeout | null;
    __tradesImportPollInterval?: NodeJS.Timeout | null;
  }
}

type TradeRow = {
  executedAt: string;
  exchange: string;
  market: string;
  symbol: string;
  side: string;
  qty: string;
  price: string;
  feeValue: string;
  feeAsset: string;
  feePct: string;
  realizedPnl: string;
  orderId?: string;
  tradeId?: string;
  orderType?: string | null;
};

// Função para calcular ROI por trade (simplificado)
function calculateTradeROI(realizedPnl: string, qty: string, price: string): number {
  const pnl = Number(realizedPnl || 0);
  const quantity = Number(qty || 0);
  const tradePrice = Number(price || 0);
  const tradeValue = quantity * tradePrice;
  return tradeValue === 0 ? 0 : (pnl / tradeValue) * 100;
}

// Função para formatar valores
function formatCurrency(value: string | number): string {
  const num = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', { 
    style: 'currency', 
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
}

function formatPercentage(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

// Função para calcular drawdown (maior sequência de perdas)
function calculateDrawdown(trades: TradeRow[]): { maxDrawdown: number; currentDrawdown: number } {
  let maxDrawdown = 0;
  let currentDrawdown = 0;
  let peak = 0;
  let runningPnL = 0;

  for (const trade of trades) {
    runningPnL += Number(trade.realizedPnl);
    if (runningPnL > peak) {
      peak = runningPnL;
      currentDrawdown = 0;
    } else {
      currentDrawdown = peak - runningPnL;
      if (currentDrawdown > maxDrawdown) {
        maxDrawdown = currentDrawdown;
      }
    }
  }

  return { maxDrawdown, currentDrawdown };
}

// Função para calcular volume total
function calculateVolume(qty: string, price: string): number {
  return Number(qty || 0) * Number(price || 0);
}

function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
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

export default function FuturesPage() {
  const month = getMonth();
  const [period, setPeriod] = useState('month');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedMonth, setSelectedMonth] = useState('');
  // Market fixo em FUTURES para esta página
  const market = 'FUTURES';
  const [symbol, setSymbol] = useState('');
  const [availableSymbols, setAvailableSymbols] = useState<string[]>([]);
  const [loadingFilters, setLoadingFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<TradeRow[]>([]);
  const [summary, setSummary] = useState<{
    pnlMonth: string;
    feesTotal: string;
    avgFeePct: string;
    tradesCount: number;
    winRate: number;
    initialBalance: string;
    bestTrade: string;
    worstTrade: string;
    totalVolume: string;
    maxDrawdown: string;
    currentDrawdown: string;
    winningTrades: number;
    losingTrades: number;
  } | null>(null);
  const [expandedOrders, setExpandedOrders] = useState<Record<string, boolean>>({});
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncStartDate, setSyncStartDate] = useState(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
  const [syncEndDate, setSyncEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [syncSymbols, setSyncSymbols] = useState('BTCBRL\nETHBRL\nBNBBRL');
  const [showRecalcModal, setShowRecalcModal] = useState(false);
  const [recalcStartDate, setRecalcStartDate] = useState('');
  const [recalcEndDate, setRecalcEndDate] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePeriod, setDeletePeriod] = useState('month');
  const [deleteStartDate, setDeleteStartDate] = useState('');
  const [deleteEndDate, setDeleteEndDate] = useState('');
  const [deleteSelectedMonth, setDeleteSelectedMonth] = useState('');
  const [deleteMarket, setDeleteMarket] = useState('');
  const [deleteSymbol, setDeleteSymbol] = useState('');
  const [deletePeriodDropdownOpen, setDeletePeriodDropdownOpen] = useState(false);
  const [deleteMonthSelectOpen, setDeleteMonthSelectOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [periodDropdownOpen, setPeriodDropdownOpen] = useState(false);
  const [customDateOpen, setCustomDateOpen] = useState(false);
  const [monthSelectOpen, setMonthSelectOpen] = useState(false);
  const [pageSizeDropdownOpen, setPageSizeDropdownOpen] = useState(false);
  const [earliestDate, setEarliestDate] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<{
    jobId: string | null;
    percent: number;
    message: string;
    status: 'running' | 'completed' | 'error';
    result?: { inserted: number; updated: number };
    error?: string;
  } | null>(null);
  const [recalcProgress, setRecalcProgress] = useState<{
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
  const [accounts, setAccounts] = useState<{ id: string; name: string; market?: string }[]>([]);
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

  // Buscar symbols disponíveis apenas para FUTURES
  useEffect(() => {
    const fetchFilters = async () => {
      const user = auth.currentUser;
      if (!user) return;

      setLoadingFilters(true);
      try {
        const token = await user.getIdToken();
        const response = await fetch('/api/trades/filters?market=FUTURES', {
          headers: {
            Authorization: `Bearer ${token}`
          }
        });

        if (response.ok) {
          const data = await response.json();
          setAvailableSymbols(data.symbols || []);
        }
      } catch (error) {
        console.error('Error fetching filters:', error);
      } finally {
        setLoadingFilters(false);
      }
    };

    fetchFilters();
  }, []);

  const [incompleteJobs, setIncompleteJobs] = useState<Array<{
    jobId: string;
    currentStep: number;
    totalSteps: number;
    message: string | null;
    updatedAt: string;
  }>>([]);

  // Buscar contas e jobs incompletos quando o modal de importação for aberto
  useEffect(() => {
    if (!showImportModal) return; // Só buscar quando o modal estiver aberto

    const fetchData = async () => {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      
      // Buscar contas
      try {
        const res = await fetch('/api/accounts', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (res.ok) {
          const data = await res.json();
          const accountsList = data.results || [];
          setAccounts(accountsList);
          
          if (accountsList.length > 0 && !importAccountId) {
            setImportAccountId(accountsList[0].id);
          }
        }
      } catch (error) {
        console.error('Error fetching accounts:', error);
      }

      // Buscar jobs incompletos (erro ou running há muito tempo)
      try {
        const jobsRes = await fetch('/api/jobs/stuck?all=true', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (jobsRes.ok) {
          const jobsData = await jobsRes.json();
          // Filtrar apenas jobs de importação CSV (pode identificar pela message)
          type Job = {
            jobId: string;
            message?: string | null;
            currentStep?: number;
            totalSteps?: number;
            updatedAt?: string;
          };
          const importJobs = ((jobsData.jobs || []) as Job[]).filter((job) => 
            job.message?.includes('Processando linha') || 
            job.message?.includes('Importação') ||
            job.message?.includes('CSV')
          ).map((job) => ({
            jobId: job.jobId,
            currentStep: job.currentStep || 0,
            totalSteps: job.totalSteps || 0,
            message: job.message || null,
            updatedAt: job.updatedAt ? (typeof job.updatedAt === 'string' ? job.updatedAt : new Date(job.updatedAt).toISOString()) : new Date().toISOString(),
          }));
          setIncompleteJobs(importJobs);
        }
      } catch (error) {
        console.error('Error fetching incomplete jobs:', error);
      }
    };

    fetchData();
  }, [showImportModal]); // Buscar sempre que o modal for aberto

  useEffect(() => {
    const fetchData = async () => {
      // Lógica igual ao dashboard
      let currentMonth: string;
      let useStartEnd = false;
      
      if (period === 'custom' && startDate && endDate) {
        // Período customizado: usar startDate e endDate
        currentMonth = `${startDate}_${endDate}`;
        useStartEnd = true;
      } else if (period === 'month-select' && selectedMonth) {
        // Mês selecionado: usar o mês escolhido
        currentMonth = selectedMonth;
      } else {
        // Outros períodos: usar getPeriodFilter (passar earliestDate para 'all')
        const periodFilter = getPeriodFilter(period, earliestDate);
        currentMonth = periodFilter.month || month;
        if (periodFilter.startDate && periodFilter.endDate) {
          useStartEnd = true;
        }
      }
      
      type ApiTrade = {
        executedAt: string | Date;
        exchange: string;
        market: string;
        symbol: string;
        side: string;
        qty: string;
        price: string;
        feeValue: string;
        feeAsset: string;
        feePct: string;
        realizedPnl: string;
        orderId?: string | null;
        tradeId?: string | null;
        orderType?: string | null;
      };
      type ApiResponse = {
        total: number;
        rows: ApiTrade[];
        summary: {
          pnlMonth: string;
          feesTotal: string;
          avgFeePct: string;
          tradesCount: number;
          winRate: number;
          initialBalance: string;
          bestTrade: string;
          worstTrade: string;
          totalVolume: string;
          maxDrawdown: string;
          currentDrawdown: string;
          winningTrades: number;
          losingTrades: number;
        };
      };
      const params = new URLSearchParams({ month: currentMonth, page: String(page), pageSize: String(pageSize) });
      // Sempre filtrar por FUTURES
      params.set('market', 'FUTURES');
      if (symbol) params.set('symbol', symbol);
      if (useStartEnd) {
        if (period === 'custom' && startDate && endDate) {
          params.set('startDate', startDate);
          params.set('endDate', endDate);
        } else {
          const periodFilter = getPeriodFilter(period, earliestDate);
          if (periodFilter.startDate && periodFilter.endDate) {
            params.set('startDate', periodFilter.startDate);
            params.set('endDate', periodFilter.endDate);
          }
        }
      }
      
      // Adicionar token de autenticação
      const user = auth.currentUser;
      if (!user) return;
      
      const token = await user.getIdToken();
      fetch(`/api/trades?${params.toString()}`, { 
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${token}`
        }
      })
        .then((r) => r.json())
        .then((d: ApiResponse) => {
          setTotal(d.total);
          setSummary(d.summary);
          setRows(
            d.rows.map((t: ApiTrade) => ({
              executedAt: new Date(t.executedAt).toISOString(),
              exchange: t.exchange,
              market: t.market,
              symbol: t.symbol,
              side: t.side,
              qty: t.qty,
              price: t.price,
              feeValue: t.feeValue,
              feeAsset: t.feeAsset,
              feePct: t.feePct,
              realizedPnl: t.realizedPnl,
              orderId: t.orderId ?? undefined,
              tradeId: t.tradeId ?? undefined,
              orderType: t.orderType ?? null,
            }))
          );
        });
    };
    
    fetchData();
  }, [month, period, startDate, endDate, selectedMonth, symbol, page, pageSize, earliestDate]);

  const handleExportCSV = async () => {
    const user = auth.currentUser;
    if (!user) return;
    
    const token = await user.getIdToken();
    let currentMonth: string;
    let useStartEnd = false;
    
    if (period === 'custom' && startDate && endDate) {
      currentMonth = `${startDate}_${endDate}`;
      useStartEnd = true;
    } else if (period === 'month-select' && selectedMonth) {
      currentMonth = selectedMonth;
    } else {
      const periodFilter = getPeriodFilter(period, earliestDate);
      currentMonth = periodFilter.month || month;
      if (periodFilter.startDate && periodFilter.endDate) {
        useStartEnd = true;
      }
    }
    
    const params = new URLSearchParams({ month: currentMonth });
    // Sempre filtrar por FUTURES
    params.set('market', 'FUTURES');
    if (symbol) params.set('symbol', symbol);
    if (useStartEnd) {
      if (period === 'custom' && startDate && endDate) {
        params.set('startDate', startDate);
        params.set('endDate', endDate);
      } else {
        const periodFilter = getPeriodFilter(period);
        if (periodFilter.startDate && periodFilter.endDate) {
          params.set('startDate', periodFilter.startDate);
          params.set('endDate', periodFilter.endDate);
        }
      }
    }
    
    try {
      const response = await fetch(`/api/export/csv?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trades_${currentMonth}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch {
      alert('Erro ao exportar CSV');
    }
  };

  const handleExportPDF = async () => {
    const user = auth.currentUser;
    if (!user) return;
    
    const token = await user.getIdToken();
    let currentMonth: string;
    let useStartEnd = false;
    
    if (period === 'custom' && startDate && endDate) {
      currentMonth = `${startDate}_${endDate}`;
      useStartEnd = true;
    } else if (period === 'month-select' && selectedMonth) {
      currentMonth = selectedMonth;
    } else {
      const periodFilter = getPeriodFilter(period, earliestDate);
      currentMonth = periodFilter.month || month;
      if (periodFilter.startDate && periodFilter.endDate) {
        useStartEnd = true;
      }
    }
    
    const params = new URLSearchParams({ month: currentMonth });
    // Sempre filtrar por FUTURES
    params.set('market', 'FUTURES');
    if (symbol) params.set('symbol', symbol);
    if (useStartEnd) {
      if (period === 'custom' && startDate && endDate) {
        params.set('startDate', startDate);
        params.set('endDate', endDate);
      } else {
        const periodFilter = getPeriodFilter(period);
        if (periodFilter.startDate && periodFilter.endDate) {
          params.set('startDate', periodFilter.startDate);
          params.set('endDate', periodFilter.endDate);
        }
      }
    }
    
    try {
      const response = await fetch(`/api/export/pdf?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trades_${currentMonth}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch {
      alert('Erro ao exportar PDF');
    }
  };

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

      const response = await fetch('/api/trades/import-csv', {
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

        window.__tradesImportPollInterval = pollInterval;
      } else {
        alert('Erro: jobId não retornado');
      }
    } catch (error) {
      alert(`Erro ao importar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
      setImportProgress(null);
    }
  };

  const recalculatePnL = async () => {
    try {
      const user = auth.currentUser;
      if (!user) return;
      
      const token = await user.getIdToken();
      const response = await fetch('/api/jobs/recalculate-pnl', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          startDate: recalcStartDate || undefined,
          endDate: recalcEndDate || undefined
        })
      });
      
      const result = await response.json();
      
      if (result.error) {
        alert(`Erro: ${result.error}`);
        return;
      }

      if (result.jobId) {
        setRecalcProgress({
          jobId: result.jobId,
          percent: 0,
          message: 'Iniciando recálculo de PnL...',
          status: 'running'
        });

        let pollInterval: NodeJS.Timeout | null = null;
        pollInterval = setInterval(async () => {
          try {
            const statusResponse = await fetch(`/api/jobs/sync-status?jobId=${result.jobId}`, {
              headers: {
                Authorization: `Bearer ${token}`
              }
            });
            const status = await statusResponse.json();

            if (status.error) {
              if (pollInterval) clearInterval(pollInterval);
              setRecalcProgress(null);
              alert(`Erro: ${status.error}`);
              return;
            }

            setRecalcProgress({
              jobId: status.jobId,
              percent: status.percent || 0,
              message: status.message || 'Processando...',
              status: status.status,
              result: status.result,
              error: status.error
            });

            if (status.status === 'completed') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                if (status.result) {
                  alert(`PnL recalculado! ${status.result.updated || 0} trades atualizados.`);
                }
                setRecalcProgress(null);
                setShowRecalcModal(false);
                window.location.reload();
              }, 2000);
            } else if (status.status === 'error') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                alert(`Erro no recálculo: ${status.error || 'Erro desconhecido'}`);
                setRecalcProgress(null);
              }, 2000);
            }
          } catch (error) {
            console.error('Error polling status:', error);
            if (pollInterval) clearInterval(pollInterval);
          }
        }, 1000);
        window.__syncPollInterval = pollInterval;
      } else {
        alert('Erro: jobId não retornado');
      }
    } catch (error) {
      alert(`Erro ao recalcular PnL: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
      setRecalcProgress(null);
    }
  };

  const [loadingSymbols, setLoadingSymbols] = useState(false);
  const [symbolsProgress, setSymbolsProgress] = useState<{
    jobId: string;
    percent: number;
    message: string;
    status: 'running' | 'completed' | 'error';
    estimatedTime?: string;
    currentStep?: number;
    totalSteps?: number;
    result?: { inserted: number; updated: number };
    error?: string;
  } | null>(null);

  const fetchTradedSymbols = async (includeApi: boolean = false, searchAll: boolean = false) => {
    try {
      const user = auth.currentUser;
      if (!user) return;
      
      if (searchAll) {
        const confirmSearch = confirm(
          '⚠️ ATENÇÃO: Buscar TODOS os pares pode demorar vários minutos e fazer muitas requisições à API da Binance.\n\n' +
          'Deseja continuar?'
        );
        if (!confirmSearch) return;
      }
      
      setLoadingSymbols(true);
      
      const token = await user.getIdToken();
      const params = new URLSearchParams();
      if (includeApi) {
        params.set('includeApi', 'true');
        if (searchAll) {
          params.set('searchAll', 'true');
        }
        // Passar as datas do modal de sincronização
        if (syncStartDate) {
          params.set('startDate', syncStartDate);
        }
        if (syncEndDate) {
          params.set('endDate', syncEndDate);
        }
      }
      const url = `/api/symbols?${params.toString()}`;
      
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      
      if (!response.ok) {
        alert('Erro ao buscar pares negociados');
        setLoadingSymbols(false);
        return;
      }
      
      const data = await response.json();
      
      // Se não for busca da API, retornar imediatamente
      if (!includeApi) {
        if (data.symbols && data.symbols.length > 0) {
          setSyncSymbols(data.symbols.join('\n'));
          alert(`✅ Encontrados ${data.count} pares negociados do banco de dados!`);
        } else {
          alert('Nenhum par negociado encontrado. Tente buscar também da API.');
        }
        setLoadingSymbols(false);
        return;
      }
      
      // Se for busca da API, iniciar polling do progresso
      if (data.jobId) {
        setSymbolsProgress({
          jobId: data.jobId,
          percent: 0,
          message: 'Iniciando busca de símbolos...',
          status: 'running'
        });

        // Polling do progresso
        let pollInterval: NodeJS.Timeout | null = null;
        pollInterval = setInterval(async () => {
          try {
            const statusResponse = await fetch(`/api/symbols?jobId=${data.jobId}`, {
              headers: {
                Authorization: `Bearer ${token}`
              }
            });
            const status = await statusResponse.json();

            if (status.error) {
              if (pollInterval) clearInterval(pollInterval);
              setSymbolsProgress(null);
              setLoadingSymbols(false);
              alert(`Erro: ${status.error}`);
              return;
            }

            setSymbolsProgress({
              jobId: status.jobId,
              percent: status.percent || 0,
              message: status.message || 'Processando...',
              status: status.status,
              estimatedTime: status.estimatedTime,
              currentStep: status.currentStep,
              totalSteps: status.totalSteps,
              result: status.result,
              error: status.error
            });

            if (status.status === 'completed') {
              if (pollInterval) clearInterval(pollInterval);
              
              // Buscar símbolos do resultado final
              // Como os símbolos não estão no progresso, vamos buscar novamente sem API
              const finalResponse = await fetch('/api/symbols', {
                headers: {
                  Authorization: `Bearer ${token}`
                }
              });
              
              if (finalResponse.ok) {
                const finalData = await finalResponse.json();
                if (finalData.symbols && finalData.symbols.length > 0) {
                  setSyncSymbols(finalData.symbols.join('\n'));
                  let message = '';
                  if (status.result && status.result.inserted > 0) {
                    message = `✅ Busca concluída! Encontrados ${finalData.symbols.length} pares negociados (${finalData.dbCount || 0} do banco + ${status.result.inserted} da API)`;
                  } else {
                    message = `✅ Busca concluída! Encontrados ${finalData.symbols.length} pares negociados`;
                  }
                  alert(message);
                }
              }
              
              setTimeout(() => {
                setSymbolsProgress(null);
                setLoadingSymbols(false);
              }, 2000);
            } else if (status.status === 'error') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                alert(`Erro na busca: ${status.error || 'Erro desconhecido'}`);
                setSymbolsProgress(null);
                setLoadingSymbols(false);
              }, 2000);
            }
          } catch (error) {
            console.error('Error polling symbol status:', error);
            if (pollInterval) clearInterval(pollInterval);
            setSymbolsProgress(null);
            setLoadingSymbols(false);
          }
        }, 1000); // Poll a cada 1 segundo
      } else {
        // Fallback para resposta direta (caso não use jobId)
        if (data.symbols && data.symbols.length > 0) {
          setSyncSymbols(data.symbols.join('\n'));
          let message = '';
          if (includeApi && data.apiCount > 0) {
            if (searchAll) {
              message = `✅ Encontrados ${data.count} pares negociados! (${data.dbCount} do banco + ${data.apiCount} da API - busca completa)`;
            } else {
              message = `✅ Encontrados ${data.count} pares negociados! (${data.dbCount} do banco + ${data.apiCount} da API - apenas comuns)`;
            }
          } else {
            message = `✅ Encontrados ${data.count} pares negociados do banco de dados!`;
          }
          alert(message);
        } else {
          alert('Nenhum par negociado encontrado. Tente buscar também da API.');
        }
        setLoadingSymbols(false);
      }
    } catch (error) {
      console.error('Error fetching symbols:', error);
      alert('Erro ao buscar pares negociados');
      setLoadingSymbols(false);
      setSymbolsProgress(null);
    }
  };

  const syncTrades = async () => {
    try {
      const user = auth.currentUser;
      if (!user) return;
      
      const token = await user.getIdToken();
      const symbolsArray = syncSymbols.split('\n').filter(s => s.trim());
      const response = await fetch('/api/jobs/sync-all', { 
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          startDate: syncStartDate, 
          endDate: syncEndDate,
          symbols: symbolsArray 
        })
      });
      const result = await response.json();
      
      if (result.error) {
        alert(`Erro: ${result.error}`);
        return;
      }

      if (result.jobId) {
        // Iniciar polling do progresso
        setSyncProgress({
          jobId: result.jobId,
          percent: 0,
          message: 'Iniciando sincronização...',
          status: 'running'
        });

        // Polling do progresso
        let pollInterval: NodeJS.Timeout | null = null;
        pollInterval = setInterval(async () => {
          try {
            const statusResponse = await fetch(`/api/jobs/sync-status?jobId=${result.jobId}`, {
              headers: {
                Authorization: `Bearer ${token}`
              }
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
              error: status.error
            });

            if (status.status === 'completed') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                if (status.result) {
                  let message = `Sucesso! `;
                  if (status.result.inserted > 0) message += `${status.result.inserted} novos trades inseridos`;
                  if (status.result.inserted > 0 && status.result.updated > 0) message += ` e `;
                  if (status.result.updated > 0) message += `${status.result.updated} trades atualizados`;
                  alert(message);
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
        }, 1000); // Poll a cada 1 segundo

        // Armazenar cleanup no estado para poder limpar depois
        window.__syncPollInterval = pollInterval;
      } else {
        alert('Erro: jobId não retornado');
      }
    } catch (error) {
      alert(`Erro ao sincronizar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
      setSyncProgress(null);
    }
  };

  // Tipos auxiliares para exibição agrupada
  type DisplayRow = TradeRow & { _isGroup?: boolean; _isChild?: boolean; _childrenCount?: number };

  // Agrupar por orderId quando houver multiplas execucoes
  // Também agrupar trades sem orderId mas com características similares (mesmo timestamp+symbol+side+price+qty)
  const groupedRows: DisplayRow[] = useMemo(() => {
    const byOrder: Record<string, TradeRow[]> = {};
    const byUniqueKey: Record<string, TradeRow[]> = {}; // Para trades sem orderId
    
    for (const r of rows) {
      if (r.orderId) {
        // Agrupar por orderId
        if (!byOrder[r.orderId]) byOrder[r.orderId] = [];
        byOrder[r.orderId].push(r);
      } else {
        // Agrupar por chave única (timestamp+symbol+side+price+qty)
        const timestamp = Math.floor(new Date(r.executedAt).getTime() / 1000);
        const price = parseFloat(r.price || '0').toFixed(8);
        const qty = parseFloat(r.qty || '0').toFixed(8);
        const uniqueKey = `${timestamp}_${r.symbol}_${r.side}_${price}_${qty}`;
        
        if (!byUniqueKey[uniqueKey]) byUniqueKey[uniqueKey] = [];
        byUniqueKey[uniqueKey].push(r);
      }
    }

    const out: DisplayRow[] = [];
    const emitted = new Set<string>();
    const emittedUniqueKeys = new Set<string>();

    for (const r of rows) {
      // Agrupar por orderId (prioridade)
      if (r.orderId && byOrder[r.orderId] && byOrder[r.orderId].length > 1) {
        if (emitted.has(r.orderId)) continue;
        const children = byOrder[r.orderId].slice().sort((a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime());
        const totalQty = children.reduce((s, x) => s + Number(x.qty || 0), 0);
        const totalVol = children.reduce((s, x) => s + Number(x.qty || 0) * Number(x.price || 0), 0);
        const avgPrice = totalQty > 0 ? totalVol / totalQty : 0;
        const totalFees = children.reduce((s, x) => s + Number(x.feeValue || 0), 0);
        const totalPnl = children.reduce((s, x) => s + Number(x.realizedPnl || 0), 0);
        const first = children[0];
        const parent: DisplayRow = {
          ...first,
          qty: String(totalQty),
          price: String(avgPrice),
          feeValue: String(totalFees),
          realizedPnl: String(totalPnl),
          _isGroup: true,
          _childrenCount: children.length,
        };
        out.push(parent);
        if (expandedOrders[first.orderId!]) {
          for (const c of children) out.push({ ...c, _isChild: true });
        }
        emitted.add(first.orderId!);
      } 
      // Agrupar por chave única (trades sem orderId mas duplicadas)
      else if (!r.orderId) {
        const timestamp = Math.floor(new Date(r.executedAt).getTime() / 1000);
        const price = parseFloat(r.price || '0').toFixed(8);
        const qty = parseFloat(r.qty || '0').toFixed(8);
        const uniqueKey = `${timestamp}_${r.symbol}_${r.side}_${price}_${qty}`;
        
        if (byUniqueKey[uniqueKey] && byUniqueKey[uniqueKey].length > 1) {
          if (emittedUniqueKeys.has(uniqueKey)) continue;
          const children = byUniqueKey[uniqueKey].slice().sort((a, b) => new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime());
          const totalQty = children.reduce((s, x) => s + Number(x.qty || 0), 0);
          const totalVol = children.reduce((s, x) => s + Number(x.qty || 0) * Number(x.price || 0), 0);
          const avgPrice = totalQty > 0 ? totalVol / totalQty : 0;
          const totalFees = children.reduce((s, x) => s + Number(x.feeValue || 0), 0);
          const totalPnl = children.reduce((s, x) => s + Number(x.realizedPnl || 0), 0);
          const first = children[0];
          const parent: DisplayRow = {
            ...first,
            qty: String(totalQty),
            price: String(avgPrice),
            feeValue: String(totalFees),
            realizedPnl: String(totalPnl),
            _isGroup: true,
            _childrenCount: children.length,
            orderId: `DUP_${uniqueKey.slice(0, 16)}`, // ID temporário para agrupamento
          };
          out.push(parent);
          if (expandedOrders[parent.orderId!]) {
            for (const c of children) out.push({ ...c, _isChild: true });
          }
          emittedUniqueKeys.add(uniqueKey);
        } else {
          out.push({ ...r });
        }
      } else {
        out.push({ ...r });
      }
    }
    return out;
  }, [rows, expandedOrders]);

  const columnHelper = createColumnHelper<DisplayRow>();
  const columns = useMemo(
    () => [
      columnHelper.accessor('executedAt', { 
        header: '📅 Data/Hora',
        cell: ({ getValue }) => formatDateTime(getValue())
      }),
      columnHelper.accessor('orderId', {
        header: '🧾 Ordem',
        cell: ({ row, getValue }) => {
          const data = row.original;
          if (data._isGroup) {
            const expanded = !!expandedOrders[data.orderId as string];
            return (
              <span className="font-mono text-blue-300">
                {getValue() || '-'} ({data._childrenCount} exec.) {expanded ? '▾' : '▸'}
              </span>
            );
          }
          return (
            <span className={`font-mono text-xs ${data._isChild ? 'text-slate-400 pl-4' : 'text-slate-300'}`}>
              {data._isChild ? '↳ ' : ''}{getValue() || '-'}
            </span>
          );
        },
      }),
      columnHelper.accessor('symbol', { 
        header: '💰 Par Moeda',
        cell: ({ getValue, row }) => (
          <span className={`font-mono font-semibold text-blue-400 ${row.original._isChild ? 'opacity-70' : ''}`}>
            {getValue()}
          </span>
        )
      }),
      columnHelper.accessor('side', { 
        header: '📊 Operação',
        cell: ({ getValue }) => {
          const side = getValue();
          const isBuy = side === 'BUY' || side === 'LONG';
          return (
            <span className={`px-2 py-1 rounded text-xs font-semibold ${
              isBuy ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'
            }`}>
              {side}
            </span>
          );
        }
      }),
      columnHelper.display({
        id: 'orderInfo',
        header: '📋 Tipo de Ordem',
        cell: ({ row }) => {
          const data = row.original;
          const orderType = data.orderType;
          
          // Se não tiver orderType, mostrar "-"
          if (!orderType || orderType === '-') {
            return (
              <div className="flex flex-col gap-1">
                <span className="px-2 py-1 rounded text-xs font-semibold bg-slate-500/20 text-slate-400 border border-slate-500/30">
                  -
                </span>
                <span className="text-xs text-slate-400 font-mono">
                  {data.market}
                </span>
              </div>
            );
          }
          
          // Mapear tipos de ordem para labels mais amigáveis
          const orderTypeLabels: Record<string, string> = {
            'LIMIT': 'Limite',
            'MARKET': 'Mercado',
            'STOP_LOSS': 'Stop Loss',
            'STOP_MARKET': 'Stop Mercado',
            'TAKE_PROFIT': 'Take Profit',
            'TAKE_PROFIT_MARKET': 'TP Mercado',
          };
          
          const label = orderTypeLabels[orderType] || orderType;
          
          // Cores diferentes para cada tipo
          const getOrderTypeColor = (type: string) => {
            if (type === 'LIMIT') return 'bg-blue-500/20 text-blue-400 border border-blue-500/30';
            if (type === 'MARKET') return 'bg-green-500/20 text-green-400 border border-green-500/30';
            if (type?.includes('STOP')) return 'bg-red-500/20 text-red-400 border border-red-500/30';
            if (type?.includes('TAKE_PROFIT')) return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
            return 'bg-slate-500/20 text-slate-400 border border-slate-500/30';
          };
          
          return (
            <div className="flex flex-col gap-1">
              <span className={`px-2 py-1 rounded text-xs font-semibold ${getOrderTypeColor(orderType)}`}>
                {label}
              </span>
              <span className="text-xs text-slate-400 font-mono">
                {data.market}
              </span>
            </div>
          );
        }
      }),
      columnHelper.accessor('price', { 
        header: '💵 Preço',
        cell: ({ getValue, row }) => (
          <span className={`font-mono whitespace-nowrap ${row.original._isGroup ? 'font-semibold' : ''}`}>{formatCurrency(getValue())}</span>
        )
      }),
      columnHelper.accessor('feeValue', { 
        header: '💸 Taxa',
        cell: ({ getValue, row }) => (
          <div className="text-sm">
            <div className={`font-mono whitespace-nowrap ${row.original._isGroup ? 'font-semibold' : ''}`}>{formatCurrency(getValue())}</div>
            <div className="text-xs text-gray-500">{row.original.feeAsset}</div>
          </div>
        )
      }),
      columnHelper.display({
        id: 'volume',
        header: '💎 Volume',
        cell: ({ row }) => {
          const volume = calculateVolume(row.original.qty, row.original.price);
          return (
            <span className={`font-mono font-semibold text-purple-400 whitespace-nowrap ${row.original._isGroup ? 'underline' : ''}`}>
              {formatCurrency(volume)}
            </span>
          );
        }
      }),
      columnHelper.accessor('realizedPnl', { 
        header: '📊 PnL',
        cell: ({ getValue }) => {
          const pnl = Number(getValue());
          return (
            <span className={`font-semibold whitespace-nowrap ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatCurrency(pnl)}
            </span>
          );
        }
      }),
      columnHelper.display({
        id: 'roi',
        header: '🎯 ROI',
        cell: ({ row }) => {
          const roi = calculateTradeROI(row.original.realizedPnl, row.original.qty, row.original.price);
          return (
            <span className={`font-semibold whitespace-nowrap ${roi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {formatPercentage(roi)}
            </span>
          );
        }
      }),
      columnHelper.accessor('market', { 
        header: '🏪 Mercado',
        cell: ({ getValue }) => (
          <span className="px-2 py-1 bg-white/10 text-white rounded text-xs">
            {getValue()}
          </span>
        )
      }),
      columnHelper.accessor('tradeId', { 
        header: '🆔 Trade ID',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs text-slate-400">
            {getValue()?.slice(-8) || '-'}
          </span>
        )
      }),
    ],
    [columnHelper, expandedOrders]
  );

  const table = useReactTable({ data: groupedRows, columns, getCoreRowModel: getCoreRowModel() });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <InternalLayout>
      <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl text-white mb-1 sm:mb-2">Futuros</h1>
          <p className="text-sm sm:text-base text-slate-400">Histórico detalhado de operações futuras</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button 
            onClick={async () => {
              const user = auth.currentUser;
              if (!user) return;
              
              const confirmDedup = confirm(
                '⚠️ Remover trades duplicadas?\n\n' +
                'Isso irá:\n' +
                '1. Remover duplicatas por Order ID (manter a mais recente)\n' +
                '2. Remover duplicatas por Trade ID (manter a mais recente)\n' +
                '3. Remover duplicatas por características similares (timestamp+symbol+side+price+qty)\n\n' +
                'Esta ação não pode ser desfeita!'
              );
              
              if (!confirmDedup) return;
              
              try {
                const token = await user.getIdToken();
                const response = await fetch('/api/trades/deduplicate', {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${token}`,
                  },
                });
                
                const result = await response.json();
                
                if (response.ok) {
                  alert(`✅ ${result.message}\n\nRemovidas ${result.deleted} trades duplicadas de ${result.duplicatesFound} encontradas.`);
                  window.location.reload();
                } else {
                  alert(`Erro: ${result.error || result.message || 'Erro desconhecido'}`);
                }
              } catch (error) {
                alert(`Erro ao remover duplicatas: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
              }
            }}
            className="bg-white/10 hover:bg-white/20 text-white text-sm py-1.5 px-3 rounded-lg transition-colors"
            title="Remover trades duplicadas do banco de dados"
          >
            Remover Duplicatas
          </button>
          <button 
            onClick={() => setShowDeleteModal(true)}
            className="bg-white/10 hover:bg-white/20 text-white text-sm py-1.5 px-3 rounded-lg transition-colors"
          >
            Limpar Trades
          </button>
          <button 
            onClick={() => setShowRecalcModal(true)}
            className="bg-white/10 hover:bg-white/20 text-white text-sm py-1.5 px-3 rounded-lg transition-colors"
          >
            Recalcular PnL
          </button>
          <button 
            onClick={() => setShowSyncModal(true)}
            className="bg-white/10 hover:bg-white/20 text-white text-sm py-1.5 px-3 rounded-lg transition-colors"
          >
            Sincronizar
          </button>
          <button 
            onClick={() => setShowImportModal(true)}
            className="bg-white/10 hover:bg-white/20 text-white text-sm py-1.5 px-3 rounded-lg transition-colors"
          >
            Importar CSV
          </button>
        </div>
      </div>
      
      <Toolbar>
        <div className="relative w-full sm:w-auto">
          <label className="block text-sm font-medium text-slate-300 mb-1">⏰ Período</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPeriodDropdownOpen(!periodDropdownOpen)}
              className="w-full sm:min-w-[180px] flex items-center justify-between gap-2 border border-white/10 bg-white/5 text-white rounded-lg px-4 py-2.5 hover:bg-white/10 transition-colors focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                <div className="absolute z-20 mt-1 w-full sm:w-auto left-0 sm:left-auto right-0 sm:right-auto bg-slate-800 border border-white/10 rounded-lg shadow-xl overflow-hidden">
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
          </div>
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
        <div className="flex flex-col w-full sm:w-auto">
          <label className="text-sm font-medium text-slate-300 mb-1">💰 Symbol</label>
          <select 
            value={symbol} 
            onChange={(e) => setSymbol(e.target.value)} 
            className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            disabled={loadingFilters}
          >
            <option value="">Todos</option>
            {availableSymbols.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-2 w-full sm:w-auto">
          <button
            onClick={handleExportCSV}
            className="bg-green-500 hover:bg-green-600 text-white px-4 py-2.5 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 text-sm sm:text-base"
          >
            <span>📊</span>
            <span className="hidden sm:inline">Export CSV</span>
            <span className="sm:hidden">CSV</span>
          </button>
          <button
            onClick={handleExportPDF}
            className="bg-red-500 hover:bg-red-600 text-white px-4 py-2.5 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 text-sm sm:text-base"
          >
            <span>📄</span>
            <span className="hidden sm:inline">Export PDF</span>
            <span className="sm:hidden">PDF</span>
          </button>
        </div>
      </Toolbar>

      {/* Informações de disponibilidade */}
      <div className="mb-4 p-3 bg-slate-900/50 backdrop-blur-sm rounded-lg border border-white/10">
        <div className="flex flex-wrap gap-4 text-sm text-slate-400">
          <span>
            <span className="text-slate-300 font-semibold">{total.toLocaleString('pt-BR')}</span> trades disponíveis
          </span>
          {total > 0 && (
            <span>
              <span className="text-slate-300 font-semibold">{Math.ceil(total / pageSize)}</span> página{Math.ceil(total / pageSize) !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Métricas extras */}
      {summary && (
        <div className="space-y-4">
          {/* Métricas principais */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 p-3 sm:p-4 bg-gradient-to-r from-blue-500/10 to-indigo-500/5 backdrop-blur-sm rounded-lg border border-white/10">
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-blue-400">
                {formatCurrency(summary.pnlMonth)}
              </div>
              <div className="text-xs sm:text-sm text-slate-400">PnL Total</div>
            </div>
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-green-400">
                {summary.winningTrades}
              </div>
              <div className="text-xs sm:text-sm text-slate-400">Trades Vencedores</div>
            </div>
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-red-400">
                {summary.losingTrades}
              </div>
              <div className="text-xs sm:text-sm text-slate-400">Trades Perdedores</div>
            </div>
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-purple-400">
                {formatCurrency(summary.feesTotal)}
              </div>
              <div className="text-xs sm:text-sm text-slate-400">Taxas Totais</div>
            </div>
          </div>

          {/* Métricas avançadas */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 p-3 sm:p-4 bg-gradient-to-r from-emerald-500/10 to-green-500/5 backdrop-blur-sm rounded-lg border border-white/10">
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-emerald-400">
                {formatCurrency(summary.totalVolume)}
              </div>
              <div className="text-xs sm:text-sm text-slate-400">Volume Total</div>
            </div>
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-orange-400">
                {(summary.winRate * 100).toFixed(1)}%
              </div>
              <div className="text-xs sm:text-sm text-slate-400">Win Rate</div>
            </div>
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-green-400">
                {formatCurrency(summary.bestTrade)}
              </div>
              <div className="text-xs sm:text-sm text-slate-400">Melhor Trade</div>
            </div>
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-red-400">
                {formatCurrency(summary.worstTrade)}
              </div>
              <div className="text-xs sm:text-sm text-slate-400">Pior Trade</div>
            </div>
          </div>

          {/* Métricas de risco */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 p-3 sm:p-4 bg-gradient-to-r from-red-500/10 to-pink-500/5 backdrop-blur-sm rounded-lg border border-white/10">
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-red-400">
                {formatCurrency(summary.maxDrawdown)}
              </div>
              <div className="text-xs sm:text-sm text-slate-400">Max Drawdown</div>
            </div>
            <div className="text-center">
              <div className="text-lg sm:text-2xl font-bold text-pink-400">
                {formatCurrency(summary.currentDrawdown)}
              </div>
              <div className="text-xs sm:text-sm text-slate-400">Drawdown Atual</div>
            </div>
          </div>
        </div>
      )}

      <div className="relative overflow-hidden border-white/10 bg-gradient-to-br from-white/5 to-white/[0.02] backdrop-blur-sm rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-gradient-to-r from-white/10 to-white/5">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th key={h.id} className="text-left px-4 py-3 text-sm font-semibold text-white border-b border-white/10">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-white/10">
              {table.getRowModel().rows.map((r, index) => {
                const data = r.original;
                const isGroup = !!data._isGroup;
                const isChild = !!data._isChild;
                const isExpanded = isGroup && data.orderId ? !!expandedOrders[data.orderId] : false;
                
                return (
                  <tr
                    key={r.id}
                    onClick={() => {
                      if (isGroup && data.orderId) {
                        setExpandedOrders((s) => ({ ...s, [data.orderId!]: !isExpanded }));
                      }
                    }}
                    className={`
                      transition-all duration-200
                      ${isGroup ? 'cursor-pointer hover:bg-blue-500/20' : ''}
                      ${isExpanded ? 'bg-blue-500/10 border-l-2 border-blue-500' : ''}
                      ${isChild ? 'bg-slate-800/50' : ''}
                      ${!isGroup && !isChild ? (index % 2 === 0 ? 'bg-white/5' : 'bg-white/10') : ''}
                      ${!isGroup ? 'hover:bg-white/5' : ''}
                    `}
                  >
                    {r.getVisibleCells().map((c) => (
                      <td key={c.id} className={`px-4 py-3 text-sm text-white ${isChild ? 'pl-8' : ''}`}>
                        {flexRender(c.column.columnDef.cell, c.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 sm:gap-4 bg-white/5 backdrop-blur-sm p-3 sm:p-4 rounded-lg border border-white/10">
        <div className="flex items-center gap-2 w-full sm:w-auto justify-center sm:justify-start">
          <button 
            className="bg-white/10 hover:bg-white/20 text-white px-3 sm:px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm sm:text-base" 
            disabled={page <= 1} 
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <span>←</span>
            <span className="hidden sm:inline">Anterior</span>
          </button>
          <div className="px-3 sm:px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg font-medium text-center min-w-[100px] sm:min-w-[120px]">
            <div className="text-xs sm:text-sm">Página</div>
            <div className="text-base sm:text-lg font-bold">{page} / {totalPages}</div>
          </div>
          <button 
            className="bg-white/10 hover:bg-white/20 text-white px-3 sm:px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm sm:text-base" 
            disabled={page >= totalPages} 
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <span className="hidden sm:inline">Próximo</span>
            <span>→</span>
          </button>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto justify-center sm:justify-end">
          <label className="text-xs sm:text-sm font-medium text-slate-300 whitespace-nowrap">Itens por página:</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPageSizeDropdownOpen(!pageSizeDropdownOpen)}
              className="min-w-[70px] sm:min-w-[80px] flex items-center justify-between gap-2 border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 hover:bg-white/10 transition-colors focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm sm:text-base"
            >
              <span>{pageSize}</span>
              <span className={`transition-transform flex-shrink-0 ${pageSizeDropdownOpen ? 'rotate-180' : ''}`}>⌄</span>
            </button>
            {pageSizeDropdownOpen && (
              <>
                <div 
                  className="fixed inset-0 z-10" 
                  onClick={() => setPageSizeDropdownOpen(false)}
                />
                <div className="absolute z-20 mt-1 w-full bg-slate-800 border border-white/10 rounded-lg shadow-xl overflow-hidden">
                  {[10, 20, 50, 100].map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => {
                        setPageSize(size);
                        setPage(1);
                        setPageSizeDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors ${
                        pageSize === size ? 'bg-blue-500/20 text-blue-400' : 'text-white'
                      }`}
                    >
                      {size}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      </div>

      {/* Modal de Sincronização */}
      {showSyncModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-slate-900 rounded-xl p-4 sm:p-6 max-w-md w-full border border-white/10 my-auto">
            <h3 className="text-lg sm:text-xl text-white font-semibold mb-3 sm:mb-4">
              {syncProgress !== null ? 'Sincronizando' : 'Configurar sincronização'}
            </h3>
            
            {syncProgress !== null ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-slate-300 text-sm">{syncProgress.message}</span>
                    <span className="text-slate-400 text-sm font-semibold">{syncProgress.percent}%</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-3 overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${
                        syncProgress.status === 'completed' 
                          ? 'bg-green-500' 
                          : syncProgress.status === 'error'
                          ? 'bg-red-500'
                          : 'bg-gradient-to-r from-blue-500 to-cyan-500'
                      }`}
                      style={{ width: `${syncProgress.percent}%` }}
                    />
                  </div>
                </div>
                {syncProgress.status === 'completed' && syncProgress.result && (
                  <div className="text-sm text-green-400">
                    <div className="font-semibold mb-1">✓ Sincronização concluída!</div>
                    <div>
                      Total de trades encontrados: {syncProgress.result.inserted + syncProgress.result.updated}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      ({syncProgress.result.inserted} novos, {syncProgress.result.updated} atualizados)
                    </div>
                  </div>
                )}
                {syncProgress.status === 'error' && (
                  <div className="text-sm text-red-400">
                    ✗ {syncProgress.error || 'Erro desconhecido'}
                  </div>
                )}
                {syncProgress.status === 'running' && (
                  <div className="flex items-center gap-2 text-slate-400 text-sm">
                    <div className="animate-spin">⏳</div>
                    <span>Processando...</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-slate-300 text-sm mb-2">Data inicial</label>
                  <input 
                    type="date"
                    value={syncStartDate}
                    onChange={(e) => setSyncStartDate(e.target.value)}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    disabled={!!syncProgress}
                  />
                </div>

                <div>
                  <label className="block text-slate-300 text-sm mb-2">Data final</label>
                  <input 
                    type="date"
                    value={syncEndDate}
                    onChange={(e) => setSyncEndDate(e.target.value)}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    disabled={!!syncProgress}
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-slate-300 text-sm">Moedas (uma por linha)</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => fetchTradedSymbols(false)}
                        disabled={!!syncProgress || loadingSymbols}
                        className="text-xs bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 px-2 py-1 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loadingSymbols ? '⏳' : '🔍'} Banco
                      </button>
                      <button
                        type="button"
                        onClick={() => fetchTradedSymbols(true, false)}
                        disabled={!!syncProgress || loadingSymbols}
                        className="text-xs bg-green-500/20 hover:bg-green-500/30 text-green-400 px-2 py-1 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loadingSymbols ? '⏳' : '🌐'} API Comuns
                      </button>
                      <button
                        type="button"
                        onClick={() => fetchTradedSymbols(true, true)}
                        disabled={!!syncProgress || loadingSymbols}
                        className="text-xs bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 px-2 py-1 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Busca TODOS os pares disponíveis na Binance (pode demorar vários minutos)"
                      >
                        {loadingSymbols ? '⏳' : '🚀'} Todos
                      </button>
                    </div>
                  </div>
                  {symbolsProgress && (
                    <div className="mb-2 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm text-blue-300 font-medium">
                          {symbolsProgress.message}
                        </span>
                        {symbolsProgress.estimatedTime && (
                          <span className="text-xs text-blue-400">
                            {symbolsProgress.estimatedTime}
                          </span>
                        )}
                      </div>
                      <div className="w-full bg-slate-700/50 rounded-full h-2.5 overflow-hidden">
                        <div 
                          className="bg-gradient-to-r from-blue-500 to-cyan-500 h-2.5 rounded-full transition-all duration-300"
                          style={{ width: `${symbolsProgress.percent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs text-blue-400">
                          {symbolsProgress.currentStep || 0} / {symbolsProgress.totalSteps || 0} lotes
                        </span>
                        <span className="text-xs text-blue-300 font-semibold">
                          {symbolsProgress.percent}%
                        </span>
                      </div>
                    </div>
                  )}
                  <textarea 
                    value={syncSymbols}
                    onChange={(e) => setSyncSymbols(e.target.value)}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white h-32"
                    placeholder="BTCBRL&#10;ETHBRL&#10;BNBBRL"
                    disabled={!!syncProgress}
                  />
                  <p className="text-xs text-slate-400 mt-1">
                    <strong>Banco:</strong> Rápido (apenas sincronizados) | 
                    <strong> API Comuns:</strong> Testa ~32 pares comuns | 
                    <strong> Todos:</strong> Testa TODOS os pares disponíveis (pode demorar muito)
                  </p>
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={syncTrades}
                    disabled={!!syncProgress}
                    className="flex-1 bg-gradient-to-r from-blue-500 to-cyan-500 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Sincronizar
                  </button>
                  <button 
                    onClick={() => {
                      if (window.__syncPollInterval) {
                        clearInterval(window.__syncPollInterval);
                        window.__syncPollInterval = null;
                      }
                      setShowSyncModal(false);
                      setSyncProgress(null);
                    }}
                    disabled={false}
                    className="flex-1 bg-white/10 hover:bg-white/20 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
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
              {importProgress !== null ? 'Importando CSV' : 'Importar CSV de Trades'}
            </h3>
            
            {importProgress !== null ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-slate-300 text-sm">{importProgress.message}</span>
                    <span className="text-slate-400 text-sm font-semibold">{importProgress.percent}%</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-3 overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${
                        importProgress.status === 'completed' 
                          ? 'bg-green-500' 
                          : importProgress.status === 'error'
                          ? 'bg-red-500'
                          : 'bg-gradient-to-r from-purple-500 to-pink-500'
                      }`}
                      style={{ width: `${importProgress.percent}%` }}
                    />
                  </div>
                </div>
                {importProgress.status === 'completed' && importProgress.result && (
                  <div className="text-sm text-green-400">
                    <div className="font-semibold mb-1">✓ Importação concluída!</div>
                    <div>
                      {importProgress.result.inserted || 0} inseridos, {importProgress.result.updated || 0} atualizados
                    </div>
                  </div>
                )}
                {importProgress.status === 'error' && (
                  <div className="space-y-3">
                    <div className="text-sm text-red-400">
                      ✗ {importProgress.error || 'Erro desconhecido'}
                    </div>
                    {importProgress.jobId && (
                      <button
                        onClick={async () => {
                          if (!importFile || !importAccountId) {
                            alert('Por favor, selecione o mesmo arquivo CSV e conta para retomar a importação.');
                            return;
                          }
                          
                          const user = auth.currentUser;
                          if (!user) return;
                          
                          const confirmResume = confirm(
                            `⚠️ Retomar importação da linha ${importProgress.percent}%?\n\n` +
                            `Isso continuará de onde parou sem perder os dados já importados.`
                          );
                          if (!confirmResume) return;
                          
                          try {
                            const token = await user.getIdToken();
                            const formData = new FormData();
                            formData.append('file', importFile);
                            formData.append('accountId', importAccountId);
                            if (importProgress.jobId) {
                              formData.append('jobId', importProgress.jobId);
                            }
                            
                            const response = await fetch('/api/trades/import-csv', {
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
                                percent: importProgress.percent,
                                message: 'Retomando importação...',
                                status: 'running',
                              });
                              
                              // Reiniciar polling
                              const pollInterval = setInterval(async () => {
                                try {
                                  const statusResponse = await fetch(`/api/jobs/sync-status?jobId=${result.jobId}`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                  });
                                  const status = await statusResponse.json();
                                  
                                  if (status.error) {
                                    clearInterval(pollInterval);
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
                                    clearInterval(pollInterval);
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
                                    clearInterval(pollInterval);
                                  }
                                } catch (error) {
                                  console.error('Error polling status:', error);
                                  clearInterval(pollInterval);
                                }
                              }, 1000);
                              
                              window.__tradesImportPollInterval = pollInterval;
                            }
                          } catch (error) {
                            alert(`Erro ao retomar importação: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
                          }
                        }}
                        className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200"
                      >
                        🔄 Retomar Importação
                      </button>
                    )}
                  </div>
                )}
                {importProgress.status === 'running' && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-slate-400 text-sm">
                      <div className="animate-spin">⏳</div>
                      <span>Processando...</span>
                    </div>
                    <button
                      onClick={async () => {
                        if (!importProgress.jobId) return;
                        
                        const user = auth.currentUser;
                        if (!user) return;
                        
                        const confirmCancel = confirm('⚠️ Tem certeza que deseja cancelar esta importação? O progresso será perdido.');
                        if (!confirmCancel) return;
                        
                        try {
                          const token = await user.getIdToken();
                          const response = await fetch('/api/jobs/stuck', {
                            method: 'POST',
                            headers: {
                              Authorization: `Bearer ${token}`,
                              'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({ jobId: importProgress.jobId })
                          });
                          
                          if (response.ok) {
                            // Limpar intervalos
                            if (window.__tradesImportPollInterval) {
                              clearInterval(window.__tradesImportPollInterval);
                              window.__tradesImportPollInterval = null;
                            }
                            
                            setImportProgress(null);
                            setShowImportModal(false);
                            setImportFile(null);
                            alert('✅ Importação cancelada com sucesso!');
                          } else {
                            alert('Erro ao cancelar importação');
                          }
                        } catch (error) {
                          console.error('Error canceling import:', error);
                          alert('Erro ao cancelar importação');
                        }
                      }}
                      className="w-full bg-red-500 hover:bg-red-600 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200"
                    >
                      ⛔ Cancelar Importação
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {incompleteJobs.length > 0 && (
                  <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                    <div className="text-sm text-yellow-400 font-semibold mb-2">
                      ⚠️ Importações Incompletas Encontradas
                    </div>
                    <div className="space-y-2">
                      {incompleteJobs.map((job) => (
                        <div key={job.jobId} className="flex items-center justify-between text-xs text-yellow-300">
                          <span>
                            {Math.round((job.currentStep / job.totalSteps) * 100)}% completo
                            ({job.currentStep}/{job.totalSteps} linhas)
                          </span>
                          <button
                            onClick={async () => {
                              if (!importFile || !importAccountId) {
                                alert('Por favor, selecione o mesmo arquivo CSV e conta para retomar.');
                                return;
                              }
                              
                              const user = auth.currentUser;
                              if (!user) return;
                              
                              const confirmResume = confirm(
                                `Retomar importação da linha ${job.currentStep + 1}?`
                              );
                              if (!confirmResume) return;
                              
                              try {
                                const token = await user.getIdToken();
                                const formData = new FormData();
                                formData.append('file', importFile);
                                formData.append('accountId', importAccountId);
                                formData.append('jobId', job.jobId);
                                
                                const response = await fetch('/api/trades/import-csv', {
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
                                    percent: Math.round((job.currentStep / job.totalSteps) * 100),
                                    message: 'Retomando importação...',
                                    status: 'running',
                                  });
                                  
                                  // Reiniciar polling
                                  const pollInterval = setInterval(async () => {
                                    try {
                                      const statusResponse = await fetch(`/api/jobs/sync-status?jobId=${result.jobId}`, {
                                        headers: { Authorization: `Bearer ${token}` },
                                      });
                                      const status = await statusResponse.json();
                                      
                                      if (status.error) {
                                        clearInterval(pollInterval);
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
                                        clearInterval(pollInterval);
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
                                        clearInterval(pollInterval);
                                      }
                                    } catch (error) {
                                      console.error('Error polling status:', error);
                                      clearInterval(pollInterval);
                                    }
                                  }, 1000);
                                  
                                  window.__tradesImportPollInterval = pollInterval;
                                }
                              } catch (error) {
                                alert(`Erro ao retomar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
                              }
                            }}
                            className="bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-xs font-semibold transition-colors"
                          >
                            Retomar
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <label className="block text-slate-300 text-sm mb-2">Conta Binance</label>
                  {accounts.length === 0 ? (
                    <div className="w-full px-3 py-2 bg-white/5 border border-yellow-500/50 rounded-lg text-yellow-400 text-sm">
                      ⚠️ Nenhuma conta Binance encontrada. Por favor, adicione uma conta primeiro na página de Contas.
                    </div>
                  ) : (
                    <select
                      value={importAccountId}
                      onChange={(e) => setImportAccountId(e.target.value)}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white [&>option]:bg-slate-800 [&>option]:text-white"
                    >
                      <option value="" className="bg-slate-800 text-white">Selecione uma conta</option>
                      {accounts.map((acc) => (
                        <option key={acc.id} value={acc.id} className="bg-slate-800 text-white">
                          {acc.name} ({acc.market || 'SPOT'})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div>
                  <label className="block text-slate-300 text-sm mb-2">Arquivo CSV</label>
                  <input
                    type="file"
                    accept=".csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setImportFile(file);
                      }
                    }}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-purple-500 file:text-white hover:file:bg-purple-600"
                  />
                  <p className="text-xs text-slate-400 mt-1">
                    Selecione o arquivo CSV exportado da Binance com o histórico de trades
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
                      if (window.__tradesImportPollInterval) {
                        clearInterval(window.__tradesImportPollInterval);
                        window.__tradesImportPollInterval = null;
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

      {/* Modal de Limpar Trades */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-slate-900 rounded-xl p-4 sm:p-6 max-w-md w-full border border-white/10 my-auto">
            <h3 className="text-lg sm:text-xl text-white font-semibold mb-3 sm:mb-4">
              Limpar Trades
            </h3>
            
            {isDeleting ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm">
                  <div className="animate-spin">⏳</div>
                  <span>Deletando trades...</span>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                  <div className="text-sm text-red-400 font-semibold mb-1">
                    ⚠️ Atenção!
                  </div>
                  <div className="text-xs text-red-300">
                    Esta ação é irreversível. Todos os trades que corresponderem aos filtros serão permanentemente deletados.
                  </div>
                </div>

                <div>
                  <label className="block text-slate-300 text-sm mb-2">⏰ Período</label>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        setDeletePeriodDropdownOpen(!deletePeriodDropdownOpen);
                        setDeleteMonthSelectOpen(false);
                      }}
                      className="w-full flex items-center justify-between gap-2 border border-white/10 bg-white/5 text-white rounded-lg px-4 py-2.5 hover:bg-white/10 transition-colors focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      <span className="truncate">
                        {deletePeriod === 'custom' && deleteStartDate && deleteEndDate
                          ? `${deleteStartDate} - ${deleteEndDate}`
                          : deletePeriod === 'month-select' && deleteSelectedMonth
                          ? `Mês: ${deleteSelectedMonth}`
                          : deletePeriod === 'month'
                          ? 'Este Mês'
                          : deletePeriod === 'week'
                          ? 'Esta Semana'
                          : deletePeriod === 'year'
                          ? 'Este Ano'
                          : deletePeriod === 'all'
                          ? '🌐 Todos'
                          : 'Selecione um período'}
                      </span>
                      <span className={`transition-transform flex-shrink-0 ${deletePeriodDropdownOpen ? 'rotate-180' : ''}`}>⌄</span>
                    </button>
                    {deletePeriodDropdownOpen && (
                      <>
                        <div 
                          className="fixed inset-0 z-10" 
                          onClick={() => setDeletePeriodDropdownOpen(false)}
                        />
                        <div className="absolute z-20 mt-1 w-full bg-slate-800 border border-white/10 rounded-lg shadow-xl overflow-hidden">
                          <button
                            type="button"
                            onClick={() => {
                              setDeletePeriod('month');
                              setDeleteSelectedMonth('');
                              setDeleteStartDate('');
                              setDeleteEndDate('');
                              setDeletePeriodDropdownOpen(false);
                            }}
                            className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors ${
                              deletePeriod === 'month' ? 'bg-blue-500/20 text-blue-400' : 'text-white'
                            }`}
                          >
                            📅 Este Mês
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeletePeriod('week');
                              setDeleteSelectedMonth('');
                              setDeleteStartDate('');
                              setDeleteEndDate('');
                              setDeletePeriodDropdownOpen(false);
                            }}
                            className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors ${
                              deletePeriod === 'week' ? 'bg-blue-500/20 text-blue-400' : 'text-white'
                            }`}
                          >
                            📅 Esta Semana
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeletePeriod('year');
                              setDeleteSelectedMonth('');
                              setDeleteStartDate('');
                              setDeleteEndDate('');
                              setDeletePeriodDropdownOpen(false);
                            }}
                            className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors ${
                              deletePeriod === 'year' ? 'bg-blue-500/20 text-blue-400' : 'text-white'
                            }`}
                          >
                            📅 Este Ano
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeletePeriod('month-select');
                              setDeletePeriodDropdownOpen(false);
                              setDeleteMonthSelectOpen(true);
                            }}
                            className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors ${
                              deletePeriod === 'month-select' ? 'bg-blue-500/20 text-blue-400' : 'text-white'
                            }`}
                          >
                            📅 Selecionar Mês
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeletePeriod('custom');
                              setDeletePeriodDropdownOpen(false);
                              setDeleteMonthSelectOpen(false);
                            }}
                            className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors ${
                              deletePeriod === 'custom' ? 'bg-blue-500/20 text-blue-400' : 'text-white'
                            }`}
                          >
                            📅 Período Customizado
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDeletePeriod('all');
                              setDeleteSelectedMonth('');
                              setDeleteStartDate('');
                              setDeleteEndDate('');
                              setDeletePeriodDropdownOpen(false);
                            }}
                            className={`w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 transition-colors ${
                              deletePeriod === 'all' ? 'bg-blue-500/20 text-blue-400' : 'text-white'
                            }`}
                          >
                            🌐 Todos
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  {deletePeriod === 'month-select' && deleteMonthSelectOpen && (
                    <>
                      <div 
                        className="fixed inset-0 z-25" 
                        onClick={() => {
                          setDeleteMonthSelectOpen(false);
                          if (!deleteSelectedMonth) {
                            setDeletePeriod('month');
                          }
                        }}
                      />
                      <div className="absolute top-full left-0 mt-2 z-30 bg-slate-800 border border-white/10 rounded-lg shadow-xl p-4 w-full min-w-[200px]">
                        <div className="flex flex-col">
                          <label className="text-sm font-medium text-slate-300 mb-2">📅 Selecionar Mês</label>
                          <input 
                            type="month" 
                            value={deleteSelectedMonth} 
                            onChange={(e) => {
                              setDeleteSelectedMonth(e.target.value);
                              setDeleteMonthSelectOpen(false);
                            }}
                            className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                            required
                          />
                        </div>
                      </div>
                    </>
                  )}
                  {deletePeriod === 'custom' && (
                    <div className="mt-2 space-y-2">
                      <input 
                        type="date" 
                        value={deleteStartDate} 
                        onChange={(e) => setDeleteStartDate(e.target.value)} 
                        className="w-full border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                        placeholder="Data inicial"
                      />
                      <input 
                        type="date" 
                        value={deleteEndDate} 
                        onChange={(e) => setDeleteEndDate(e.target.value)}
                        min={deleteStartDate}
                        className="w-full border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                        placeholder="Data final"
                      />
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-slate-300 text-sm mb-2">🏪 Market (opcional)</label>
                  <input 
                    value={deleteMarket} 
                    onChange={(e) => setDeleteMarket(e.target.value)} 
                    placeholder="SPOT/FUTURES" 
                    className="w-full border border-white/10 bg-white/5 text-white placeholder-slate-400 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                  />
                </div>

                <div>
                  <label className="block text-slate-300 text-sm mb-2">💰 Symbol (opcional)</label>
                  <input 
                    value={deleteSymbol} 
                    onChange={(e) => setDeleteSymbol(e.target.value)} 
                    placeholder="e.g. BTCBRL" 
                    className="w-full border border-white/10 bg-white/5 text-white placeholder-slate-400 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                  />
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={async () => {
                      const user = auth.currentUser;
                      if (!user) return;

                      // Construir filtros
                      let monthFilter: string | undefined;
                      let startDateFilter: string | undefined;
                      let endDateFilter: string | undefined;

                      if (deletePeriod === 'month-select' && deleteSelectedMonth) {
                        monthFilter = deleteSelectedMonth;
                      } else if (deletePeriod === 'custom' && deleteStartDate && deleteEndDate) {
                        startDateFilter = deleteStartDate;
                        endDateFilter = deleteEndDate;
                      } else if (deletePeriod === 'month') {
                        monthFilter = getMonth();
                      } else if (deletePeriod === 'week') {
                        const periodFilter = getPeriodFilter('week', earliestDate);
                        if (periodFilter.startDate && periodFilter.endDate) {
                          startDateFilter = periodFilter.startDate;
                          endDateFilter = periodFilter.endDate;
                        }
                      } else if (deletePeriod === 'year') {
                        const periodFilter = getPeriodFilter('year', earliestDate);
                        if (periodFilter.startDate && periodFilter.endDate) {
                          startDateFilter = periodFilter.startDate;
                          endDateFilter = periodFilter.endDate;
                        }
                      } else if (deletePeriod === 'all' && earliestDate) {
                        const periodFilter = getPeriodFilter('all', earliestDate);
                        if (periodFilter.startDate && periodFilter.endDate) {
                          startDateFilter = periodFilter.startDate;
                          endDateFilter = periodFilter.endDate;
                        }
                      }

                      const confirmDelete = confirm(
                        `⚠️ Tem certeza que deseja deletar os trades?\n\n` +
                        `Período: ${deletePeriod === 'month-select' && deleteSelectedMonth ? deleteSelectedMonth : deletePeriod === 'custom' && deleteStartDate && deleteEndDate ? `${deleteStartDate} - ${deleteEndDate}` : deletePeriod}\n` +
                        `${deleteMarket ? `Market: ${deleteMarket}\n` : ''}` +
                        `${deleteSymbol ? `Symbol: ${deleteSymbol}\n` : ''}\n` +
                        `Esta ação é irreversível!`
                      );

                      if (!confirmDelete) return;

                      setIsDeleting(true);

                      try {
                        const token = await user.getIdToken();
                        const response = await fetch('/api/trades/delete', {
                          method: 'POST',
                          headers: {
                            Authorization: `Bearer ${token}`,
                            'Content-Type': 'application/json',
                          },
                          body: JSON.stringify({
                            month: monthFilter,
                            startDate: startDateFilter,
                            endDate: endDateFilter,
                            market: deleteMarket || undefined,
                            symbol: deleteSymbol || undefined,
                          }),
                        });

                        const result = await response.json();

                        if (response.ok) {
                          alert(`✅ ${result.message}`);
                          setIsDeleting(false);
                          setShowDeleteModal(false);
                          setDeletePeriod('month');
                          setDeleteSelectedMonth('');
                          setDeleteStartDate('');
                          setDeleteEndDate('');
                          setDeleteMarket('');
                          setDeleteSymbol('');
                          window.location.reload();
                        } else {
                          alert(`Erro: ${result.error || result.message || 'Erro desconhecido'}`);
                          setIsDeleting(false);
                        }
                      } catch (error) {
                        alert(`Erro ao deletar trades: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
                        setIsDeleting(false);
                      }
                    }}
                    disabled={
                      isDeleting || 
                      (deletePeriod === 'month-select' && !deleteSelectedMonth) || 
                      (deletePeriod === 'custom' && (!deleteStartDate || !deleteEndDate))
                    }
                    className="flex-1 bg-gradient-to-r from-red-500 to-orange-500 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Deletar
                  </button>
                  <button 
                    onClick={() => {
                      setShowDeleteModal(false);
                      setDeletePeriod('month');
                      setDeleteSelectedMonth('');
                      setDeleteStartDate('');
                      setDeleteEndDate('');
                      setDeleteMarket('');
                      setDeleteSymbol('');
                      setIsDeleting(false);
                    }}
                    disabled={isDeleting}
                    className="flex-1 bg-white/10 hover:bg-white/20 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal de Recalcular PnL */}
      {showRecalcModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-slate-900 rounded-xl p-4 sm:p-6 max-w-md w-full border border-white/10 my-auto">
            <h3 className="text-lg sm:text-xl text-white font-semibold mb-3 sm:mb-4">
              {recalcProgress !== null ? 'Recalculando PnL' : 'Configurar recálculo de PnL'}
            </h3>
            
            {recalcProgress !== null ? (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-slate-300 text-sm">{recalcProgress.message}</span>
                    <span className="text-slate-400 text-sm font-semibold">{recalcProgress.percent}%</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-3 overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${
                        recalcProgress.status === 'completed' 
                          ? 'bg-green-500' 
                          : recalcProgress.status === 'error'
                          ? 'bg-red-500'
                          : 'bg-gradient-to-r from-purple-500 to-pink-500'
                      }`}
                      style={{ width: `${recalcProgress.percent}%` }}
                    />
                  </div>
                </div>
                {recalcProgress.status === 'completed' && recalcProgress.result && (
                  <div className="text-sm text-green-400">
                    <div className="font-semibold mb-1">✓ Recálculo concluído!</div>
                    <div>
                      {recalcProgress.result.updated || 0} trades atualizados
                    </div>
                  </div>
                )}
                {recalcProgress.status === 'error' && (
                  <div className="text-sm text-red-400">
                    ✗ {recalcProgress.error || 'Erro desconhecido'}
                  </div>
                )}
                {recalcProgress.status === 'running' && (
                  <div className="flex items-center gap-2 text-slate-400 text-sm">
                    <div className="animate-spin">⏳</div>
                    <span>Processando...</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-slate-300 text-sm mb-2">📅 Data inicial (opcional)</label>
                  <input 
                    type="date"
                    value={recalcStartDate}
                    onChange={(e) => setRecalcStartDate(e.target.value)}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    placeholder="Deixe vazio para todos os trades"
                  />
                  <p className="text-xs text-slate-400 mt-1">Deixe vazio para recalcular todos os trades</p>
                </div>

                <div>
                  <label className="block text-slate-300 text-sm mb-2">📅 Data final (opcional)</label>
                  <input 
                    type="date"
                    value={recalcEndDate}
                    onChange={(e) => setRecalcEndDate(e.target.value)}
                    min={recalcStartDate}
                    className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    placeholder="Deixe vazio para todos os trades"
                  />
                  <p className="text-xs text-slate-400 mt-1">Deixe vazio para recalcular todos os trades</p>
                </div>

                <div className="flex gap-3">
                  <button 
                    onClick={recalculatePnL}
                    disabled={!!recalcProgress}
                    className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Recalcular
                  </button>
                  <button 
                    onClick={() => {
                      if (window.__syncPollInterval) {
                        clearInterval(window.__syncPollInterval);
                        window.__syncPollInterval = null;
                      }
                      setShowRecalcModal(false);
                      setRecalcProgress(null);
                      setRecalcStartDate('');
                      setRecalcEndDate('');
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
    </InternalLayout>
  );
}
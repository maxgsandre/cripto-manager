"use client";
import React, { useEffect, useMemo, useState } from 'react';
import { Toolbar } from '@/components/Toolbar';
import InternalLayout from '@/components/InternalLayout';
import { auth } from '@/lib/firebase/client';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';

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

// Função para obter período baseado na seleção
function getPeriodFilter(period: string): string {
  const now = new Date();
  switch (period) {
    case 'today':
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    case 'week':
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
    case 'month':
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    case 'year':
      return `${now.getFullYear()}`;
    default:
      return getMonth();
  }
}

export default function TradesPage() {
  const month = getMonth();
  const [period, setPeriod] = useState('month');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [market, setMarket] = useState('');
  const [symbol, setSymbol] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<TradeRow[]>([]);
  const [expandedOrders, setExpandedOrders] = useState<Record<string, boolean>>({});
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncStartDate, setSyncStartDate] = useState(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
  const [syncEndDate, setSyncEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [syncSymbols, setSyncSymbols] = useState('BTCUSDT\nETHUSDT\nBNBUSDT');
  const [periodDropdownOpen, setPeriodDropdownOpen] = useState(false);
  const [pageSizeDropdownOpen, setPageSizeDropdownOpen] = useState(false);

  useEffect(() => {
    const currentMonth = period === 'custom' && startDate && endDate 
      ? `${startDate}_${endDate}` 
      : period === 'custom' 
        ? month 
        : getPeriodFilter(period);
    
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
    };
    const params = new URLSearchParams({ month: currentMonth, page: String(page), pageSize: String(pageSize) });
    if (market) params.set('market', market);
    if (symbol) params.set('symbol', symbol);
    if (period === 'custom' && startDate && endDate) {
      params.set('startDate', startDate);
      params.set('endDate', endDate);
    }
    fetch(`/api/trades?${params.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { total: number; rows: ApiTrade[] }) => {
        setTotal(d.total);
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
          }))
        );
      });
  }, [month, period, startDate, endDate, market, symbol, page, pageSize]);

  const handleExportCSV = () => {
    const currentMonth = period === 'custom' && startDate && endDate 
      ? `${startDate}_${endDate}` 
      : period === 'custom' 
        ? month 
        : getPeriodFilter(period);
    const params = new URLSearchParams({ month: currentMonth });
    if (market) params.set('market', market);
    if (symbol) params.set('symbol', symbol);
    if (period === 'custom' && startDate && endDate) {
      params.set('startDate', startDate);
      params.set('endDate', endDate);
    }
    window.open(`/api/export/csv?${params.toString()}`, '_blank');
  };

  const handleExportPDF = () => {
    const currentMonth = period === 'custom' && startDate && endDate 
      ? `${startDate}_${endDate}` 
      : period === 'custom' 
        ? month 
        : getPeriodFilter(period);
    const params = new URLSearchParams({ month: currentMonth });
    if (market) params.set('market', market);
    if (symbol) params.set('symbol', symbol);
    if (period === 'custom' && startDate && endDate) {
      params.set('startDate', startDate);
      params.set('endDate', endDate);
    }
    window.open(`/api/export/pdf?${params.toString()}`, '_blank');
  };

  const periodOptions = [
    { value: 'today', label: '📅 Hoje' },
    { value: 'week', label: '📆 Esta Semana' },
    { value: 'month', label: '📅 Este Mês' },
    { value: 'year', label: '📅 Este Ano' },
    { value: 'custom', label: '🔧 Personalizado' },
  ];

  const getPeriodLabel = () => {
    const option = periodOptions.find(opt => opt.value === period);
    return option ? option.label : '📅 Este Mês';
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
      } else if (result.results && result.results.length > 0) {
        const total = result.results.reduce((acc: number, r: { inserted: number }) => acc + r.inserted, 0);
        alert(`Sucesso! ${total} trades sincronizados`);
        // Recarregar página para mostrar novos trades
        window.location.reload();
      } else {
        alert('Nenhum trade encontrado para sincronizar');
      }
    } catch (error) {
      alert(`Erro ao sincronizar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  };

  // Tipos auxiliares para exibição agrupada
  type DisplayRow = TradeRow & { _isGroup?: boolean; _isChild?: boolean; _childrenCount?: number };

  // Agrupar por orderId quando houver multiplas execucoes
  const groupedRows: DisplayRow[] = useMemo(() => {
    const byOrder: Record<string, TradeRow[]> = {};
    for (const r of rows) {
      if (r.orderId) {
        if (!byOrder[r.orderId]) byOrder[r.orderId] = [];
        byOrder[r.orderId].push(r);
      }
    }

    const out: DisplayRow[] = [];
    const emitted = new Set<string>();

    for (const r of rows) {
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
      columnHelper.accessor('qty', { 
        header: '📈 Quantidade',
        cell: ({ getValue, row }) => (
          <span className={`font-mono ${row.original._isGroup ? 'font-semibold' : ''}`}>{Number(getValue()).toFixed(8)}</span>
        )
      }),
      columnHelper.accessor('price', { 
        header: '💵 Preço',
        cell: ({ getValue, row }) => (
          <span className={`font-mono ${row.original._isGroup ? 'font-semibold' : ''}`}>{formatCurrency(getValue())}</span>
        )
      }),
      columnHelper.accessor('feeValue', { 
        header: '💸 Taxa',
        cell: ({ getValue, row }) => (
          <div className="text-sm">
            <div className={`font-mono ${row.original._isGroup ? 'font-semibold' : ''}`}>{formatCurrency(getValue())}</div>
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
            <span className={`font-mono font-semibold text-purple-400 ${row.original._isGroup ? 'underline' : ''}`}>
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
            <span className={`font-semibold ${pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
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
            <span className={`font-semibold ${roi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl text-white mb-2">Trades</h1>
          <p className="text-slate-400">Histórico detalhado de operações</p>
        </div>
        <button 
          onClick={() => setShowSyncModal(true)}
          className="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-semibold py-2 px-6 rounded-lg transition-all duration-200 flex items-center gap-2"
        >
          <span>🔄</span>
          Sincronizar
        </button>
      </div>
      
      <Toolbar>
        <div className="relative">
          <label className="block text-sm font-medium text-slate-300 mb-1">⏰ Período</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPeriodDropdownOpen(!periodDropdownOpen)}
              className="w-full min-w-[180px] flex items-center justify-between gap-2 border border-white/10 bg-white/5 text-white rounded-lg px-4 py-2.5 hover:bg-white/10 transition-colors focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <span>{getPeriodLabel()}</span>
              <span className={`transition-transform ${periodDropdownOpen ? 'rotate-180' : ''}`}>⌄</span>
            </button>
            {periodDropdownOpen && (
              <>
                <div 
                  className="fixed inset-0 z-10" 
                  onClick={() => setPeriodDropdownOpen(false)}
                />
                <div className="absolute z-20 mt-1 w-full bg-slate-800 border border-white/10 rounded-lg shadow-xl overflow-hidden">
                  {periodOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setPeriod(option.value);
                        setPeriodDropdownOpen(false);
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
        </div>
        {period === 'custom' && (
          <>
            <div className="flex flex-col">
              <label className="text-sm font-medium text-slate-300 mb-1">📅 Data Inicial</label>
              <input 
                type="date" 
                value={startDate} 
                onChange={(e) => setStartDate(e.target.value)} 
                className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                required
              />
            </div>
            <div className="flex flex-col">
              <label className="text-sm font-medium text-slate-300 mb-1">📅 Data Final</label>
              <input 
                type="date" 
                value={endDate} 
                onChange={(e) => setEndDate(e.target.value)} 
                min={startDate}
                className="border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
                required
              />
            </div>
          </>
        )}
        <div className="flex flex-col">
          <label className="text-sm font-medium text-slate-300 mb-1">🏪 Market</label>
          <input 
            value={market} 
            onChange={(e) => setMarket(e.target.value)} 
            placeholder="SPOT/FUTURES" 
            className="border border-white/10 bg-white/5 text-white placeholder-slate-400 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
          />
        </div>
        <div className="flex flex-col">
          <label className="text-sm font-medium text-slate-300 mb-1">💰 Symbol</label>
          <input 
            value={symbol} 
            onChange={(e) => setSymbol(e.target.value)} 
            placeholder="e.g. BTCUSDT" 
            className="border border-white/10 bg-white/5 text-white placeholder-slate-400 rounded-lg px-3 py-2.5 focus:ring-2 focus:ring-blue-500 focus:border-transparent" 
          />
        </div>
        <div className="flex items-end gap-2">
          <button
            onClick={handleExportCSV}
            className="bg-green-500 hover:bg-green-600 text-white px-4 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-2"
          >
            <span>📊</span>
            <span>Export CSV</span>
          </button>
          <button
            onClick={handleExportPDF}
            className="bg-red-500 hover:bg-red-600 text-white px-4 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-2"
          >
            <span>📄</span>
            <span>Export PDF</span>
          </button>
        </div>
      </Toolbar>

      {/* Métricas extras */}
      {rows.length > 0 && (
        <div className="space-y-4">
          {/* Métricas principais */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 bg-gradient-to-r from-blue-500/10 to-indigo-500/5 backdrop-blur-sm rounded-lg border border-white/10">
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-400">
                {formatCurrency(rows.reduce((sum, r) => sum + Number(r.realizedPnl), 0))}
              </div>
              <div className="text-sm text-slate-400">PnL Total</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-400">
                {rows.filter(r => Number(r.realizedPnl) > 0).length}
              </div>
              <div className="text-sm text-slate-400">Trades Vencedores</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-400">
                {rows.filter(r => Number(r.realizedPnl) < 0).length}
              </div>
              <div className="text-sm text-slate-400">Trades Perdedores</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-400">
                {formatCurrency(rows.reduce((sum, r) => sum + Number(r.feeValue), 0))}
              </div>
              <div className="text-sm text-slate-400">Taxas Totais</div>
            </div>
          </div>

          {/* Métricas avançadas */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4 bg-gradient-to-r from-emerald-500/10 to-green-500/5 backdrop-blur-sm rounded-lg border border-white/10">
            <div className="text-center">
              <div className="text-2xl font-bold text-emerald-400">
                {formatCurrency(rows.reduce((sum, r) => sum + calculateVolume(r.qty, r.price), 0))}
              </div>
              <div className="text-sm text-slate-400">Volume Total</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-400">
                {rows.length > 0 ? ((rows.filter(r => Number(r.realizedPnl) > 0).length / rows.length) * 100).toFixed(1) : 0}%
              </div>
              <div className="text-sm text-slate-400">Win Rate</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-400">
                {rows.length > 0 ? formatCurrency(Math.max(...rows.map(r => Number(r.realizedPnl)))) : 'R$ 0,00'}
              </div>
              <div className="text-sm text-slate-400">Melhor Trade</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-400">
                {rows.length > 0 ? formatCurrency(Math.min(...rows.map(r => Number(r.realizedPnl)))) : 'R$ 0,00'}
              </div>
              <div className="text-sm text-slate-400">Pior Trade</div>
            </div>
          </div>

          {/* Métricas de risco */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-gradient-to-r from-red-500/10 to-pink-500/5 backdrop-blur-sm rounded-lg border border-white/10">
            <div className="text-center">
              <div className="text-2xl font-bold text-red-400">
                {formatCurrency(calculateDrawdown(rows).maxDrawdown)}
              </div>
              <div className="text-sm text-slate-400">Max Drawdown</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-pink-400">
                {formatCurrency(calculateDrawdown(rows).currentDrawdown)}
              </div>
              <div className="text-sm text-slate-400">Drawdown Atual</div>
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

      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/5 backdrop-blur-sm p-4 rounded-lg border border-white/10">
        <div className="flex items-center gap-2">
          <button 
            className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2" 
            disabled={page <= 1} 
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <span>←</span>
            <span className="hidden sm:inline">Anterior</span>
          </button>
          <div className="px-4 py-2 bg-blue-500/20 text-blue-400 rounded-lg font-medium text-center min-w-[120px]">
            <div className="text-sm">Página</div>
            <div className="text-lg font-bold">{page} / {totalPages}</div>
          </div>
          <button 
            className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2" 
            disabled={page >= totalPages} 
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <span className="hidden sm:inline">Próximo</span>
            <span>→</span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-slate-300 whitespace-nowrap">Itens por página:</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPageSizeDropdownOpen(!pageSizeDropdownOpen)}
              className="min-w-[80px] flex items-center justify-between gap-2 border border-white/10 bg-white/5 text-white rounded-lg px-3 py-2 hover:bg-white/10 transition-colors focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <span>{pageSize}</span>
              <span className={`transition-transform ${pageSizeDropdownOpen ? 'rotate-180' : ''}`}>⌄</span>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-900 rounded-xl p-6 max-w-md w-full border border-white/10">
            <h3 className="text-xl text-white font-semibold mb-4">Configurar sincronização</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-slate-300 text-sm mb-2">Data inicial</label>
                <input 
                  type="date"
                  value={syncStartDate}
                  onChange={(e) => setSyncStartDate(e.target.value)}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                />
              </div>

              <div>
                <label className="block text-slate-300 text-sm mb-2">Data final</label>
                <input 
                  type="date"
                  value={syncEndDate}
                  onChange={(e) => setSyncEndDate(e.target.value)}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                />
              </div>

              <div>
                <label className="block text-slate-300 text-sm mb-2">Moedas (uma por linha)</label>
                <textarea 
                  value={syncSymbols}
                  onChange={(e) => setSyncSymbols(e.target.value)}
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white h-32"
                  placeholder="BTCUSDT&#10;ETHUSDT&#10;BNBUSDT"
                />
              </div>

              <div className="flex gap-3">
                <button 
                  onClick={syncTrades}
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
    </InternalLayout>
  );
}
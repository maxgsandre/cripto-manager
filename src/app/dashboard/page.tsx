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

async function fetchTrades(month: string): Promise<TradesResponse> {
  const url = `/api/trades?month=${encodeURIComponent(month)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('failed to fetch');
  return res.json();
}

function getMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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
  const [currentBalanceBRL, setCurrentBalanceBRL] = useState('0');
  const [loadingBalance, setLoadingBalance] = useState(false);
  const month = getMonth();

  useEffect(() => {
    fetchTrades(month).then(setData);
  }, [month]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        fetchCurrentBalance();
      }
    });
    return () => unsubscribe();
  }, []);

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

  if (!data) return <InternalLayout><div className="text-white">Carregando...</div></InternalLayout>;

  const { summary, rows } = data;
  const daily = aggregateDaily(rows);
  
  // Calcular PnL de hoje
  const today = new Date().toISOString().slice(0, 10);
  const todayPnl = daily.find(d => d.date === today)?.pnl || 0;

  // Calcular ROI baseado no saldo da Binance
  const calculateROIBinance = () => {
    if (summary.initialBalance === '0' || loadingBalance) return null;
    const initialBalance = Number(summary.initialBalance);
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

  // Calcular PnL baseado no saldo da Binance (diferença entre saldo atual e inicial)
  const calculatePnLBinance = () => {
    if (summary.initialBalance === '0' || loadingBalance) return null;
    const initialBalance = Number(summary.initialBalance);
    const currentBalance = Number(currentBalanceBRL);
    const pnlBinance = currentBalance - initialBalance;
    const isPositive = pnlBinance >= 0;
    return (
      <span className={isPositive ? 'text-green-400' : 'text-red-400'}>
        PnL Binance: {isPositive ? '+' : ''}R$ {pnlBinance.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    );
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
        <button className="bg-white/10 hover:bg-white/15 text-white border border-white/20 px-3 sm:px-4 py-2 rounded-lg flex items-center gap-2 text-sm sm:text-base">
          <span>📅</span>
          <span className="hidden sm:inline">Período</span>
          <span>⌄</span>
        </button>
      </div>

      {/* KPIs Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <EditableBalanceKpi
          label="Saldo Inicial"
          value={summary.initialBalance}
          icon="💳"
          color="purple"
          month={month}
        />
        <Kpi 
          label="PnL Total" 
          value={`R$ ${Number(summary.pnlMonth).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} 
          icon="💰" 
          color="blue"
          trend={Number(summary.pnlMonth) >= 0 ? 'up' : 'down'}
          trendValue={Number(summary.pnlMonth) >= 0 ? '+12.5%' : '-5.2%'}
          subValue={
            loadingBalance 
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
          trend={Number(summary.pnlMonth) >= 0 ? 'up' : 'down'}
          trendValue={Number(summary.pnlMonth) >= 0 ? '+2.1%' : '-1.8%'}
          subValue={
            loadingBalance 
              ? <span className="text-slate-400 animate-pulse">Carregando...</span>
              : calculateROIBinance()
          }
        />
        <Kpi 
          label="Total de Trades" 
          value={summary.tradesCount} 
          icon="📊" 
          color="orange"
          trend="up"
          trendValue="+4 hoje"
        />
      </div>

      {/* PnL Chart */}
      <Card title="PnL Diário" icon="📊" subtitle="Evolução do lucro/prejuízo">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm text-slate-400">Últimos 30 dias</div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-xs text-slate-400">Hoje</p>
              <p className={`flex items-center gap-1 ${todayPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                <span>{todayPnl >= 0 ? '↗️' : '↘️'}</span>
                R$ {Math.abs(todayPnl).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
          </div>
        </div>
        {daily.length > 0 ? (
          <PnlLineChart data={daily} />
        ) : (
          <div className="h-96 flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl">
            <div className="text-center">
              <div className="text-6xl mb-4">📊</div>
              <h3 className="text-lg font-semibold text-slate-300 mb-2">Nenhum dado disponível</h3>
              <p className="text-slate-500">Adicione trades para ver o gráfico de PnL</p>
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



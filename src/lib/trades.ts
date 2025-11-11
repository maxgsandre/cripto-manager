import { prisma } from './prisma';
import { monthRange } from './format';
import { PaginatedResult, TradesQuery } from './types';
// Avoid Prisma.Decimal dependency in node runtime

export type TradeRow = {
  id: string;
  accountId: string;
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
  executedAt: Date;
};

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
  }
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof (value as { toString: () => string }).toString === 'function') {
    const s = (value as { toString: () => string }).toString();
    const n = Number(s);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function decToString(d: unknown): string {
  return toNumber(d).toString();
}

export async function getTrades(
  query: TradesQuery
): Promise<PaginatedResult<TradeRow>> {
  let start: Date;
  let end: Date;
  
  if (query.startDate && query.endDate) {
    start = new Date(query.startDate + 'T00:00:00.000Z');
    end = new Date(query.endDate + 'T23:59:59.999Z');
  } else if (!query.month) {
    throw new Error('month or startDate/endDate is required');
  } else {
    const range = monthRange(query.month);
    start = range.start;
    end = range.end;
  }

  const where = {
    executedAt: { gte: start, lte: end },
    ...(query.accountIds && query.accountIds.length > 0 ? { accountId: { in: query.accountIds } } : {}),
    ...(query.market ? { market: query.market } : {}),
    ...(query.symbol ? { symbol: query.symbol } : {}),
  };

  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 20)));

  const total = await prisma.trade.count({ where });
  
  type DbTrade = {
    id: string;
    accountId: string;
    exchange: string;
    market: string;
    symbol: string;
    side: string;
    qty: unknown;
    price: unknown;
    feeValue: unknown;
    feeAsset: string;
    feePct: unknown;
    realizedPnl: unknown;
    orderId?: string | null;
    tradeId?: string | null;
    orderType?: string | null;
    executedAt: Date;
  };

  // Buscar TODOS os trades filtrados para calcular o summary (sem paginação)
  const allFilteredTrades: DbTrade[] = (await prisma.trade.findMany({
    where,
    orderBy: { executedAt: 'asc' }, // Ordenar por data para calcular drawdown corretamente
  })) as unknown as DbTrade[];

  // Calcular summary com TODOS os trades filtrados
  let pnl = 0;
  let fees = 0;
  let feePctSum = 0;
  let wins = 0;
  let bestTrade = 0;
  let worstTrade = 0;
  let totalVolume = 0;
  let maxDrawdown = 0;
  let currentDrawdown = 0;
  let peak = 0;
  let runningPnL = 0;

  for (const t of allFilteredTrades) {
    const realized = toNumber(t.realizedPnl);
    const qty = toNumber(t.qty);
    const price = toNumber(t.price);
    
    pnl += realized;
    const feeVal = toNumber(t.feeValue);
    fees += feeVal;
    feePctSum += toNumber(t.feePct);
    if (realized > 0) wins += 1;
    
    // Calcular melhor e pior trade
    if (realized > bestTrade) bestTrade = realized;
    if (realized < worstTrade) worstTrade = realized;
    
    // Calcular volume total
    totalVolume += qty * price;
    
    // Calcular drawdown
    runningPnL += realized;
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

  // Buscar apenas os trades da página atual para exibir na tabela
  const trades: DbTrade[] = (await prisma.trade.findMany({
    where,
    orderBy: { executedAt: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize,
  })) as unknown as DbTrade[];

  const rows: TradeRow[] = trades.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    exchange: t.exchange,
    market: t.market,
    symbol: t.symbol,
    side: t.side,
    qty: decToString(t.qty as unknown),
    price: decToString(t.price as unknown),
    feeValue: decToString(t.feeValue as unknown),
    feeAsset: t.feeAsset,
    feePct: decToString(t.feePct as unknown),
    realizedPnl: decToString(t.realizedPnl as unknown),
    orderId: t.orderId,
    tradeId: t.tradeId,
    orderType: t.orderType || null,
    executedAt: t.executedAt,
  }));

  // Buscar saldo inicial do mês (se existir)
  let balanceBRL = '0';
  try {
    // Determinar qual mês usar para buscar o saldo inicial
    let monthToSearch: string;
    
    if (query.startDate && query.endDate) {
      // Período customizado: usar o mês do endDate (último mês do período, onde geralmente há mais trades)
      monthToSearch = query.endDate.substring(0, 7); // Extrai YYYY-MM de YYYY-MM-DD
    } else if (query.month) {
      // Se o month contém underscore (formato customizado), extrair o primeiro mês
      if (query.month.includes('_')) {
        const firstPart = query.month.split('_')[0];
        monthToSearch = firstPart.substring(0, 7); // Garantir formato YYYY-MM
      } else {
        monthToSearch = query.month.substring(0, 7); // Garantir formato YYYY-MM
      }
    } else {
      // Fallback: usar o mês atual
      const now = new Date();
      monthToSearch = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
    
    // Buscar todos os saldos do mês (não precisamos do userId aqui pois é um resumo geral)
    const monthlyBalances = await prisma.monthlyBalance.findMany({
      where: { month: monthToSearch }
    });
    
    // Pegar o último saldo salvo (mais recente)
    if (monthlyBalances.length > 0) {
      const lastBalance = monthlyBalances.sort((a, b) => 
        b.updatedAt.getTime() - a.updatedAt.getTime()
      )[0];
      balanceBRL = lastBalance.initialBalance;
    }
  } catch (error) {
    console.error('Erro ao buscar saldo inicial:', error);
  }

  const losingTrades = total - wins;
  
  const summary = {
    pnlMonth: pnl.toString(),
    feesTotal: fees.toString(),
    avgFeePct: (allFilteredTrades.length > 0 ? (feePctSum / allFilteredTrades.length) : 0).toString(),
    tradesCount: total,
    winRate: total > 0 ? wins / total : 0,
    initialBalance: balanceBRL,
    bestTrade: bestTrade.toString(),
    worstTrade: worstTrade.toString(),
    totalVolume: totalVolume.toString(),
    maxDrawdown: maxDrawdown.toString(),
    currentDrawdown: currentDrawdown.toString(),
    winningTrades: wins,
    losingTrades: losingTrades,
  };

  return { rows, total, summary };
}



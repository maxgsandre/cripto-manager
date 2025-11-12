export type MarketType = 'SPOT' | 'FUTURES' | 'BOTH';

export interface TradesQuery {
  month: string; // YYYY-MM or YYYY-MM-DD_YYYY-MM-DD for custom range
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  market?: MarketType | string;
  symbol?: string;
  page?: number;
  pageSize?: number;
  accountIds?: string[]; // IDs das contas do usuário para filtrar trades
  userId?: string; // ID do usuário para filtrar saldo inicial
}

export interface TradesSummary {
  pnlMonth: string; // decimal as string to avoid fp issues
  feesTotal: string;
  avgFeePct: string;
  tradesCount: number;
  winRate: number; // 0..1
  initialBalance: string; // saldo inicial do mês
  bestTrade: string; // melhor trade (maior PnL)
  worstTrade: string; // pior trade (menor PnL)
  totalVolume: string; // volume total
  maxDrawdown: string; // maior drawdown
  currentDrawdown: string; // drawdown atual
  winningTrades: number; // número de trades vencedores
  losingTrades: number; // número de trades perdedores
}

export interface PaginatedResult<Row> {
  rows: Row[];
  total: number;
  summary: TradesSummary;
}



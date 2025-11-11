import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/encryption';
import { getProxyUrl, proxyGet } from '@/lib/binanceProxyClient';
import { setProgress } from './progress';
import crypto from 'crypto';

export interface SyncResult {
  inserted: number;
  updated: number;
}

async function createSignature(queryString: string, secret: string): Promise<string> {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function fetchBinanceAccountBalance(
  apiKey: string,
  apiSecret: string,
  market: string
): Promise<{ asset: string; free: string; locked: string }[]> {
  const baseUrl = market === 'FUTURES' 
    ? 'https://fapi.binance.com' 
    : 'https://api.binance.com';
  
  const endpoint = market === 'FUTURES'
    ? '/fapi/v2/account'
    : '/api/v3/account';
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {};
  params.recvWindow = 5000;
  params.timestamp = Date.now();
  
  const queryString = new URLSearchParams(params).toString();
  const signature = await createSignature(queryString, apiSecret);
  const fullUrl = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;
  
  const response = await fetch(fullUrl, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Binance API error:', response.status, errorText);
    throw new Error(`Binance API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  // Para SPOT, retorna balances array
  // Para FUTURES, retorna assets com totalWalletBalance
  if (market === 'FUTURES') {
    return data.assets?.map((asset: { asset: string; availableBalance: string; walletBalance: string }) => ({
      asset: asset.asset,
      free: asset.availableBalance,
      locked: asset.walletBalance,
    })) || [];
  } else {
    return data.balances?.filter((b: { free: string; locked: string }) => 
      Number(b.free) > 0 || Number(b.locked) > 0
    ).map((b: { asset: string; free: string; locked: string }) => ({
      asset: b.asset,
      free: b.free,
      locked: b.locked,
    })) || [];
  }
}

interface BinanceTrade {
  id?: number;
  orderId: number;
  symbol: string;
  side?: string; // Obrigatório em FUTURES, opcional em SPOT
  qty?: string;
  quantity?: string;
  price: string;
  commission: string;
  commissionAsset: string;
  realizedPnl?: string;
  time: number;
  isBuyer?: boolean; // Usado em SPOT para determinar se comprou ou vendeu
  isMaker?: boolean; // true = LIMIT (maker), false = MARKET (taker)
}

async function fetchBinanceTrades(
  apiKey: string,
  apiSecret: string,
  market: string,
  symbol?: string,
  startTime?: number,
  endTime?: number,
  authHeader?: string
): Promise<BinanceTrade[]> {
  // Usar proxy quando configurado e quando houver Authorization
  const proxyBase = getProxyUrl();
  if (proxyBase && authHeader) {
    const params = new URLSearchParams();
    params.set('market', market);
    if (symbol) params.set('symbol', symbol);
    if (startTime) params.set('startTime', String(startTime));
    if (endTime) params.set('endTime', String(endTime));
    params.set('limit', '1000');
    const res = await proxyGet<{ ok: boolean; data: BinanceTrade[] }>(`/trades?${params.toString()}`, authHeader);
    return res.data || [];
  }
  const baseUrl = market === 'FUTURES' 
    ? 'https://fapi.binance.com' 
    : 'https://api.binance.com';
  
  const endpoint = market === 'FUTURES'
    ? '/fapi/v1/userTrades'
    : '/api/v3/myTrades';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {};
  if (symbol) params.symbol = symbol;
  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;
  params.limit = 1000;
  params.recvWindow = 5000;
  params.timestamp = Date.now();

  const queryString = new URLSearchParams(params).toString();
  const signature = await createSignature(queryString, apiSecret);
  const fullUrl = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;
  
  console.log('Binance request:', fullUrl.substring(0, 100) + '...');

  const response = await fetch(fullUrl, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Binance API error:', response.status, errorText);
    throw new Error(`Binance API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

export async function syncAccount(
  account: { id: string; market: string }, 
  startDate: string = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], 
  endDate: string = new Date().toISOString().split('T')[0], 
  symbols: string[] = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
  authHeader?: string,
  jobId?: string,
  userId?: string
): Promise<SyncResult> {
  try {
    // Buscar conta no banco
    console.log('Buscando conta:', account.id);
    const acc = await prisma.binanceAccount.findUnique({
      where: { id: account.id },
    });

    if (!acc) {
      console.error('Conta não encontrada:', account.id);
      const allAccounts = await prisma.binanceAccount.findMany();
      console.log('Todas as contas:', allAccounts.map(a => ({ id: a.id, name: a.name })));
      throw new Error('Account not found');
    }
    
    console.log('Conta encontrada:', { name: acc.name, id: acc.id, userId: acc.userId });
    console.log('Verificando se a conta existe no banco...');
    const verifyAccount = await prisma.binanceAccount.findUnique({ where: { id: acc.id } });
    console.log('Verificação:', verifyAccount ? 'EXISTE' : 'NÃO EXISTE');

    // Descriptografar credenciais
    const apiKey = await decrypt(acc.apiKeyEnc);
    const apiSecret = await decrypt(acc.apiSecretEnc);

    // Converter datas para timestamps
    const startTimestamp = new Date(startDate).getTime();
    const endTimestamp = new Date(endDate + 'T23:59:59').getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;

    // Calcular total de steps para progresso
    const days = Math.ceil((endTimestamp - startTimestamp) / oneDayMs);
    const totalSteps = days * symbols.length;
    let currentStep = 0;

    if (jobId && userId) {
      setProgress(jobId, {
        jobId,
        userId,
        totalSteps,
        currentStep: 0,
        status: 'running',
        message: 'Iniciando sincronização...'
      });
    }

    let allTrades: BinanceTrade[] = [];
    
    // Buscar dia por dia para respeitar limite de 24h da API
    for (let currentStart = startTimestamp; currentStart < endTimestamp; currentStart += oneDayMs) {
      const currentEnd = Math.min(currentStart + oneDayMs, endTimestamp);
      const currentDateStr = new Date(currentStart).toISOString().split('T')[0];
      
      for (const symbol of symbols) {
        try {
          currentStep++;
          if (jobId && userId) {
            setProgress(jobId, {
              jobId,
              userId,
              totalSteps,
              currentStep,
              currentSymbol: symbol,
              currentDate: currentDateStr,
              status: 'running',
              message: `Buscando ${symbol} para ${currentDateStr}...`
            });
          }
          
          console.log(`Buscando trades para ${symbol} de ${currentDateStr}...`);
          const trades = await fetchBinanceTrades(apiKey, apiSecret, account.market, symbol, currentStart, currentEnd, authHeader);
          console.log(`API retornou ${trades.length} trades para ${symbol}`);
          if (trades.length > 0) {
            console.log('Exemplo de trade completo:', trades[0]);
          }
          allTrades = allTrades.concat(trades);
        } catch (error) {
          console.error(`Erro ao buscar trades para ${symbol}:`, error);
        }
      }
    }

    let inserted = 0;
    let updated = 0;

    if (jobId && userId) {
      setProgress(jobId, {
        jobId,
        userId,
        totalSteps,
        currentStep: totalSteps,
        status: 'running',
        message: `Processando ${allTrades.length} trades encontrados...`
      });
    }

    // Criar mapa para rastrear posições (compra e venda)
    const positions = new Map<string, Array<{ qty: number; price: number; isBuyer: boolean; time: number }>>();

    for (const trade of allTrades) {
      const tradeId = trade.id || `${trade.orderId}_${trade.symbol}`;
      // Se não vier side direto da API, tentar inferir de isBuyer
      let side = trade.side;
      if (!side && trade.isBuyer !== undefined) {
        side = trade.isBuyer ? 'BUY' : 'SELL';
      }
      // Fallback final
      if (!side) {
        side = 'BUY';
      }
      
      // Inferir tipo de ordem baseado em isMaker
      // isMaker = true significa LIMIT (maker), false significa MARKET (taker)
      // Nota: STOP_LOSS, TAKE_PROFIT, etc. precisariam ser buscados via orderId
      const orderType = trade.isMaker === true ? 'LIMIT' : trade.isMaker === false ? 'MARKET' : null;
      
      // Calcular qty e price como números
      const qty = Number(trade.qty || trade.quantity || '0');
      const price = Number(trade.price);
      
      // Inicializar array de posições para o símbolo se não existir
      if (!positions.has(trade.symbol)) {
        positions.set(trade.symbol, []);
      }
      const symbolPositions = positions.get(trade.symbol)!;
      
      // Calcular PnL se for uma venda
      let realizedPnl = trade.realizedPnl || '0';
      
      if (side === 'SELL' && qty > 0 && price > 0) {
        // Buscar compras anteriores (FIFO)
        let remainingQty = qty;
        let totalPnL = 0;
        
        // Remover compras antigas e calcular PnL
        for (let i = symbolPositions.length - 1; i >= 0 && remainingQty > 0; i--) {
          const pos = symbolPositions[i];
          if (pos.isBuyer && pos.qty > 0) {
            const qtyToUse = Math.min(pos.qty, remainingQty);
            const pnl = (price - pos.price) * qtyToUse;
            totalPnL += pnl;
            
            pos.qty -= qtyToUse;
            remainingQty -= qtyToUse;
            
            if (pos.qty <= 0) {
              symbolPositions.splice(i, 1);
            }
          }
        }
        
        realizedPnl = totalPnL.toString();
      } else if (side === 'BUY') {
        // Adicionar compra às posições
        symbolPositions.push({
          qty,
          price,
          isBuyer: true,
          time: trade.time
        });
      }
      
      console.log('Trade:', { 
        symbol: trade.symbol, 
        sideOriginal: trade.side,
        isBuyer: trade.isBuyer,
        sideFinal: side,
        orderId: trade.orderId,
        realizedPnl
      });
      
      try {
        console.log('Tentando salvar trade com accountId:', acc.id);
        
        // Verificar se o trade já existe
        const existingTrade = await prisma.trade.findUnique({
          where: { id: `${acc.id}_${tradeId}` }
        });
        
        if (existingTrade) {
          await prisma.trade.update({
            where: { id: `${acc.id}_${tradeId}` },
            data: {
              side: side,
              qty: trade.qty || trade.quantity || '0',
              price: trade.price,
              feeValue: trade.commission,
              feeAsset: trade.commissionAsset,
              feePct: '0',
              realizedPnl: realizedPnl,
              orderType: orderType,
              executedAt: new Date(trade.time),
            }
          });
          updated++;
        } else {
          await prisma.trade.create({
            data: {
              id: `${acc.id}_${tradeId}`,
              accountId: acc.id,
              exchange: 'binance',
              market: account.market,
              symbol: trade.symbol,
              side: side,
              qty: trade.qty || trade.quantity || '0',
              price: trade.price,
              feeValue: trade.commission,
              feeAsset: trade.commissionAsset,
              feePct: '0', // TODO: Calcular percentual de fee
              realizedPnl: trade.realizedPnl || '0',
              orderId: trade.orderId.toString(),
              tradeId: String(tradeId),
              orderType: orderType,
              executedAt: new Date(trade.time),
            }
          });
          inserted++;
        }
      } catch (error) {
        console.error('Error upserting trade:', error);
      }
    }

    const result = { inserted, updated };
    
    if (jobId && userId) {
      setProgress(jobId, {
        jobId,
        userId,
        totalSteps,
        currentStep: totalSteps,
        status: 'completed',
        message: `Sincronização concluída! ${inserted} inseridos, ${updated} atualizados`,
        result
      });
    }

    return result;
  } catch (error) {
    console.error('Sync error:', error);
    
    if (jobId && userId) {
      setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 0,
        currentStep: 0,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
    
    throw error;
  }
}



import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/encryption';
import { getProxyUrl, proxyGet } from '@/lib/binanceProxyClient';
import { setProgress } from './progress';
import crypto from 'crypto';

export interface FiatSyncResult {
  inserted: number;
  updated: number;
}

interface BinanceFiatOrder {
  orderNo: string;
  fiatCurrency: string;
  indicatedAmount: string;
  amount: string;
  totalFee: string;
  method: string;
  status: string;
  createTime: number;
  updateTime: number;
}

interface BinanceCryptoDeposit {
  id: string;
  amount: string;
  coin: string;
  network: string;
  status: number; // 0=pending, 1=success, 6=credited
  address: string;
  addressTag?: string;
  txId: string;
  insertTime: number;
  transferType: number;
  confirmTimes: string;
}

interface BinanceCryptoWithdrawal {
  id: string;
  amount: string;
  transactionFee: string;
  coin: string;
  status: number; // 0=Email Sent, 1=Cancelled, 2=Awaiting Approval, 3=Rejected, 4=Processing, 5=Failure, 6=Completed
  address: string;
  addressTag?: string;
  txId: string;
  applyTime: number;
  network: string;
  transferType: number;
  confirmNo: number;
}

async function createSignature(queryString: string, secret: string): Promise<string> {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function fetchBinanceFiatOrders(
  apiKey: string,
  apiSecret: string,
  transactionType: '0' | '1', // 0 = deposit, 1 = withdrawal
  beginTime?: number,
  endTime?: number,
  authHeader?: string,
  accountId?: string
): Promise<BinanceFiatOrder[]> {
  const proxyBase = getProxyUrl();
  
  if (proxyBase && authHeader && accountId) {
    // Usar proxy
    const params = new URLSearchParams();
    params.set('transactionType', transactionType);
    params.set('accountId', accountId);
    if (beginTime) params.set('beginTime', beginTime.toString());
    if (endTime) params.set('endTime', endTime.toString());
    
    try {
      const data = await proxyGet<{ code: string; message: string; data: BinanceFiatOrder[] }>(
        `/fiat/orders?${params.toString()}`,
        authHeader
      );
      
      if (data.code !== '000000') {
        throw new Error(`Binance API error: ${data.message || 'Unknown error'}`);
      }
      
      return data.data || [];
    } catch (error) {
      console.error('Proxy error fetching fiat orders:', error);
      throw error;
    }
  } else {
    // Chamada direta (desenvolvimento local)
    const baseUrl = 'https://api.binance.com';
    const endpoint = '/sapi/v1/fiat/orders';
    
    const params: Record<string, string> = {
      transactionType,
      recvWindow: '5000',
      timestamp: Date.now().toString(),
    };
    
    if (beginTime) params.beginTime = beginTime.toString();
    if (endTime) params.endTime = endTime.toString();
    
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
    
    if (data.code !== '000000') {
      throw new Error(`Binance API error: ${data.message || 'Unknown error'}`);
    }
    
    return data.data || [];
  }
}

async function fetchBinanceCryptoDeposits(
  apiKey: string,
  apiSecret: string,
  startTime?: number,
  endTime?: number,
  authHeader?: string,
  accountId?: string
): Promise<BinanceCryptoDeposit[]> {
  if (!startTime || !endTime) {
    return [];
  }

  // Binance limita crypto deposits/withdrawals a 90 dias por requisição
  const MAX_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const allResults: BinanceCryptoDeposit[] = [];
  const totalDays = Math.ceil((endTime - startTime) / (24 * 60 * 60 * 1000));
  
  // Se o período for <= 90 dias, fazer uma única chamada
  if (totalDays <= 90) {
    const proxyBase = getProxyUrl();
    
    if (proxyBase && authHeader && accountId) {
      const params = new URLSearchParams();
      params.set('accountId', accountId);
      params.set('status', '1');
      params.set('startTime', startTime.toString());
      params.set('endTime', endTime.toString());
      
      try {
        const response = await proxyGet<{ ok: boolean; data: BinanceCryptoDeposit[] }>(
          `/crypto/deposits?${params.toString()}`,
          authHeader
        );
        return Array.isArray(response.data) ? response.data : [];
      } catch (error) {
        console.error('Proxy error fetching crypto deposits:', error);
        throw error;
      }
    } else {
      const baseUrl = 'https://api.binance.com';
      const endpoint = '/sapi/v1/capital/deposit/hisrec';
      
      const params: Record<string, string> = {
        status: '1',
        recvWindow: '5000',
        timestamp: Date.now().toString(),
        startTime: startTime.toString(),
        endTime: endTime.toString(),
      };
      
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
      return Array.isArray(data) ? data : [];
    }
  }
  
  // Dividir em chunks de 90 dias
  for (let currentStart = startTime; currentStart < endTime; currentStart += MAX_DAYS_MS) {
    const currentEnd = Math.min(currentStart + MAX_DAYS_MS - 1, endTime);
    
    const proxyBase = getProxyUrl();
    
    if (proxyBase && authHeader && accountId) {
      const params = new URLSearchParams();
      params.set('accountId', accountId);
      params.set('status', '1');
      params.set('startTime', currentStart.toString());
      params.set('endTime', currentEnd.toString());
      
      try {
        const response = await proxyGet<{ ok: boolean; data: BinanceCryptoDeposit[] }>(
          `/crypto/deposits?${params.toString()}`,
          authHeader
        );
        if (Array.isArray(response.data)) {
          allResults.push(...response.data);
        }
      } catch (error) {
        console.error(`Proxy error fetching crypto deposits for period ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}:`, error);
        // Continuar com próximo chunk mesmo se houver erro
      }
    } else {
      const baseUrl = 'https://api.binance.com';
      const endpoint = '/sapi/v1/capital/deposit/hisrec';
      
      const params: Record<string, string> = {
        status: '1',
        recvWindow: '5000',
        timestamp: Date.now().toString(),
        startTime: currentStart.toString(),
        endTime: currentEnd.toString(),
      };
      
      const queryString = new URLSearchParams(params).toString();
      const signature = await createSignature(queryString, apiSecret);
      const fullUrl = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;
      
      try {
        const response = await fetch(fullUrl, {
          headers: {
            'X-MBX-APIKEY': apiKey,
          },
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Binance API error for period ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}:`, response.status, errorText);
          continue;
        }
        
        const data = await response.json();
        if (Array.isArray(data)) {
          allResults.push(...data);
        }
      } catch (error) {
        console.error(`Error fetching crypto deposits for period ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}:`, error);
      }
    }
  }
  
  return allResults;
}

async function fetchBinanceCryptoWithdrawals(
  apiKey: string,
  apiSecret: string,
  startTime?: number,
  endTime?: number,
  authHeader?: string,
  accountId?: string
): Promise<BinanceCryptoWithdrawal[]> {
  if (!startTime || !endTime) {
    return [];
  }

  // Binance limita crypto deposits/withdrawals a 90 dias por requisição
  const MAX_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  const allResults: BinanceCryptoWithdrawal[] = [];
  const totalDays = Math.ceil((endTime - startTime) / (24 * 60 * 60 * 1000));
  
  // Se o período for <= 90 dias, fazer uma única chamada
  if (totalDays <= 90) {
    const proxyBase = getProxyUrl();
    
    if (proxyBase && authHeader && accountId) {
      const params = new URLSearchParams();
      params.set('accountId', accountId);
      params.set('status', '6');
      params.set('startTime', startTime.toString());
      params.set('endTime', endTime.toString());
      
      try {
        const response = await proxyGet<{ ok: boolean; data: BinanceCryptoWithdrawal[] }>(
          `/crypto/withdrawals?${params.toString()}`,
          authHeader
        );
        return Array.isArray(response.data) ? response.data : [];
      } catch (error) {
        console.error('Proxy error fetching crypto withdrawals:', error);
        throw error;
      }
    } else {
      const baseUrl = 'https://api.binance.com';
      const endpoint = '/sapi/v1/capital/withdraw/history';
      
      const params: Record<string, string> = {
        status: '6',
        recvWindow: '5000',
        timestamp: Date.now().toString(),
        startTime: startTime.toString(),
        endTime: endTime.toString(),
      };
      
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
      return Array.isArray(data) ? data : [];
    }
  }
  
  // Dividir em chunks de 90 dias
  for (let currentStart = startTime; currentStart < endTime; currentStart += MAX_DAYS_MS) {
    const currentEnd = Math.min(currentStart + MAX_DAYS_MS - 1, endTime);
    
    const proxyBase = getProxyUrl();
    
    if (proxyBase && authHeader && accountId) {
      const params = new URLSearchParams();
      params.set('accountId', accountId);
      params.set('status', '6');
      params.set('startTime', currentStart.toString());
      params.set('endTime', currentEnd.toString());
      
      try {
        const response = await proxyGet<{ ok: boolean; data: BinanceCryptoWithdrawal[] }>(
          `/crypto/withdrawals?${params.toString()}`,
          authHeader
        );
        if (Array.isArray(response.data)) {
          allResults.push(...response.data);
        }
      } catch (error) {
        console.error(`Proxy error fetching crypto withdrawals for period ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}:`, error);
        // Continuar com próximo chunk mesmo se houver erro
      }
    } else {
      const baseUrl = 'https://api.binance.com';
      const endpoint = '/sapi/v1/capital/withdraw/history';
      
      const params: Record<string, string> = {
        status: '6',
        recvWindow: '5000',
        timestamp: Date.now().toString(),
        startTime: currentStart.toString(),
        endTime: currentEnd.toString(),
      };
      
      const queryString = new URLSearchParams(params).toString();
      const signature = await createSignature(queryString, apiSecret);
      const fullUrl = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;
      
      try {
        const response = await fetch(fullUrl, {
          headers: {
            'X-MBX-APIKEY': apiKey,
          },
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Binance API error for period ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}:`, response.status, errorText);
          continue;
        }
        
        const data = await response.json();
        if (Array.isArray(data)) {
          allResults.push(...data);
        }
      } catch (error) {
        console.error(`Error fetching crypto withdrawals for period ${new Date(currentStart).toISOString()} to ${new Date(currentEnd).toISOString()}:`, error);
      }
    }
  }
  
  return allResults;
}

export async function syncFiatCashflow(
  account: { id: string },
  startDate: string = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  endDate: string = new Date().toISOString().split('T')[0],
  authHeader?: string,
  jobId?: string,
  userId?: string
): Promise<FiatSyncResult> {
  try {
    const acc = await prisma.binanceAccount.findUnique({
      where: { id: account.id },
      select: { id: true, apiKeyEnc: true, apiSecretEnc: true },
    });

    if (!acc) {
      throw new Error(`Account ${account.id} not found in database`);
    }

    console.log(`[FIAT SYNC] Found account: ${acc.id} for sync`);

    const apiKey = await decrypt(acc.apiKeyEnc);
    const apiSecret = await decrypt(acc.apiSecretEnc);

    const startTimestamp = new Date(startDate + 'T00:00:00.000Z').getTime();
    const endTimestamp = new Date(endDate + 'T23:59:59.999Z').getTime();

    let inserted = 0;
    let updated = 0;

    // Buscar depósitos FIAT (transactionType = '0')
    if (jobId && userId) {
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 4,
        currentStep: 0,
        status: 'running',
        message: 'Buscando depósitos fiat...',
      });
    }

    const fiatDeposits = await fetchBinanceFiatOrders(
      apiKey,
      apiSecret,
      '0',
      startTimestamp,
      endTimestamp,
      authHeader,
      acc.id
    );

    // Buscar saques FIAT (transactionType = '1')
    if (jobId && userId) {
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 4,
        currentStep: 1,
        status: 'running',
        message: 'Buscando saques fiat...',
      });
    }

    const fiatWithdrawals = await fetchBinanceFiatOrders(
      apiKey,
      apiSecret,
      '1',
      startTimestamp,
      endTimestamp,
      authHeader,
      acc.id
    );

    // Buscar depósitos CRYPTO
    if (jobId && userId) {
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 4,
        currentStep: 2,
        status: 'running',
        message: 'Buscando depósitos crypto...',
      });
    }

    const cryptoDeposits = await fetchBinanceCryptoDeposits(
      apiKey,
      apiSecret,
      startTimestamp,
      endTimestamp,
      authHeader,
      acc.id
    );

    // Buscar saques CRYPTO
    if (jobId && userId) {
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 4,
        currentStep: 3,
        status: 'running',
        message: 'Buscando saques crypto...',
      });
    }

    const cryptoWithdrawals = await fetchBinanceCryptoWithdrawals(
      apiKey,
      apiSecret,
      startTimestamp,
      endTimestamp,
      authHeader,
      acc.id
    );

    // Filtrar apenas transações FIAT com status de sucesso (Successful)
    const successfulFiatDeposits = fiatDeposits.filter(order => 
      order.status === 'Successful' || order.status === 'SUCCESS' || order.status === 'success'
    );
    const successfulFiatWithdrawals = fiatWithdrawals.filter(order => 
      order.status === 'Successful' || order.status === 'SUCCESS' || order.status === 'success'
    );
    
    // Crypto já vem filtrado (status 1 para deposits, 6 para withdrawals)
    // Mas vamos garantir que apenas successful sejam processados
    const successfulCryptoDeposits = cryptoDeposits.filter(dep => 
      dep.status === 1 || dep.status === 6 // 1 = success, 6 = credited
    );
    const successfulCryptoWithdrawals = cryptoWithdrawals.filter(wd => 
      wd.status === 6 // 6 = completed
    );
    
    // Converter crypto para formato unificado com marcação de tipo
    const allCryptoDeposits = successfulCryptoDeposits.map(dep => ({
      orderNo: dep.id,
      fiatCurrency: dep.coin,
      amount: dep.amount,
      totalFee: '0',
      method: `${dep.network} Network`,
      status: 'Successful',
      createTime: dep.insertTime,
      updateTime: dep.insertTime,
      _isDeposit: true, // Marcação para identificar tipo
    }));
    
    const allCryptoWithdrawals = successfulCryptoWithdrawals.map(wd => ({
      orderNo: wd.id,
      fiatCurrency: wd.coin,
      amount: wd.amount,
      totalFee: wd.transactionFee,
      method: `${wd.network} Network`,
      status: 'Successful',
      createTime: wd.applyTime,
      updateTime: wd.applyTime,
      _isDeposit: false, // Marcação para identificar tipo
    }));
    
    // Marcar FIAT também
    const markedFiatDeposits = successfulFiatDeposits.map(order => ({ ...order, _isDeposit: true }));
    const markedFiatWithdrawals = successfulFiatWithdrawals.map(order => ({ ...order, _isDeposit: false }));
    
    const allOrders = [
      ...markedFiatDeposits,
      ...markedFiatWithdrawals,
      ...allCryptoDeposits,
      ...allCryptoWithdrawals,
    ];

    if (jobId && userId) {
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: allOrders.length,
        currentStep: 0,
        status: 'running',
        message: `Processando ${allOrders.length} transações (fiat + crypto, apenas concretizadas)...`,
      });
    }

    // Processar cada transação
    for (let i = 0; i < allOrders.length; i++) {
      const order = allOrders[i] as BinanceFiatOrder & { _isDeposit?: boolean };
      // Determinar se é depósito ou saque usando a marcação
      const transactionType = order._isDeposit ? 'DEPOSIT' : 'WITHDRAWAL';
      
      if (jobId && userId) {
        await setProgress(jobId, {
          jobId,
          userId,
          totalSteps: allOrders.length,
          currentStep: i + 1,
          status: 'running',
          message: `Processando transação ${i + 1} de ${allOrders.length}...`,
        });
      }

      // Buscar por orderNo único (usando note como identificador temporário)
      // TODO: Adicionar campo orderNo ao schema para melhor identificação
      const existing = await prisma.cashflow.findFirst({
        where: {
          accountId: acc.id,
          note: { contains: order.orderNo },
        },
      });

      const amount = Number(order.amount) || 0;
      const fee = Number(order.totalFee) || 0;
      const netAmount = transactionType === 'DEPOSIT' ? amount : -amount - fee;

      const data = {
        type: transactionType,
        asset: order.fiatCurrency,
        amount: netAmount.toString(),
        at: new Date(order.createTime),
        note: `OrderNo: ${order.orderNo} | ${order.method} - ${order.status}`,
      };

      // Verificar se a conta ainda existe antes de criar/atualizar
      const accountStillExists = await prisma.binanceAccount.findUnique({
        where: { id: acc.id },
        select: { id: true },
      });

      if (!accountStillExists) {
        console.error(`[FIAT SYNC] Account ${acc.id} no longer exists, skipping cashflow creation for order ${order.orderNo}`);
        continue;
      }

      if (existing) {
        await prisma.cashflow.update({
          where: { id: existing.id },
          data,
        });
        updated++;
      } else {
        await prisma.cashflow.create({
          data: {
            accountId: acc.id,
            ...data,
          },
        });
        inserted++;
      }
    }

    const result = { inserted, updated };

    if (jobId && userId) {
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: allOrders.length,
        currentStep: allOrders.length,
        status: 'completed',
        message: `Sincronização concluída! ${inserted} inseridos, ${updated} atualizados`,
        result,
      });
    }

    return result;
  } catch (error) {
    console.error('Error syncing fiat cashflow:', error);
    
    if (jobId && userId) {
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 0,
        currentStep: 0,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    
    throw error;
  }
}


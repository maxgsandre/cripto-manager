import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/encryption';
import { getProxyUrl, proxyGet } from '@/lib/binanceProxyClient';
import { createJobId, setProgress } from '@/lib/sync/progress';
import crypto from 'crypto';

async function getUserIdFromToken(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  
  const token = authHeader.substring(7);
  
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.user_id || payload.uid || null;
  } catch (error) {
    console.error('Token decode error:', error);
    return null;
  }
}

async function createSignature(queryString: string, secret: string): Promise<string> {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function getCommonSymbols(): string[] {
  return [
    'BTCBRL', 'ETHBRL', 'BNBBRL', 'ADABRL', 'SOLBRL', 'XRPBRL', 'DOGEBRL', 'MATICBRL',
    'DOTBRL', 'AVAXBRL', 'LINKBRL', 'UNIBRL', 'ATOMBRL', 'ETCBRL', 'LTCBRL', 'BCHBRL',
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'MATICUSDT',
    'DOTUSDT', 'AVAXUSDT', 'LINKUSDT', 'UNIUSDT', 'ATOMUSDT', 'ETCUSDT', 'LTCUSDT', 'BCHUSDT'
  ];
}

async function fetchBinanceTradesForSymbolWindow(
  apiKey: string,
  apiSecret: string,
  market: string,
  symbol: string,
  startTime: number,
  endTime: number,
  authHeader?: string
): Promise<{ symbol: string; hasTrades: boolean }> {
  try {
    const proxyBase = getProxyUrl();
    if (proxyBase && authHeader) {
      const params = new URLSearchParams();
      params.set('market', market);
      params.set('symbol', symbol);
      params.set('startTime', String(startTime));
      params.set('endTime', String(endTime));
      params.set('limit', '1'); // Apenas verificar se existe, não precisamos de todos
      const res = await proxyGet<{ ok: boolean; data: Array<{ id: string; symbol: string }> }>(`/trades?${params.toString()}`, authHeader);
      return { symbol, hasTrades: (res.data?.length || 0) > 0 };
    }
    
    const baseUrl = market === 'FUTURES' 
      ? 'https://fapi.binance.com' 
      : 'https://api.binance.com';
    
    const endpoint = market === 'FUTURES'
      ? '/fapi/v1/userTrades'
      : '/api/v3/myTrades';

    const params: Record<string, string | number> = {
      symbol,
      startTime,
      endTime,
      limit: 1, // Apenas verificar se existe, não precisamos de todos
      recvWindow: 5000,
      timestamp: Date.now()
    };

    // Converter todos os valores para string para URLSearchParams
    const paramsString: Record<string, string> = Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    );
    const queryString = new URLSearchParams(paramsString).toString();
    const signature = await createSignature(queryString, apiSecret);
    const fullUrl = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;

    const response = await fetch(fullUrl, {
      headers: {
        'X-MBX-APIKEY': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Se for erro 400 com "Invalid symbol", o símbolo não existe ou não está disponível
      if (response.status === 400 && errorText.includes('Invalid symbol')) {
        return { symbol, hasTrades: false };
      }
      // Se for erro relacionado a período muito grande ou outros erros, logar detalhadamente
      if (response.status === 400) {
        console.log(`[${symbol}] ⚠️ Erro 400: ${errorText.substring(0, 200)}`);
      } else {
        console.log(`[${symbol}] ⚠️ Erro ${response.status}: ${errorText.substring(0, 200)}`);
      }
      return { symbol, hasTrades: false };
    }

    const data = await response.json();
    
    // Verificar se é um array válido
    if (!Array.isArray(data)) {
      console.log(`[${symbol}] ⚠️ Resposta não é array:`, typeof data, JSON.stringify(data).substring(0, 100));
      return { symbol, hasTrades: false };
    }
    
    const hasTrades = data.length > 0;
    if (hasTrades) {
      console.log(`[${symbol}] ✅ Encontrado ${data.length} trade(s) no período ${new Date(startTime).toISOString().split('T')[0]} até ${new Date(endTime).toISOString().split('T')[0]}`);
    }
    return { symbol, hasTrades };
  } catch (error) {
    console.error(`[${symbol}] Erro ao verificar:`, error instanceof Error ? error.message : error);
    return { symbol, hasTrades: false };
  }
}

async function fetchBinanceTradesForSymbol(
  apiKey: string,
  apiSecret: string,
  market: string,
  symbol: string,
  startTime: number,
  endTime: number,
  authHeader?: string
): Promise<{ symbol: string; hasTrades: boolean }> {
  try {
    const proxyBase = getProxyUrl();
    if (proxyBase && authHeader) {
      const params = new URLSearchParams();
      params.set('market', market);
      params.set('symbol', symbol);
      params.set('startTime', String(startTime));
      params.set('endTime', String(endTime));
      params.set('limit', '1'); // Apenas verificar se existe, não precisamos de todos
      const res = await proxyGet<{ ok: boolean; data: Array<{ id: string; symbol: string }> }>(`/trades?${params.toString()}`, authHeader);
      return { symbol, hasTrades: (res.data?.length || 0) > 0 };
    }
    
    const baseUrl = market === 'FUTURES' 
      ? 'https://fapi.binance.com' 
      : 'https://api.binance.com';
    
    const endpoint = market === 'FUTURES'
      ? '/fapi/v1/userTrades'
      : '/api/v3/myTrades';

    const params: Record<string, string | number> = {
      symbol,
      startTime,
      endTime,
      limit: 1, // Apenas verificar se existe
      recvWindow: 5000,
      timestamp: Date.now()
    };

    // Converter todos os valores para string para URLSearchParams
    const paramsString: Record<string, string> = Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, String(value)])
    );
    const queryString = new URLSearchParams(paramsString).toString();
    const signature = await createSignature(queryString, apiSecret);
    const fullUrl = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;

    const response = await fetch(fullUrl, {
      headers: {
        'X-MBX-APIKEY': apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Se for erro 400 com "Invalid symbol", o símbolo não existe ou não está disponível
      if (response.status === 400 && errorText.includes('Invalid symbol')) {
        return { symbol, hasTrades: false };
      }
      // Se for erro relacionado a período muito grande ou outros erros, logar detalhadamente
      if (response.status === 400) {
        console.log(`[${symbol}] ⚠️ Erro 400: ${errorText.substring(0, 200)}`);
      } else {
        console.log(`[${symbol}] ⚠️ Erro ${response.status}: ${errorText.substring(0, 200)}`);
      }
      return { symbol, hasTrades: false };
    }

    const data = await response.json();
    
    // Verificar se é um array válido
    if (!Array.isArray(data)) {
      console.log(`[${symbol}] ⚠️ Resposta não é array:`, typeof data, JSON.stringify(data).substring(0, 100));
      return { symbol, hasTrades: false };
    }
    
    const hasTrades = data.length > 0;
    if (hasTrades) {
      console.log(`[${symbol}] ✅ Encontrado ${data.length} trade(s) no período ${new Date(startTime).toISOString().split('T')[0]} até ${new Date(endTime).toISOString().split('T')[0]}`);
    }
    return { symbol, hasTrades };
  } catch (error) {
    console.error(`[${symbol}] Erro ao verificar:`, error instanceof Error ? error.message : error);
    return { symbol, hasTrades: false };
  }
}

export async function GET(req: NextRequest) {
  // Autenticar usuário
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const includeApi = searchParams.get('includeApi') === 'true';
  const searchAll = searchParams.get('searchAll') === 'true';
  const queryJobId = searchParams.get('jobId'); // Se fornecido, retornar progresso
  const startDateParam = searchParams.get('startDate'); // Data inicial do modal
  const endDateParam = searchParams.get('endDate'); // Data final do modal

  // Se jobId fornecido, retornar progresso
  if (queryJobId) {
    const { getProgress } = await import('@/lib/sync/progress');
    const progress = await getProgress(queryJobId);
    
    if (!progress) {
      return Response.json({ error: 'Job not found' }, { status: 404 });
    }

    if (progress.userId !== userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const percent = progress.totalSteps > 0 
      ? Math.round((progress.currentStep / progress.totalSteps) * 100)
      : 0;

    // Calcular tempo estimado - buscar createdAt diretamente do Prisma
    let estimatedTime = '';
    if (progress.status === 'running' && progress.currentStep > 0 && progress.totalSteps > 0) {
      // Buscar o job do Prisma para ter acesso ao createdAt
      const job = await prisma.syncJob.findUnique({
        where: { jobId: queryJobId },
        select: { createdAt: true }
      });
      const startTime = job?.createdAt ? new Date(job.createdAt).getTime() : Date.now();
      const elapsed = Date.now() - startTime;
      const avgTimePerStep = elapsed / progress.currentStep;
      const remainingSteps = progress.totalSteps - progress.currentStep;
      const estimatedMs = avgTimePerStep * remainingSteps;
      
      if (estimatedMs > 60000) {
        estimatedTime = `~${Math.round(estimatedMs / 60000)} min`;
      } else if (estimatedMs > 1000) {
        estimatedTime = `~${Math.round(estimatedMs / 1000)} seg`;
      } else {
        estimatedTime = '< 1 seg';
      }
    }

    return Response.json({
      jobId: progress.jobId,
      status: progress.status,
      percent,
      currentStep: progress.currentStep,
      totalSteps: progress.totalSteps,
      currentSymbol: progress.currentSymbol,
      message: progress.message,
      estimatedTime,
      result: progress.result,
      error: progress.error,
      symbols: progress.status === 'completed' && progress.result ? (progress.result as { symbols?: string[] }).symbols : undefined,
      count: progress.status === 'completed' && progress.result ? (progress.result as { count?: number }).count : undefined
    });
  }

  // Buscar contas do usuário
  const userAccounts = await prisma.binanceAccount.findMany({
    where: { userId },
    select: { id: true, market: true }
  });

  if (userAccounts.length === 0) {
    return Response.json({ symbols: [], count: 0, source: 'database' }, { status: 200 });
  }

  const accountIds = userAccounts.map(acc => acc.id);

  // Buscar todos os símbolos únicos do banco de dados
  const trades = await prisma.trade.findMany({
    where: {
      accountId: { in: accountIds }
    },
    select: {
      symbol: true,
      market: true
    }
  });

  // Extrair símbolos únicos do banco
  const dbSymbols = Array.from(new Set(trades.map(t => t.symbol))).sort();
  const allSymbols = [...dbSymbols];

  // Se não for busca da API, retornar imediatamente
  if (!includeApi) {
    return Response.json({ 
      symbols: allSymbols,
      count: allSymbols.length,
      source: 'database',
      dbCount: dbSymbols.length,
      apiCount: 0
    }, { status: 200 });
  }

  // Se for busca da API, processar de forma assíncrona
  const jobId = createJobId(userId);
  const authHeader = req.headers.get('authorization') || undefined;

  // Iniciar processamento assíncrono
  (async () => {
    let finalTotalSteps = 0;
    const allSymbolsMutable = [...allSymbols]; // Cópia mutável para o processamento assíncrono
    try {
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 0,
        currentStep: 0,
        status: 'running',
        message: 'Iniciando busca de símbolos...'
      });

      // Buscar símbolos da API para cada conta
      for (const account of userAccounts) {
        try {
          const acc = await prisma.binanceAccount.findUnique({
            where: { id: account.id }
          });
          
          if (!acc) continue;

          const apiKey = await decrypt(acc.apiKeyEnc);
          const apiSecret = await decrypt(acc.apiSecretEnc);

          // Usar as datas do modal ou padrão (últimos 90 dias)
          let endTime: number;
          let startTime: number;
          
          if (startDateParam && endDateParam) {
            // Usar as datas fornecidas pelo modal
            const startDate = new Date(startDateParam + 'T00:00:00.000Z');
            const endDate = new Date(endDateParam + 'T23:59:59.999Z');
            startTime = startDate.getTime();
            endTime = endDate.getTime();
            const daysDiff = Math.ceil((endTime - startTime) / (24 * 60 * 60 * 1000));
            console.log(`🔍 Buscando símbolos no período: ${startDateParam} até ${endDateParam} (${daysDiff} dias)`);
            console.log(`   Timestamps: ${startTime} até ${endTime}`);
          } else {
            // Padrão: últimos 90 dias
            endTime = Date.now();
            startTime = endTime - (90 * 24 * 60 * 60 * 1000);
            console.log(`🔍 Buscando símbolos nos últimos 90 dias (padrão)`);
          }

          let symbolsToTest: string[] = [];

          await setProgress(jobId, {
            jobId,
            userId,
            totalSteps: 0,
            currentStep: 0,
            status: 'running',
            message: searchAll ? 'Buscando lista de todos os símbolos disponíveis...' : 'Preparando busca de símbolos comuns...'
          });

          if (searchAll) {
            // Buscar TODOS os símbolos disponíveis na Binance
            try {
              const baseUrl = account.market === 'FUTURES' 
                ? 'https://fapi.binance.com' 
                : 'https://api.binance.com';
              
              // FUTURES usa /fapi/v1/exchangeInfo, SPOT usa /api/v3/exchangeInfo
              const exchangeInfoUrl = account.market === 'FUTURES'
                ? `${baseUrl}/fapi/v1/exchangeInfo`
                : `${baseUrl}/api/v3/exchangeInfo`;
              
              const exchangeInfoResponse = await fetch(exchangeInfoUrl);
              
              if (exchangeInfoResponse.ok) {
                const exchangeInfo = await exchangeInfoResponse.json();
                // Filtrar apenas símbolos ativos (status: 'TRADING')
                symbolsToTest = exchangeInfo.symbols
                  ?.filter((s: { status: string; symbol: string }) => s.status === 'TRADING')
                  ?.map((s: { symbol: string }) => s.symbol) || [];
                
                console.log(`Encontrados ${symbolsToTest.length} símbolos disponíveis para testar (${account.market})`);
              } else {
                console.error('Erro ao buscar exchangeInfo:', exchangeInfoResponse.status);
                // Fallback para lista comum se exchangeInfo falhar
                symbolsToTest = getCommonSymbols();
              }
            } catch (error) {
              console.error('Erro ao buscar exchangeInfo:', error);
              // Fallback para lista comum
              symbolsToTest = getCommonSymbols();
            }
          } else {
            // Usar apenas lista de símbolos comuns
            symbolsToTest = getCommonSymbols();
          }

          // Verificar quais símbolos têm trades
          // Processar em lotes para não sobrecarregar a API
          const batchSize = 5; // Reduzido para evitar rate limits
          const apiSymbols: string[] = [];
          const totalBatches = Math.ceil(symbolsToTest.length / batchSize);
          finalTotalSteps = totalBatches;
          let currentStep = 0;

          await setProgress(jobId, {
            jobId,
            userId,
            totalSteps: finalTotalSteps,
            currentStep: 0,
            status: 'running',
            message: `Testando ${symbolsToTest.length} símbolos em ${totalBatches} lotes...`
          });

          const startTimeMs = Date.now();

          for (let i = 0; i < symbolsToTest.length; i += batchSize) {
            const batch = symbolsToTest.slice(i, i + batchSize);
            const currentBatch = Math.floor(i / batchSize) + 1;
            currentStep = currentBatch;
            
            // Calcular tempo estimado
            const elapsed = Date.now() - startTimeMs;
            const avgTimePerBatch = elapsed / currentBatch;
            const remainingBatches = totalBatches - currentBatch;
            const estimatedMs = avgTimePerBatch * remainingBatches;
            
            let estimatedTime = '';
            if (estimatedMs > 60000) {
              estimatedTime = `~${Math.round(estimatedMs / 60000)} min restantes`;
            } else if (estimatedMs > 1000) {
              estimatedTime = `~${Math.round(estimatedMs / 1000)} seg restantes`;
            } else {
              estimatedTime = '< 1 seg restante';
            }
            
            await setProgress(jobId, {
              jobId,
              userId,
              totalSteps: finalTotalSteps,
              currentStep,
              currentSymbol: batch[0],
              status: 'running',
              message: `Processando lote ${currentBatch}/${totalBatches} (${batch.length} símbolos)... ${estimatedTime}`
            });
            
            // Processar lote em paralelo
            const symbolChecks = await Promise.all(
              batch.map(symbol => 
                fetchBinanceTradesForSymbol(apiKey, apiSecret, account.market, symbol, startTime, endTime, authHeader)
              )
            );

            // Separar símbolos com trades e sem trades para log detalhado
            const batchSymbols = symbolChecks
              .filter(check => check.hasTrades)
              .map(check => check.symbol);
            
            const batchNoTrades = symbolChecks
              .filter(check => !check.hasTrades)
              .map(check => check.symbol);

            apiSymbols.push(...batchSymbols);
            
            console.log(`📦 Lote ${currentBatch}/${totalBatches} concluído:`);
            console.log(`   ✅ Com trades (${batchSymbols.length}): ${batchSymbols.join(', ') || 'nenhum'}`);
            console.log(`   ❌ Sem trades (${batchNoTrades.length}): ${batchNoTrades.slice(0, 5).join(', ')}${batchNoTrades.length > 5 ? '...' : ''}`);

            // Delay entre lotes para respeitar rate limits
            if (i + batchSize < symbolsToTest.length) {
              await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay entre lotes
            }
          }
          
          console.log(`Total de pares encontrados na API: ${apiSymbols.length}`);

          // Adicionar símbolos da API que não estão no banco
          for (const symbol of apiSymbols) {
            if (!allSymbolsMutable.includes(symbol)) {
              allSymbolsMutable.push(symbol);
            }
          }
        } catch (error) {
          console.error(`Erro ao buscar símbolos da API para conta ${account.id}:`, error);
          await setProgress(jobId, {
            jobId,
            userId,
            totalSteps: 0,
            currentStep: 0,
            status: 'error',
            error: error instanceof Error ? error.message : 'Erro desconhecido'
          });
          return;
        }
      }

      allSymbolsMutable.sort();

      // Salvar resultado no progresso
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: finalTotalSteps || 1,
        currentStep: finalTotalSteps || 1,
        status: 'completed',
        message: `Busca concluída! Encontrados ${allSymbolsMutable.length} pares negociados (${dbSymbols.length} do banco + ${allSymbolsMutable.length - dbSymbols.length} da API)`,
        result: {
          inserted: allSymbolsMutable.length - dbSymbols.length,
          updated: 0
        }
      });
    } catch (error) {
      console.error('Error in async symbol search:', error);
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 0,
        currentStep: 0,
        status: 'error',
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      });
    }
  })().catch(error => {
    console.error('Error in async symbol search:', error);
    setProgress(jobId, {
      jobId,
      userId,
      totalSteps: 0,
      currentStep: 0,
      status: 'error',
      error: error instanceof Error ? error.message : 'Erro desconhecido'
    }).catch(err => console.error('Error setting error progress:', err));
  });

  // Retornar jobId imediatamente
  return Response.json({ 
    ok: true,
    jobId,
    message: 'Busca de símbolos iniciada',
    timestamp: new Date().toISOString()
  }, { status: 200 });
}


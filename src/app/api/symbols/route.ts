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
      const res = await proxyGet<{ ok: boolean; data: any[] }>(`/trades?${params.toString()}`, authHeader);
      return { symbol, hasTrades: (res.data?.length || 0) > 0 };
    }
    
    const baseUrl = market === 'FUTURES' 
      ? 'https://fapi.binance.com' 
      : 'https://api.binance.com';
    
    const endpoint = market === 'FUTURES'
      ? '/fapi/v1/userTrades'
      : '/api/v3/myTrades';

    const params: any = {
      symbol,
      startTime,
      endTime,
      limit: 1, // Apenas verificar se existe
      recvWindow: 5000,
      timestamp: Date.now()
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
      return { symbol, hasTrades: false };
    }

    const data = await response.json();
    return { symbol, hasTrades: Array.isArray(data) && data.length > 0 };
  } catch (error) {
    console.error(`Erro ao verificar ${symbol}:`, error);
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
  const jobId = searchParams.get('jobId'); // Se fornecido, retornar progresso

  // Se jobId fornecido, retornar progresso
  if (jobId) {
    const { getProgress } = await import('@/lib/sync/progress');
    const progress = await getProgress(jobId);
    
    if (!progress) {
      return Response.json({ error: 'Job not found' }, { status: 404 });
    }

    if (progress.userId !== userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const percent = progress.totalSteps > 0 
      ? Math.round((progress.currentStep / progress.totalSteps) * 100)
      : 0;

    // Calcular tempo estimado
    let estimatedTime = '';
    if (progress.status === 'running' && progress.currentStep > 0 && progress.totalSteps > 0) {
      const elapsed = Date.now() - (progress as any).startTime || 0;
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
      symbols: progress.status === 'completed' ? (progress as any).symbols : undefined,
      count: progress.status === 'completed' ? (progress as any).count : undefined
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
  let allSymbols = [...dbSymbols];

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

          // Buscar últimos 90 dias (limite da API)
          const endTime = Date.now();
          const startTime = endTime - (90 * 24 * 60 * 60 * 1000);

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

            const batchSymbols = symbolChecks
              .filter(check => check.hasTrades)
              .map(check => check.symbol);

            apiSymbols.push(...batchSymbols);
            
            console.log(`Lote ${currentBatch}/${totalBatches} concluído. Encontrados ${batchSymbols.length} pares com trades neste lote.`);

            // Delay entre lotes para respeitar rate limits
            if (i + batchSize < symbolsToTest.length) {
              await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay entre lotes
            }
          }
          
          console.log(`Total de pares encontrados na API: ${apiSymbols.length}`);

          // Adicionar símbolos da API que não estão no banco
          for (const symbol of apiSymbols) {
            if (!allSymbols.includes(symbol)) {
              allSymbols.push(symbol);
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

      allSymbols.sort();

      // Salvar resultado no progresso
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: finalTotalSteps || 1,
        currentStep: finalTotalSteps || 1,
        status: 'completed',
        message: `Busca concluída! Encontrados ${allSymbols.length} pares negociados (${dbSymbols.length} do banco + ${allSymbols.length - dbSymbols.length} da API)`,
        result: {
          inserted: allSymbols.length - dbSymbols.length,
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


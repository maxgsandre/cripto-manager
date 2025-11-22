import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createJobId, setProgress } from '@/lib/sync/progress';
import { monthRange } from '@/lib/format';

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

export async function POST(req: NextRequest) {
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { month, startDate, endDate, market, symbol } = body;

    console.log('[Deduplicate API] Filtros recebidos:', { month, startDate, endDate, market, symbol });

    // Buscar todas as contas do usuário
    const userAccounts = await prisma.binanceAccount.findMany({
      where: { userId },
      select: { id: true },
    });

    if (userAccounts.length === 0) {
      return Response.json({ error: 'No accounts found' }, { status: 404 });
    }

    const accountIds = userAccounts.map(acc => acc.id);

    // Determinar range de datas
    let dateFilter: { gte: Date; lte: Date } | undefined;
    if (month) {
      const range = monthRange(month);
      dateFilter = { gte: range.start, lte: range.end };
      console.log('[Deduplicate API] Filtro por mês:', month, '->', range.start.toISOString(), 'até', range.end.toISOString());
    } else if (startDate && endDate) {
      dateFilter = {
        gte: new Date(startDate + 'T00:00:00.000Z'),
        lte: new Date(endDate + 'T23:59:59.999Z')
      };
      console.log('[Deduplicate API] Filtro por período:', startDate, 'até', endDate, '->', dateFilter.gte.toISOString(), 'até', dateFilter.lte.toISOString());
    } else {
      console.log('[Deduplicate API] AVISO: Nenhum filtro de data aplicado! Processando TODOS os trades.');
    }

    // Criar jobId para rastrear progresso
    const jobId = createJobId(userId);
    
    // Criar o job no banco ANTES de retornar o jobId
    await setProgress(jobId, {
      jobId,
      userId,
      totalSteps: 0,
      currentStep: 0,
      status: 'running',
      message: 'Iniciando remoção de duplicatas...'
    });

    // Processar em background
    (async () => {
      let totalDuplicates = 0;
      let totalDeleted = 0;

      // Construir filtros base
      const baseWhere: any = {
        accountId: { in: accountIds },
      };
      if (dateFilter) {
        baseWhere.executedAt = dateFilter;
        console.log('[Deduplicate API] Aplicando filtro de data:', baseWhere.executedAt);
      } else {
        console.log('[Deduplicate API] AVISO: Sem filtro de data - processando TODOS os trades!');
      }
      if (market) {
        baseWhere.market = market.toUpperCase().trim();
        console.log('[Deduplicate API] Aplicando filtro de market:', baseWhere.market);
      }
      if (symbol) {
        baseWhere.symbol = symbol.toUpperCase().trim();
        console.log('[Deduplicate API] Aplicando filtro de symbol:', baseWhere.symbol);
      }
      
      console.log('[Deduplicate API] Filtros finais (baseWhere):', JSON.stringify(baseWhere, null, 2));

      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 2,
        currentStep: 1,
        status: 'running',
        message: 'Buscando duplicatas por Trade ID...'
      });

      // Estratégia 1: Duplicatas por tradeId (manter a mais recente)
      // Trade ID é único por execução na Binance, então se aparecer mais de uma vez é duplicata real
      const tradesByTradeId = await prisma.trade.findMany({
        where: {
          ...baseWhere,
          tradeId: { not: null },
        },
        orderBy: [
          { tradeId: 'asc' },
          { createdAt: 'desc' },
        ],
      });

      const tradeIdGroups = new Map<string, typeof tradesByTradeId>();
      for (const trade of tradesByTradeId) {
        if (!trade.tradeId) continue;
        const key = `${trade.accountId}_${trade.tradeId}`;
        if (!tradeIdGroups.has(key)) {
          tradeIdGroups.set(key, []);
        }
        tradeIdGroups.get(key)!.push(trade);
      }

      for (const [key, trades] of tradeIdGroups) {
        if (trades.length > 1) {
          const toKeep = trades[0];
          const toDelete = trades.slice(1);
          
          for (const trade of toDelete) {
            await prisma.trade.delete({ where: { id: trade.id } });
            totalDeleted++;
          }
          totalDuplicates += trades.length - 1;
        }
      }

      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 2,
        currentStep: 2,
        status: 'running',
        message: 'Buscando duplicatas por características similares...'
      });

      // Estratégia 2: Duplicatas por chave única (timestamp+symbol+side+price+qty)
      // Buscar trades sem orderId e sem tradeId
      const tradesWithoutIds = await prisma.trade.findMany({
        where: {
          ...baseWhere,
          orderId: null,
          tradeId: null,
        },
        orderBy: { createdAt: 'desc' },
      });

      const uniqueKeyGroups = new Map<string, typeof tradesWithoutIds>();
      for (const trade of tradesWithoutIds) {
        const timestamp = Math.floor(trade.executedAt.getTime() / 1000); // Segundos
        const price = parseFloat(trade.price.toString()).toFixed(8);
        const qty = parseFloat(trade.qty.toString()).toFixed(8);
        const key = `${trade.accountId}_${timestamp}_${trade.symbol}_${trade.side}_${price}_${qty}`;
        
        if (!uniqueKeyGroups.has(key)) {
          uniqueKeyGroups.set(key, []);
        }
        uniqueKeyGroups.get(key)!.push(trade);
      }

      for (const [key, trades] of uniqueKeyGroups) {
        if (trades.length > 1) {
          const toKeep = trades[0]; // Mais recente
          const toDelete = trades.slice(1);
          
          for (const trade of toDelete) {
            await prisma.trade.delete({ where: { id: trade.id } });
            totalDeleted++;
          }
          totalDuplicates += trades.length - 1;
        }
      }

      // Atualizar progresso final
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 2,
        currentStep: 2,
        status: 'completed',
        message: `Remoção de duplicatas concluída!`,
        result: {
          inserted: 0,
          updated: totalDeleted
        }
      });
    })().catch(async (error) => {
      console.error('Async deduplicate error:', error);
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 2,
        currentStep: 0,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    });

    // Retornar jobId imediatamente
    return Response.json({
      ok: true,
      message: 'Remoção de duplicatas iniciada',
      jobId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error deduplicating trades:', error);
    return Response.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}


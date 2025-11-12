import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';

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
    // Buscar todas as contas do usuário
    const userAccounts = await prisma.binanceAccount.findMany({
      where: { userId },
      select: { id: true },
    });

    if (userAccounts.length === 0) {
      return Response.json({ error: 'No accounts found' }, { status: 404 });
    }

    const accountIds = userAccounts.map(acc => acc.id);
    let totalDuplicates = 0;
    let totalDeleted = 0;

    // Estratégia 1: Duplicatas por orderId (manter a mais recente)
    const tradesByOrderId = await prisma.trade.findMany({
      where: {
        accountId: { in: accountIds },
        orderId: { not: null },
      },
      orderBy: [
        { orderId: 'asc' },
        { createdAt: 'desc' }, // Mais recente primeiro
      ],
    });

    const orderIdGroups = new Map<string, typeof tradesByOrderId>();
    for (const trade of tradesByOrderId) {
      if (!trade.orderId) continue;
      const key = `${trade.accountId}_${trade.orderId}`;
      if (!orderIdGroups.has(key)) {
        orderIdGroups.set(key, []);
      }
      orderIdGroups.get(key)!.push(trade);
    }

    // Para cada grupo com mais de 1 trade, manter apenas o mais recente
    for (const [key, trades] of orderIdGroups) {
      if (trades.length > 1) {
        const toKeep = trades[0]; // Mais recente (já ordenado)
        const toDelete = trades.slice(1);
        
        for (const trade of toDelete) {
          await prisma.trade.delete({ where: { id: trade.id } });
          totalDeleted++;
        }
        totalDuplicates += trades.length - 1;
      }
    }

    // Estratégia 2: Duplicatas por tradeId (manter a mais recente)
    const tradesByTradeId = await prisma.trade.findMany({
      where: {
        accountId: { in: accountIds },
        tradeId: { not: null },
        orderId: null, // Apenas trades sem orderId
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

    // Estratégia 3: Duplicatas por chave única (timestamp+symbol+side+price+qty)
    // Buscar trades sem orderId e sem tradeId
    const tradesWithoutIds = await prisma.trade.findMany({
      where: {
        accountId: { in: accountIds },
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

    return Response.json({
      ok: true,
      duplicatesFound: totalDuplicates,
      deleted: totalDeleted,
      message: `Removidas ${totalDeleted} trades duplicadas`,
    });
  } catch (error) {
    console.error('Error deduplicating trades:', error);
    return Response.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}


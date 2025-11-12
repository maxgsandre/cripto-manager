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

export async function GET(req: NextRequest) {
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Buscar contas do usuário
    const userAccounts = await prisma.binanceAccount.findMany({
      where: { userId },
      select: { id: true },
    });

    if (userAccounts.length === 0) {
      return Response.json({ 
        earliestDate: null,
        latestDate: null,
        hasData: false
      });
    }

    const accountIds = userAccounts.map(acc => acc.id);

    // Buscar data mais antiga de trades
    const earliestTrade = await prisma.trade.findFirst({
      where: { accountId: { in: accountIds } },
      orderBy: { executedAt: 'asc' },
      select: { executedAt: true },
    });

    // Buscar data mais antiga de cashflow
    const earliestCashflow = await prisma.cashflow.findFirst({
      where: { 
        accountId: { in: accountIds },
        NOT: [{ note: { contains: 'Expired' } }]
      },
      orderBy: { at: 'asc' },
      select: { at: true },
    });

    // Determinar a data mais antiga entre trades e cashflow
    let earliestDate: Date | null = null;
    if (earliestTrade && earliestCashflow) {
      earliestDate = earliestTrade.executedAt < earliestCashflow.at 
        ? earliestTrade.executedAt 
        : earliestCashflow.at;
    } else if (earliestTrade) {
      earliestDate = earliestTrade.executedAt;
    } else if (earliestCashflow) {
      earliestDate = earliestCashflow.at;
    }

    // Buscar data mais recente
    const latestTrade = await prisma.trade.findFirst({
      where: { accountId: { in: accountIds } },
      orderBy: { executedAt: 'desc' },
      select: { executedAt: true },
    });

    const latestCashflow = await prisma.cashflow.findFirst({
      where: { 
        accountId: { in: accountIds },
        NOT: [{ note: { contains: 'Expired' } }]
      },
      orderBy: { at: 'desc' },
      select: { at: true },
    });

    let latestDate: Date | null = null;
    if (latestTrade && latestCashflow) {
      latestDate = latestTrade.executedAt > latestCashflow.at 
        ? latestTrade.executedAt 
        : latestCashflow.at;
    } else if (latestTrade) {
      latestDate = latestTrade.executedAt;
    } else if (latestCashflow) {
      latestDate = latestCashflow.at;
    }

    return Response.json({
      earliestDate: earliestDate ? earliestDate.toISOString().split('T')[0] : null,
      latestDate: latestDate ? latestDate.toISOString().split('T')[0] : null,
      hasData: earliestDate !== null,
    });
  } catch (error) {
    console.error('Error fetching data range:', error);
    return Response.json({ 
      error: 'Internal server error',
      earliestDate: null,
      latestDate: null,
      hasData: false
    }, { status: 500 });
  }
}


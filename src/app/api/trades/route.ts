import { NextRequest } from 'next/server';
import { getTrades } from '@/lib/trades';
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
  // Autenticar usuário
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Buscar contas do usuário
  const userAccounts = await prisma.binanceAccount.findMany({
    where: { userId },
    select: { id: true }
  });

  if (userAccounts.length === 0) {
    return Response.json({ 
      rows: [], 
      total: 0, 
      summary: {
        pnlMonth: '0',
        feesTotal: '0',
        avgFeePct: '0',
        tradesCount: 0,
        winRate: 0,
        initialBalance: '0'
      }
    }, { status: 200 });
  }

  const accountIds = userAccounts.map(acc => acc.id);

  const { searchParams } = new URL(req.url);
  const month = searchParams.get('month') || '';
  const startDate = searchParams.get('startDate') || undefined;
  const endDate = searchParams.get('endDate') || undefined;
  const market = searchParams.get('market') || undefined;
  const symbol = searchParams.get('symbol') || undefined;
  const page = Number(searchParams.get('page') || '1');
  const pageSize = Number(searchParams.get('pageSize') || '20');

  try {
    const data = await getTrades({ 
      month, 
      startDate, 
      endDate, 
      market, 
      symbol, 
      page, 
      pageSize,
      accountIds // Passar accountIds para filtrar apenas trades do usuário
    });
    return Response.json(data, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'internal error';
    return Response.json({ error: message }, { status: 400 });
  }
}



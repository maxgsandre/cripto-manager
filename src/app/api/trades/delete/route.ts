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
    const body = await req.json();
    const { month, startDate, endDate, market, symbol } = body;

    // Buscar todas as contas do usuário
    const userAccounts = await prisma.binanceAccount.findMany({
      where: { userId },
      select: { id: true },
    });

    if (userAccounts.length === 0) {
      return Response.json({ error: 'No accounts found' }, { status: 404 });
    }

    const accountIds = userAccounts.map(acc => acc.id);

    // Construir filtros de data
    const where: {
      accountId: { in: string[] };
      executedAt?: { gte: Date; lte: Date };
      market?: string;
      symbol?: string;
    } = {
      accountId: { in: accountIds },
    };

    // Filtro por mês (YYYY-MM)
    if (month) {
      const [year, monthNum] = month.split('-');
      const startOfMonth = new Date(parseInt(year), parseInt(monthNum) - 1, 1);
      const endOfMonth = new Date(parseInt(year), parseInt(monthNum), 0, 23, 59, 59, 999);
      
      where.executedAt = {
        gte: startOfMonth,
        lte: endOfMonth,
      };
    }
    // Filtro por período customizado
    else if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      where.executedAt = {
        gte: start,
        lte: end,
      };
    }

    // Filtro por market
    if (market) {
      where.market = market.toUpperCase();
    }

    // Filtro por symbol
    if (symbol) {
      where.symbol = symbol.toUpperCase();
    }

    // Contar trades que serão deletados
    const count = await prisma.trade.count({ where });

    if (count === 0) {
      return Response.json({
        ok: true,
        deleted: 0,
        message: 'Nenhum trade encontrado para deletar com os filtros especificados',
      });
    }

    // Deletar trades
    const result = await prisma.trade.deleteMany({ where });

    return Response.json({
      ok: true,
      deleted: result.count,
      message: `${result.count} trade(s) deletado(s) com sucesso`,
    });
  } catch (error) {
    console.error('Error deleting trades:', error);
    return Response.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}


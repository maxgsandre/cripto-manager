import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';

async function getUserIdFromToken(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7);
  
  try {
    // Decode JWT token (simplificado - em produção use Firebase Admin)
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.user_id || payload.uid || null;
  } catch (error) {
    console.error('Token decode error:', error);
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
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
        markets: [],
        symbols: []
      });
    }

    const accountIds = userAccounts.map(acc => acc.id);

    // Verificar se há filtro de market
    const { searchParams } = new URL(req.url);
    const marketFilter = searchParams.get('market');

    // Buscar markets e symbols únicos do banco
    const whereClause: { accountId: { in: string[] }; market?: string } = {
      accountId: { in: accountIds }
    };
    
    if (marketFilter) {
      whereClause.market = marketFilter;
    }

    const trades = await prisma.trade.findMany({
      where: whereClause,
      select: {
        market: true,
        symbol: true
      },
      distinct: ['market', 'symbol']
    });

    // Extrair markets únicos
    const markets = Array.from(new Set(trades.map(t => t.market)))
      .filter(m => m) // Remover vazios
      .sort();

    // Extrair symbols únicos
    const symbols = Array.from(new Set(trades.map(t => t.symbol)))
      .filter(s => s) // Remover vazios
      .sort();

    return Response.json({ 
      markets,
      symbols
    });
  } catch (error) {
    console.error('Error fetching filters:', error);
    return Response.json({ 
      error: 'Internal server error',
      markets: [],
      symbols: []
    }, { status: 500 });
  }
}


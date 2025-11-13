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

  const userAccounts = await prisma.binanceAccount.findMany({
    where: { userId },
    select: { id: true },
  });

  if (userAccounts.length === 0) {
    return Response.json({ total: 0, rows: [] });
  }

  const accountIds = userAccounts.map(acc => acc.id);

  const { searchParams } = new URL(req.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const type = searchParams.get('type'); // 'DEPOSIT' | 'WITHDRAWAL' | null
  const asset = searchParams.get('asset');
  const page = parseInt(searchParams.get('page') || '1');
  const pageSize = parseInt(searchParams.get('pageSize') || '50');

  // Calcular datas
  let start: Date;
  let end: Date;

  if (startDate && endDate) {
    start = new Date(startDate + 'T00:00:00.000Z');
    end = new Date(endDate + 'T23:59:59.999Z');
  } else {
    // Últimos 30 dias por padrão
    end = new Date();
    start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }

  const where: {
    accountId: { in: string[] };
    at: { gte: Date; lte: Date };
    type?: string;
    asset?: string;
    NOT?: Array<{ note?: { contains: string } }>;
  } = {
    accountId: { in: accountIds },
    at: { gte: start, lte: end },
    // Filtrar transações expiradas - não mostrar na lista
    NOT: [
      {
        note: {
          contains: 'Expired'
        }
      }
    ],
  };

  if (type) {
    where.type = type;
  }

  if (asset) {
    where.asset = asset;
  }

  const [total, cashflows, tradesCount, calculatedInitialBalance, summary] = await Promise.all([
    prisma.cashflow.count({ where }),
    prisma.cashflow.findMany({
      where,
      orderBy: { at: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        account: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
    // Contar trades no mesmo período e contas
    prisma.trade.count({
      where: {
        accountId: { in: accountIds },
        executedAt: { gte: start, lte: end },
      },
    }),
    // Saldo inicial calculado removido - deve ser preenchido manualmente
    // A API da Binance não fornece saldo histórico, então não podemos calcular automaticamente
    (async () => {
      return '0';
    })(),
    // Calcular totais de TODAS as transações filtradas (não apenas paginadas)
    (async () => {
      try {
        // Buscar TODAS as transações que correspondem ao filtro (sem paginação)
        const allCashflows = await prisma.cashflow.findMany({
          where,
          select: {
            type: true,
            amount: true,
          },
        });

        // Calcular totais (apenas transações concretizadas, ignorando expiradas)
        let totalDeposits = 0;
        let totalWithdrawals = 0;

        for (const cf of allCashflows) {
          const amount = Number(cf.amount);
          if (cf.type === 'DEPOSIT') {
            totalDeposits += amount;
          } else if (cf.type === 'WITHDRAWAL') {
            totalWithdrawals += Math.abs(amount);
          }
        }

        return {
          totalDeposits: totalDeposits.toString(),
          totalWithdrawals: totalWithdrawals.toString(),
          netCashflow: (totalDeposits - totalWithdrawals).toString(),
        };
      } catch (error) {
        console.error('Error calculating summary:', error);
        return {
          totalDeposits: '0',
          totalWithdrawals: '0',
          netCashflow: '0',
        };
      }
    })(),
  ]);

  const rows = cashflows.map((cf) => ({
    id: cf.id,
    accountId: cf.accountId,
    accountName: cf.account.name,
    type: cf.type,
    asset: cf.asset,
    amount: cf.amount.toString(),
    at: cf.at.toISOString(),
    note: cf.note || null,
  }));

  // Determinar o mês do período filtrado para buscar saldo salvo
  let monthToSearch: string;
  if (startDate) {
    monthToSearch = startDate.substring(0, 7); // YYYY-MM
  } else {
    const now = new Date();
    monthToSearch = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  // Buscar saldo inicial salvo do mês
  let savedInitialBalance = '0';
  try {
    const monthlyBalance = await prisma.monthlyBalance.findUnique({
      where: { userId_month: { userId, month: monthToSearch } }
    });
    if (monthlyBalance) {
      savedInitialBalance = monthlyBalance.initialBalance;
    }
  } catch (error) {
    console.error('Error fetching saved initial balance:', error);
  }

  return Response.json({ 
    total, 
    rows, 
    tradesCount,
    calculatedInitialBalance, // Saldo calculado baseado em depósitos/saques anteriores
    savedInitialBalance, // Saldo editável salvo pelo usuário
    month: monthToSearch, // Mês do período filtrado
    summary, // Totais de depósitos, saques e fluxo líquido de TODAS as transações filtradas
  });
}


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

// Função auxiliar para calcular o saldo inicial automaticamente
async function calculateInitialBalance(userId: string, month: string): Promise<string> {
  // Buscar contas do usuário
  const userAccounts = await prisma.binanceAccount.findMany({
    where: { userId },
    select: { id: true }
  });

  if (userAccounts.length === 0) {
    return '0';
  }

  const accountIds = userAccounts.map(acc => acc.id);
  
  // Calcular mês anterior
  const [year, monthNum] = month.split('-').map(Number);
  const previousMonthStart = new Date(year, monthNum - 2, 1); // Mês anterior
  const previousMonthEnd = new Date(year, monthNum - 1, 0, 23, 59, 59, 999); // Último dia do mês anterior
  const previousMonthStr = `${previousMonthStart.getFullYear()}-${String(previousMonthStart.getMonth() + 1).padStart(2, '0')}`;
  
  // 1. Buscar saldo inicial do mês anterior (salvo ou calculado)
  let previousMonthInitialBalance = '0';
  const previousMonthBalance = await prisma.monthlyBalance.findUnique({
    where: { userId_month: { userId, month: previousMonthStr } }
  });
  
  if (previousMonthBalance) {
    previousMonthInitialBalance = previousMonthBalance.initialBalance;
  } else {
    // Se não há saldo salvo, calcular baseado em cashflows anteriores ao mês anterior
    const cashflowsBeforePreviousMonth = await prisma.cashflow.findMany({
      where: {
        accountId: { in: accountIds },
        at: { lt: previousMonthStart },
        asset: { in: ['BRL', 'brl'] },
        NOT: [{ note: { contains: 'Expired' } }],
      },
    });
    let calc = 0;
    for (const cf of cashflowsBeforePreviousMonth) {
      calc += Number(cf.amount); // amount já tem sinal
    }
    previousMonthInitialBalance = calc.toString();
  }
  
  // 2. Buscar depósitos e saques do mês anterior
  const previousMonthCashflows = await prisma.cashflow.findMany({
    where: {
      accountId: { in: accountIds },
      at: { gte: previousMonthStart, lte: previousMonthEnd },
      asset: { in: ['BRL', 'brl'] },
      NOT: [{ note: { contains: 'Expired' } }],
    },
  });
  
  let previousMonthDepositsMinusWithdrawals = 0;
  for (const cf of previousMonthCashflows) {
    previousMonthDepositsMinusWithdrawals += Number(cf.amount); // amount já tem sinal
  }
  
  // 3. Buscar PnL do mês anterior (trades)
  const previousMonthTrades = await prisma.trade.findMany({
    where: {
      accountId: { in: accountIds },
      executedAt: { gte: previousMonthStart, lte: previousMonthEnd },
    },
  });
  
  let previousMonthPnL = 0;
  for (const t of previousMonthTrades) {
    previousMonthPnL += Number(t.realizedPnl); // PnL pode ser positivo ou negativo
  }
  
  // 4. Calcular saldo final do mês anterior
  // Saldo final = Saldo inicial + Depósitos - Saques + PnL
  const previousMonthFinalBalance = 
    Number(previousMonthInitialBalance) + 
    previousMonthDepositsMinusWithdrawals + 
    previousMonthPnL;
  
  // 5. Saldo inicial do mês atual = Saldo final do mês anterior
  return previousMonthFinalBalance.toString();
}

export async function GET(req: NextRequest) {
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const month = searchParams.get('month');

  if (!month) {
    return Response.json({ error: 'month parameter is required' }, { status: 400 });
  }

  try {
    const balance = await prisma.monthlyBalance.findUnique({
      where: { userId_month: { userId, month } }
    });

    // Se não há saldo salvo, calcular baseado no saldo final do mês anterior
    // Saldo inicial do mês = Saldo final do mês anterior
    // Saldo final do mês anterior = Saldo inicial do mês anterior + Depósitos - Saques + PnL
    if (!balance || balance.initialBalance === '0') {
      const calculatedBalance = await calculateInitialBalance(userId, month);
      return Response.json({ 
        ok: true, 
        balance: calculatedBalance,
        calculated: true // Indica que é um valor calculado, não salvo
      });
    }

    return Response.json({ 
      ok: true, 
      balance: balance?.initialBalance || '0',
      calculated: false
    });
  } catch (error) {
    console.error('Error fetching balance:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const month = body.month;
  const initialBalance = body.initialBalance;

  if (!month) {
    return Response.json({ error: 'month is required' }, { status: 400 });
  }

  try {
    // Se o valor for vazio, "0", null ou undefined, deletar o registro e calcular automaticamente
    const isEmpty = !initialBalance || initialBalance === '' || initialBalance === '0' || initialBalance === null || initialBalance === undefined;
    
    if (isEmpty) {
      // Deletar o registro se existir (usando deleteMany para evitar erro se não existir)
      try {
        await prisma.monthlyBalance.delete({
          where: { userId_month: { userId, month } }
        });
      } catch (error) {
        // Ignorar erro se o registro não existir
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((error as any)?.code !== 'P2025') {
          throw error;
        }
      }
      
      // Calcular o saldo automaticamente
      const calculatedBalance = await calculateInitialBalance(userId, month);
      
      console.log(`[MonthlyBalance] Saldo deletado e recalculado: userId=${userId}, month=${month}, calculatedBalance=${calculatedBalance}`);
      return Response.json({ 
        ok: true, 
        balance: calculatedBalance,
        calculated: true // Indica que é um valor calculado, não salvo
      });
    }

    // Se há um valor, salvar normalmente
    const balance = await prisma.monthlyBalance.upsert({
      where: { userId_month: { userId, month } },
      update: { initialBalance },
      create: { userId, month, initialBalance }
    });

    console.log(`[MonthlyBalance] Saldo salvo: userId=${userId}, month=${month}, initialBalance=${initialBalance}`);
    return Response.json({ 
      ok: true, 
      balance: balance.initialBalance,
      calculated: false // Indica que é um valor salvo manualmente
    });
  } catch (error) {
    console.error('Error updating balance:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}


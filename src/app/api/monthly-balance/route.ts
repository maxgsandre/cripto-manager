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

// Função removida: cálculo automático desabilitado
// A API da Binance não fornece saldo histórico, então o saldo inicial deve ser preenchido manualmente

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

    // Se não há saldo salvo, retornar 0 (deve ser preenchido manualmente)
    // A API da Binance não fornece saldo histórico, então não podemos calcular automaticamente
    if (!balance || balance.initialBalance === '0') {
      return Response.json({ 
        ok: true, 
        balance: '0',
        calculated: false // Não calculado, deve ser preenchido manualmente
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
      // Deletar o registro se existir
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
      
      // Retornar 0 quando deletado (deve ser preenchido manualmente)
      console.log(`[MonthlyBalance] Saldo deletado: userId=${userId}, month=${month}`);
      return Response.json({ 
        ok: true, 
        balance: '0',
        calculated: false // Não calculado, deve ser preenchido manualmente
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


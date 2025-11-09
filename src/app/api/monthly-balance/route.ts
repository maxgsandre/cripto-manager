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

  const { searchParams } = new URL(req.url);
  const month = searchParams.get('month');

  if (!month) {
    return Response.json({ error: 'month parameter is required' }, { status: 400 });
  }

  try {
    const balance = await prisma.monthlyBalance.findUnique({
      where: { userId_month: { userId, month } }
    });

    return Response.json({ 
      ok: true, 
      balance: balance?.initialBalance || '0' 
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

  if (!month || !initialBalance) {
    return Response.json({ error: 'month and initialBalance are required' }, { status: 400 });
  }

  try {
    const balance = await prisma.monthlyBalance.upsert({
      where: { userId_month: { userId, month } },
      update: { initialBalance },
      create: { userId, month, initialBalance }
    });

    console.log(`[MonthlyBalance] Saldo salvo: userId=${userId}, month=${month}, initialBalance=${initialBalance}`);
    return Response.json({ ok: true, balance: balance.initialBalance });
  } catch (error) {
    console.error('Error updating balance:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}


import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
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

function toCsvRow(values: (string | number | null | undefined)[]): string {
  return values
    .map((v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    })
    .join(',');
}

export async function GET(req: NextRequest) {
  // Autenticar usuário
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Buscar contas do usuário
  const userAccounts = await prisma.binanceAccount.findMany({
    where: { userId },
    select: { id: true }
  });

  if (userAccounts.length === 0) {
    return new Response('No accounts found', { status: 404 });
  }

  const accountIds = userAccounts.map(acc => acc.id);

  const { searchParams } = new URL(req.url);
  const month = searchParams.get('month') || '';
  const startDate = searchParams.get('startDate') || undefined;
  const endDate = searchParams.get('endDate') || undefined;
  const market = searchParams.get('market') || undefined;
  const symbol = searchParams.get('symbol') || undefined;

  let start: Date;
  let end: Date;
  let filename: string;

  if (startDate && endDate) {
    start = new Date(startDate + 'T00:00:00.000Z');
    end = new Date(endDate + 'T23:59:59.999Z');
    filename = `trades_${startDate}_${endDate}.csv`;
  } else if (month) {
    const range = monthRange(month);
    start = range.start;
    end = range.end;
    filename = `trades_${month}.csv`;
  } else {
    return new Response('month or startDate/endDate query is required', { status: 400 });
  }

  const where = {
    executedAt: { gte: start, lte: end },
    accountId: { in: accountIds }, // Filtrar apenas trades do usuário
    ...(market ? { market } : {}),
    ...(symbol ? { symbol } : {}),
  };

  const trades = await prisma.trade.findMany({ where, orderBy: { executedAt: 'asc' } });

  const headers = [
    'executedAt','exchange','market','symbol','side','qty','price','feeValue','feeAsset','feePct','realizedPnl','orderId','tradeId'
  ];

  const lines: string[] = [];
  lines.push(headers.join(','));
  for (const t of trades) {
    lines.push(
      toCsvRow([
        t.executedAt.toISOString(),
        t.exchange,
        t.market,
        t.symbol,
        t.side,
        String(t.qty),
        String(t.price),
        String(t.feeValue),
        t.feeAsset,
        String(t.feePct),
        String(t.realizedPnl),
        t.orderId ?? '',
        t.tradeId ?? '',
      ])
    );
  }

  const body = lines.join('\n');
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}



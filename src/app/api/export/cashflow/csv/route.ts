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

function getDateRange(startDate?: string, endDate?: string, month?: string): { start: Date; end: Date; filename: string } {
  if (startDate && endDate) {
    return {
      start: new Date(startDate + 'T00:00:00.000Z'),
      end: new Date(endDate + 'T23:59:59.999Z'),
      filename: `cashflow_${startDate}_${endDate}.csv`
    };
  } else if (month) {
    const [year, monthNum] = month.split('-').map(Number);
    const start = new Date(year, monthNum - 1, 1);
    const end = new Date(year, monthNum, 0, 23, 59, 59, 999);
    return {
      start,
      end,
      filename: `cashflow_${month}.csv`
    };
  } else {
    // Últimos 30 dias por padrão
    const end = new Date();
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return {
      start,
      end,
      filename: `cashflow_${start.toISOString().split('T')[0]}_${end.toISOString().split('T')[0]}.csv`
    };
  }
}

export async function GET(req: NextRequest) {
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userAccounts = await prisma.binanceAccount.findMany({
    where: { userId },
    select: { id: true }
  });

  if (userAccounts.length === 0) {
    return new Response('No accounts found', { status: 404 });
  }

  const accountIds = userAccounts.map(acc => acc.id);

  const { searchParams } = new URL(req.url);
  const month = searchParams.get('month') || undefined;
  const startDate = searchParams.get('startDate') || undefined;
  const endDate = searchParams.get('endDate') || undefined;
  const type = searchParams.get('type') || undefined;
  const asset = searchParams.get('asset') || undefined;

  const { start, end, filename } = getDateRange(startDate, endDate, month);

  const where: {
    accountId: { in: string[] };
    at: { gte: Date; lte: Date };
    type?: string;
    asset?: string;
    NOT?: Array<{ note?: { contains: string } }>;
  } = {
    accountId: { in: accountIds },
    at: { gte: start, lte: end },
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

  const cashflows = await prisma.cashflow.findMany({
    where,
    orderBy: { at: 'asc' },
    include: {
      account: {
        select: {
          name: true
        }
      }
    }
  });

  const headers = [
    'Data/Hora',
    'Conta',
    'Tipo',
    'Moeda',
    'Valor',
    'Observações'
  ];

  const lines: string[] = [];
  lines.push(headers.join(','));
  
  for (const cf of cashflows) {
    lines.push(
      toCsvRow([
        cf.at.toISOString(),
        cf.account.name,
        cf.type,
        cf.asset,
        String(cf.amount),
        cf.note || ''
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


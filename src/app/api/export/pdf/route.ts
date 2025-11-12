import { NextRequest } from 'next/server';
export const runtime = 'nodejs';
import { prisma } from '@/lib/prisma';
import { monthRange } from '@/lib/format';
// no Prisma.Decimal in this route; use native numbers

// pdfkit import será lazy para evitar puxar dependências pesadas no build

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
  let label: string;
  let filename: string;

  if (startDate && endDate) {
    start = new Date(startDate + 'T00:00:00.000Z');
    end = new Date(endDate + 'T23:59:59.999Z');
    label = `${startDate} a ${endDate}`;
    filename = `report_${startDate}_${endDate}.pdf`;
  } else if (month) {
    const range = monthRange(month);
    start = range.start;
    end = range.end;
    label = range.label;
    filename = `report_${label}.pdf`;
  } else {
    return new Response('month or startDate/endDate query is required', { status: 400 });
  }
  const where = {
    executedAt: { gte: start, lte: end },
    accountId: { in: accountIds }, // Filtrar apenas trades do usuário
    ...(market ? { market } : {}),
    ...(symbol ? { symbol } : {}),
  };

  const trades = await prisma.trade.findMany({ where });

  // Compute summary using native numbers
  const toNum = (v: unknown) => Number(v ?? 0);
  let pnl = 0;
  let fees = 0;
  for (const t of trades) {
    pnl += toNum(t.realizedPnl);
    fees += toNum(t.feeValue);
  }
  const tradesCount = trades.length;

  // Bankroll up to month end using cashflows (deposits - withdrawals) - FILTRADO POR USUÁRIO
  const cashflows = await prisma.cashflow.findMany({ 
    where: { 
      accountId: { in: accountIds }, // Filtrar apenas cashflows das contas do usuário
      at: { lte: end },
      asset: { in: ['BRL', 'brl'] }, // Apenas BRL
      NOT: [
        {
          note: {
            contains: 'Expired'
          }
        }
      ],
    } 
  });
  let bankroll = 0;
  for (const c of cashflows) {
    // amount já tem sinal: positivo para DEPOSIT, negativo para WITHDRAWAL
    bankroll += toNum(c.amount);
  }
  const roi = bankroll === 0 ? 0 : pnl / bankroll;

  // Build PDF (dynamic import to avoid bundling issues with Turbopack)
  const pdfkitModule = await import('pdfkit');
  const PDFDocument = pdfkitModule.default || pdfkitModule;
  
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: unknown) => {
    if (Buffer.isBuffer(c)) {
      chunks.push(c);
    }
  });

  doc.fontSize(18).text('Relatório - Binance Manager', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Período: ${label}`);
  if (market) doc.text(`Mercado: ${market}`);
  if (symbol) doc.text(`Símbolo: ${symbol}`);
  doc.moveDown();

  doc.fontSize(14).text('Resumo', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(12);
  doc.text(`PnL do mês: ${pnl.toFixed(2)}`);
  doc.text(`Taxas totais: ${fees.toFixed(2)}`);
  doc.text(`Trades: ${tradesCount}`);
  doc.text(`ROI (aprox.): ${(roi * 100).toFixed(2)}%`);
  doc.moveDown();

  doc.fontSize(14).text('Observações');
  doc.fontSize(10);
  doc.text('• ROI usa caixa acumulada por Cashflow (depósitos - saques) até o fim do mês.');
  doc.text('• Relatório não considera marcação a mercado; apenas realizedPnl.');

  doc.end();

  const bodyBuf = await new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  return new Response(new Uint8Array(bodyBuf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}



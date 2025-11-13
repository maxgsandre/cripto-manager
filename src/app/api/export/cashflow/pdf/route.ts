import { NextRequest } from 'next/server';
export const runtime = 'nodejs';
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

function getDateRange(startDate?: string, endDate?: string, month?: string): { start: Date; end: Date; label: string; filename: string } {
  if (startDate && endDate) {
    return {
      start: new Date(startDate + 'T00:00:00.000Z'),
      end: new Date(endDate + 'T23:59:59.999Z'),
      label: `${startDate} a ${endDate}`,
      filename: `cashflow_${startDate}_${endDate}.pdf`
    };
  } else if (month) {
    const [year, monthNum] = month.split('-').map(Number);
    const start = new Date(year, monthNum - 1, 1);
    const end = new Date(year, monthNum, 0, 23, 59, 59, 999);
    const monthNames = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    return {
      start,
      end,
      label: `${monthNames[monthNum - 1]} de ${year}`,
      filename: `cashflow_${month}.pdf`
    };
  } else {
    // Últimos 30 dias por padrão
    const end = new Date();
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return {
      start,
      end,
      label: `${start.toISOString().split('T')[0]} a ${end.toISOString().split('T')[0]}`,
      filename: `cashflow_${start.toISOString().split('T')[0]}_${end.toISOString().split('T')[0]}.pdf`
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

  const { start, end, label, filename } = getDateRange(startDate, endDate, month);

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

  const toNum = (v: unknown) => Number(v ?? 0);
  let totalDeposits = 0;
  let totalWithdrawals = 0;
  
  for (const cf of cashflows) {
    const amount = toNum(cf.amount);
    if (cf.type === 'DEPOSIT') {
      totalDeposits += amount;
    } else if (cf.type === 'WITHDRAWAL') {
      totalWithdrawals += Math.abs(amount);
    }
  }
  
  const netCashflow = totalDeposits - totalWithdrawals;
  const transactionsCount = cashflows.length;

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

  doc.fontSize(18).text('Relatório - Depósitos e Saques', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Período: ${label}`);
  if (type) doc.text(`Tipo: ${type}`);
  if (asset) doc.text(`Moeda: ${asset}`);
  doc.moveDown();

  doc.fontSize(14).text('Resumo', { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(12);
  doc.text(`Total de Depósitos: R$ ${totalDeposits.toFixed(2)}`);
  doc.text(`Total de Saques: R$ ${totalWithdrawals.toFixed(2)}`);
  doc.text(`Fluxo de Caixa Líquido: R$ ${netCashflow.toFixed(2)}`);
  doc.text(`Total de Transações: ${transactionsCount}`);
  doc.moveDown();

  if (cashflows.length > 0) {
    doc.fontSize(14).text('Transações', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10);
    
    // Listar transações de forma simples
    for (const cf of cashflows) {
      const dateStr = new Date(cf.at).toLocaleString('pt-BR');
      const amount = toNum(cf.amount);
      const amountStr = amount >= 0 ? `R$ ${amount.toFixed(2)}` : `-R$ ${Math.abs(amount).toFixed(2)}`;
      
      doc.text(`${dateStr.substring(0, 16)} | ${cf.account.name} | ${cf.type} | ${cf.asset} | ${amountStr} | ${(cf.note || '').substring(0, 40)}`);
      doc.moveDown(0.2);
    }
  }

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


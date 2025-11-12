import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createJobId, setProgress } from '@/lib/sync/progress';

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

interface CSVRow {
  'Data (UTC)': string;
  'Tipo': string;
  'Moeda': string;
  'Valor': string;
  'Taxa': string;
  'Método'?: string;
  'Método de Pagamento'?: string;
  'Status': string;
  'Número do Pedido': string;
}

function parseCSV(csvText: string): CSVRow[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows: CSVRow[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    if (values.length !== headers.length) continue;
    
    const row: Partial<CSVRow> = {};
    headers.forEach((header, idx) => {
      row[header as keyof CSVRow] = values[idx];
    });
    rows.push(row as CSVRow);
  }
  
  return rows;
}

export async function POST(request: Request) {
  try {
    const userId = await getUserIdFromToken(request as NextRequest);
    if (!userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    const accountId = formData.get('accountId') as string;

    if (!file) {
      return Response.json({ error: 'File is required' }, { status: 400 });
    }

    if (!accountId) {
      return Response.json({ error: 'accountId is required' }, { status: 400 });
    }

    // Verificar se a conta pertence ao usuário
    const account = await prisma.binanceAccount.findFirst({
      where: { id: accountId, userId },
    });

    if (!account) {
      return Response.json({ error: 'Account not found' }, { status: 404 });
    }

    const csvText = await file.text();
    const rows = parseCSV(csvText);

    if (rows.length === 0) {
      return Response.json({ error: 'CSV file is empty or invalid' }, { status: 400 });
    }

    const jobId = createJobId(userId);

    // Processar CSV em background
    (async () => {
      let inserted = 0;
      let updated = 0;

      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: rows.length,
        currentStep: 0,
        status: 'running',
        message: `Processando ${rows.length} linhas do CSV...`,
      });

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        
        await setProgress(jobId, {
          jobId,
          userId,
          totalSteps: rows.length,
          currentStep: i + 1,
          status: 'running',
          message: `Processando linha ${i + 1} de ${rows.length}...`,
        });

        try {
          // Parse data
          const dateStr = row['Data (UTC)'];
          const type = row['Tipo']?.toUpperCase() === 'DEPÓSITO' || row['Tipo']?.toUpperCase() === 'DEPOSIT' 
            ? 'DEPOSIT' 
            : 'WITHDRAWAL';
          const asset = row['Moeda'] || 'BRL';
          const amountStr = row['Valor']?.replace(/[^\d.,-]/g, '').replace(',', '.') || '0';
          const feeStr = row['Taxa']?.replace(/[^\d.,-]/g, '').replace(',', '.') || '0';
          const method = (row['Método'] || row['Método de Pagamento'] || '') as string;
          const status = row['Status'] || '';
          const orderNo = row['Número do Pedido'] || `csv_${Date.now()}_${i}`;

          const amount = parseFloat(amountStr) || 0;
          const fee = parseFloat(feeStr) || 0;
          const netAmount = type === 'DEPOSIT' ? amount : -amount - fee;

          // Parse date (formato pode variar: DD/MM/YYYY, YYYY-MM-DD, etc)
          let date: Date;
          if (dateStr.includes('/')) {
            const [day, month, year] = dateStr.split('/');
            date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
          } else {
            date = new Date(dateStr);
          }

          if (isNaN(date.getTime())) {
            console.warn(`Invalid date: ${dateStr}, skipping row ${i}`);
            continue;
          }

          const data = {
            type,
            asset,
            amount: netAmount.toString(),
            at: date,
            note: `OrderNo: ${orderNo} | ${method} - ${status}`,
          };

          // Buscar por orderNo no note
          const existing = await prisma.cashflow.findFirst({
            where: {
              accountId,
              note: { contains: `OrderNo: ${orderNo}` },
            },
          });

          if (existing) {
            await prisma.cashflow.update({
              where: { id: existing.id },
              data,
            });
            updated++;
          } else {
            await prisma.cashflow.create({
              data: {
                accountId,
                ...data,
              },
            });
            inserted++;
          }
        } catch (error) {
          console.error(`Error processing row ${i}:`, error);
          // Continue processing other rows
        }
      }

      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: rows.length,
        currentStep: rows.length,
        status: 'completed',
        message: `Importação concluída! ${inserted} inseridos, ${updated} atualizados`,
        result: { inserted, updated },
      });
    })().catch(error => {
      console.error('Error importing CSV:', error);
      setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 0,
        currentStep: 0,
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
      }).catch(err => console.error('Error setting progress:', err));
    });

    return Response.json({
      ok: true,
      message: 'Importação iniciada',
      jobId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error importing CSV:', error);
    return Response.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}


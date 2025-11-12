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

// Interface para CSV de trades da Binance (formato pode variar)
interface TradeCSVRow {
  'Date(UTC)'?: string;
  'Date'?: string;
  'Pair'?: string;
  'Symbol'?: string;
  'Type'?: string;
  'Side'?: string;
  'Order Price'?: string;
  'Price'?: string;
  'Order Amount'?: string;
  'Quantity'?: string;
  'Executed'?: string;
  'Filled'?: string;
  'AvgTrading Price'?: string;
  'Total'?: string;
  'Amount'?: string;
  'Fee'?: string;
  'Fee Coin'?: string;
  'Fee Asset'?: string;
  'Status'?: string;
  'Order ID'?: string;
  'OrderId'?: string;
  'Trade ID'?: string;
  'TradeId'?: string;
  'Market'?: string;
  'Exchange'?: string;
  'Order Type'?: string;
  'OrderType'?: string;
  'Realized PnL'?: string;
  'RealizedPnl'?: string;
  'PnL'?: string;
}

function parseCSV(csvText: string): TradeCSVRow[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  
  // Parsear headers (pode ter aspas ou não)
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows: TradeCSVRow[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    // Parsear linha considerando que valores podem ter vírgulas dentro de aspas
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim()); // Último valor
    
    if (values.length !== headers.length) {
      console.warn(`Linha ${i + 1} tem ${values.length} colunas, mas esperado ${headers.length}. Pulando...`);
      continue;
    }
    
    const row: Partial<TradeCSVRow> = {};
    headers.forEach((header, idx) => {
      row[header as keyof TradeCSVRow] = values[idx]?.replace(/^"|"$/g, '') || '';
    });
    rows.push(row as TradeCSVRow);
  }
  
  return rows;
}

function parseNumber(value: string | undefined): number {
  if (!value) return 0;
  // Remover caracteres não numéricos exceto ponto, vírgula e sinal negativo
  const cleaned = value.replace(/[^\d.,-]/g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  
  // Tentar vários formatos comuns
  // Formato 1: YYYY-MM-DD HH:MM:SS
  if (dateStr.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)) {
    return new Date(dateStr.replace(' ', 'T') + 'Z');
  }
  
  // Formato 2: DD/MM/YYYY HH:MM:SS
  if (dateStr.match(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/)) {
    const [datePart, timePart] = dateStr.split(' ');
    const [day, month, year] = datePart.split('/');
    return new Date(`${year}-${month}-${day}T${timePart}Z`);
  }
  
  // Formato 3: ISO string
  try {
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) return date;
  } catch (e) {
    // Ignorar
  }
  
  return null;
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
      let skipped = 0;

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
          // Extrair dados do CSV (suportar múltiplos formatos)
          const dateStr = row['Date(UTC)'] || row['Date'] || '';
          const symbol = row['Pair'] || row['Symbol'] || '';
          const sideStr = (row['Type'] || row['Side'] || '').toUpperCase();
          const priceStr = row['Order Price'] || row['Price'] || row['AvgTrading Price'] || '0';
          const qtyStr = row['Order Amount'] || row['Quantity'] || row['Executed'] || row['Filled'] || '0';
          const feeStr = row['Fee'] || '0';
          const feeAsset = row['Fee Coin'] || row['Fee Asset'] || '';
          const orderId = row['Order ID'] || row['OrderId'] || '';
          const tradeId = row['Trade ID'] || row['TradeId'] || '';
          const market = (row['Market'] || account.market || 'SPOT').toUpperCase();
          const exchange = row['Exchange'] || 'BINANCE';
          const orderType = row['Order Type'] || row['OrderType'] || null;
          const realizedPnlStr = row['Realized PnL'] || row['RealizedPnl'] || row['PnL'] || '0';

          // Validar campos obrigatórios
          if (!symbol || !dateStr) {
            console.warn(`Linha ${i + 1} está incompleta (sem símbolo ou data). Pulando...`);
            skipped++;
            continue;
          }

          // Parsear valores
          const executedAt = parseDate(dateStr);
          if (!executedAt) {
            console.warn(`Linha ${i + 1} tem data inválida: ${dateStr}. Pulando...`);
            skipped++;
            continue;
          }

          // Determinar side (BUY/SELL)
          let side = 'BUY';
          if (sideStr.includes('SELL') || sideStr === 'S') {
            side = 'SELL';
          } else if (sideStr.includes('BUY') || sideStr === 'B') {
            side = 'BUY';
          }

          const price = parseNumber(priceStr);
          const qty = parseNumber(qtyStr);
          const feeValue = parseNumber(feeStr);
          const realizedPnl = parseNumber(realizedPnlStr);

          // Calcular feePct (taxa percentual)
          const feePct = price > 0 && qty > 0 ? (feeValue / (price * qty)) * 100 : 0;

          // Determinar feeAsset se não fornecido
          const finalFeeAsset = feeAsset || (symbol.includes('BRL') ? 'BRL' : 'USDT');

          // Buscar trade existente por orderId e tradeId (se disponível)
          let existing = null;
          if (orderId) {
            existing = await prisma.trade.findFirst({
              where: {
                accountId,
                orderId: orderId.toString(),
                ...(tradeId ? { tradeId: tradeId.toString() } : {}),
              },
            });
          }

          const tradeData = {
            accountId,
            exchange,
            market,
            symbol,
            side,
            qty: qty.toString(),
            price: price.toString(),
            feeValue: feeValue.toString(),
            feeAsset: finalFeeAsset,
            feePct: feePct.toString(),
            realizedPnl: realizedPnl.toString(),
            orderId: orderId || null,
            tradeId: tradeId || null,
            orderType: orderType || null,
            executedAt,
          };

          if (existing) {
            await prisma.trade.update({
              where: { id: existing.id },
              data: tradeData,
            });
            updated++;
          } else {
            await prisma.trade.create({
              data: tradeData,
            });
            inserted++;
          }
        } catch (error) {
          console.error(`Error processing row ${i + 1}:`, error);
          skipped++;
          // Continue processing other rows
        }
      }

      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: rows.length,
        currentStep: rows.length,
        status: 'completed',
        message: `Importação concluída! ${inserted} inseridos, ${updated} atualizados, ${skipped} ignorados`,
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


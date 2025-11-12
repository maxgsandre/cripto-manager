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
  'Average Price'?: string;
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
  'OrderNo'?: string;
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
  } catch {
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
    const jobIdToResume = formData.get('jobId') as string; // JobId para retomar (opcional)

    if (!file && !jobIdToResume) {
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

    // Verificar se é retomada de job anterior
    let startFrom = 0;
    const jobId = jobIdToResume || createJobId(userId);
    let rows: TradeCSVRow[] = [];
    
    if (jobIdToResume) {
      // Retomar job existente
      const existingJob = await prisma.syncJob.findUnique({
        where: { jobId: jobIdToResume },
      });
      
      if (!existingJob || existingJob.userId !== userId) {
        return Response.json({ error: 'Job not found or unauthorized' }, { status: 404 });
      }
      
      if (existingJob.status === 'completed') {
        return Response.json({ error: 'Job already completed' }, { status: 400 });
      }
      
      startFrom = existingJob.currentStep || 0;
      
      // Se não tiver arquivo, precisa do arquivo original (não implementado ainda - requer salvar CSV)
      if (!file) {
        return Response.json({ error: 'File required to resume' }, { status: 400 });
      }
    }

    const csvText = await file.text();
    rows = parseCSV(csvText);

    if (rows.length === 0) {
      return Response.json({ error: 'CSV file is empty or invalid' }, { status: 400 });
    }

    // Processar CSV em background
    (async () => {
      let inserted = 0;
      let updated = 0;
      let skipped = 0;

      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: rows.length,
        currentStep: startFrom,
        status: 'running',
        message: startFrom > 0 ? `Retomando da linha ${startFrom + 1} de ${rows.length}...` : `Processando ${rows.length} linhas do CSV...`,
      });

      // Processar em batches maiores para melhor performance
      const BATCH_SIZE = 500; // Processar 500 linhas por vez
      const PROGRESS_UPDATE_INTERVAL = 50; // Atualizar progresso a cada 50 linhas

      // Buscar todos os trades existentes de uma vez (otimização)
      // Criar um mapa de orderId/tradeId -> id do trade para updates rápidos
      const existingTradesMap = new Map<string, string>(); // orderId -> trade.id
      
      // Coletar todos os orderIds, tradeIds e chaves únicas do CSV
      const csvOrderIds: string[] = [];
      const csvTradeIds: string[] = [];
      const csvUniqueKeys: Array<{ date: Date; symbol: string; side: string; price: string; qty: string }> = [];
      
      for (let i = startFrom; i < rows.length; i++) {
        const row = rows[i];
        const orderId = row['Order ID'] || row['OrderId'] || row['OrderNo'] || '';
        const tradeId = row['Trade ID'] || row['TradeId'] || '';
        
        if (orderId) {
          csvOrderIds.push(orderId.toString());
        } else if (tradeId) {
          csvTradeIds.push(tradeId.toString());
        } else {
          // Preparar dados para gerar chave única depois
          const dateStr = row['Date(UTC)'] || row['Date'] || '';
          const symbol = row['Pair'] || row['Symbol'] || '';
          const sideStr = (row['Side'] || '').toUpperCase();
          let side = 'BUY';
          if (sideStr.includes('SELL') || sideStr === 'S') {
            side = 'SELL';
          } else if (sideStr.includes('BUY') || sideStr === 'B') {
            side = 'BUY';
          }
          const priceStr = row['Average Price'] || row['AvgTrading Price'] || row['Order Price'] || row['Price'] || '0';
          let qtyStr = row['Executed'] || row['Filled'] || row['Order Amount'] || row['Quantity'] || '0';
          if (qtyStr && /^[\d.]+[A-Z]+$/.test(qtyStr.replace(/\s/g, ''))) {
            qtyStr = qtyStr.replace(/[A-Z]+/g, '').trim();
          }
          
          const executedAt = parseDate(dateStr);
          if (executedAt && symbol) {
            csvUniqueKeys.push({
              date: executedAt,
              symbol,
              side,
              price: priceStr,
              qty: qtyStr,
            });
          }
        }
      }
      
      // Buscar trades existentes por orderId/tradeId
      if (csvOrderIds.length > 0 || csvTradeIds.length > 0) {
        const existingTrades = await prisma.trade.findMany({
          where: {
            accountId,
            OR: [
              ...(csvOrderIds.length > 0 ? [{ orderId: { in: csvOrderIds } }] : []),
              ...(csvTradeIds.length > 0 ? [{ tradeId: { in: csvTradeIds } }] : []),
            ],
          },
          select: { id: true, orderId: true, tradeId: true, executedAt: true, symbol: true, side: true, price: true, qty: true },
        });
        
        // Criar mapa para lookup rápido
        existingTrades.forEach(t => {
          // Buscar side do trade para criar chave única completa
          // Como não temos side no select, vamos buscar depois ou usar uma query diferente
          if (t.orderId) {
            existingTradesMap.set(`${accountId}_${t.orderId}`, t.id);
          }
          if (t.tradeId) {
            existingTradesMap.set(`${accountId}_${t.tradeId}`, t.id);
          }
        });
      }
      
      // Buscar trades existentes por chave única (timestamp+symbol+price+qty)
      if (csvUniqueKeys.length > 0) {
        // Agrupar por data para otimizar queries
        const dateGroups = new Map<string, typeof csvUniqueKeys>();
        csvUniqueKeys.forEach(key => {
          const dateKey = key.date.toISOString().split('T')[0]; // YYYY-MM-DD
          if (!dateGroups.has(dateKey)) {
            dateGroups.set(dateKey, []);
          }
          dateGroups.get(dateKey)!.push(key);
        });
        
        // Buscar trades por data e símbolo
        for (const [dateKey, keys] of dateGroups) {
          const symbols = [...new Set(keys.map(k => k.symbol))];
          const startOfDay = new Date(dateKey + 'T00:00:00Z');
          const endOfDay = new Date(dateKey + 'T23:59:59Z');
          
          // Buscar trades por data, símbolo e side (para evitar confundir BUY/SELL)
          const sides = [...new Set(keys.map(k => k.side))];
          const existingTrades = await prisma.trade.findMany({
            where: {
              accountId,
              symbol: { in: symbols },
              side: { in: sides },
              executedAt: {
                gte: startOfDay,
                lte: endOfDay,
              },
              orderId: null,
              tradeId: null,
            },
            select: { id: true, executedAt: true, symbol: true, side: true, price: true, qty: true },
          });
          
          // Criar mapa de chaves únicas (incluir side para evitar confundir BUY/SELL)
          existingTrades.forEach(t => {
            const timestamp = Math.floor(t.executedAt.getTime() / 1000); // Segundos para reduzir precisão
            const normalizedPrice = parseFloat(t.price.toString()).toFixed(8); // 8 casas decimais
            const normalizedQty = parseFloat(t.qty.toString()).toFixed(8);
            const uniqueKey = `${accountId}_${timestamp}_${t.symbol}_${t.side}_${normalizedPrice}_${normalizedQty}`;
            existingTradesMap.set(uniqueKey, t.id);
          });
        }
      }

      // Processar em batches
      for (let batchStart = startFrom; batchStart < rows.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, rows.length);
        
        type TradeData = {
          accountId: string;
          exchange: string;
          market: string;
          symbol: string;
          side: string;
          qty: string;
          price: string;
          feeValue: string;
          feeAsset: string;
          feePct: string;
          realizedPnl: string;
          orderId: string | null;
          tradeId: string | null;
          orderType: string | null;
          executedAt: Date;
        };
        
        const tradesToCreate: TradeData[] = [];
        const tradesToUpdate: Array<{ id: string; data: TradeData }> = [];
        
        for (let i = batchStart; i < batchEnd; i++) {
          const row = rows[i];
          
          try {
            // Extrair dados do CSV (suportar múltiplos formatos da Binance)
            const dateStr = row['Date(UTC)'] || row['Date'] || '';
            const symbol = row['Pair'] || row['Symbol'] || '';
            // Side é BUY/SELL, não confundir com Type (que é Order Type)
            const sideStr = (row['Side'] || '').toUpperCase();
            // Priorizar "Average Price" (preço médio de execução) sobre "Order Price" (preço da ordem)
            const priceStr = row['Average Price'] || row['AvgTrading Price'] || row['Order Price'] || row['Price'] || '0';
            
            // Formato Binance: "Executed" pode vir como "0.045ETH" (número + símbolo)
            // Priorizar "Executed" (quantidade executada) sobre "Order Amount" (quantidade da ordem)
            let qtyStr = row['Executed'] || row['Filled'] || row['Order Amount'] || row['Quantity'] || '0';
            // Se tiver formato "0.045ETH", extrair apenas o número
            if (qtyStr && /^[\d.]+[A-Z]+$/.test(qtyStr.replace(/\s/g, ''))) {
              qtyStr = qtyStr.replace(/[A-Z]+/g, '').trim();
            }
            
            // Se qtyStr for "0" mas tiver "Order Amount", usar Order Amount como fallback
            if (qtyStr === '0' || !qtyStr) {
              const orderAmount = row['Order Amount'] || row['Quantity'] || '0';
              if (orderAmount && orderAmount !== '0') {
                qtyStr = orderAmount;
                if (qtyStr && /^[\d.]+[A-Z]+$/.test(qtyStr.replace(/\s/g, ''))) {
                  qtyStr = qtyStr.replace(/[A-Z]+/g, '').trim();
                }
              }
            }
            
            // Formato Binance: "Fee" pode vir como "0.000045ETH" (número + símbolo)
            // Alguns CSVs não têm campo Fee, então deixar como 0
            let feeStr = row['Fee'] || '0';
            let feeAsset = row['Fee Coin'] || row['Fee Asset'] || '';
            
            // Se Fee tiver formato "0.000045ETH" ou "0.24295372BRL", extrair número e símbolo
            if (feeStr && feeStr !== '0') {
              const cleanedFeeStr = feeStr.replace(/\s/g, '');
              if (cleanedFeeStr && /^[\d.]+[A-Z]+$/.test(cleanedFeeStr)) {
                const feeMatch = cleanedFeeStr.match(/^([\d.]+)([A-Z]+)$/);
                if (feeMatch) {
                  feeStr = feeMatch[1];
                  feeAsset = feeMatch[2];
                }
              }
            }
            
            // Formato Binance: "Amount" pode vir como "1000.395BRL" (número + símbolo)
            // Mas não precisamos usar Amount, já temos Price e Executed
            
            // Suportar múltiplos formatos de Order ID
            const orderId = row['Order ID'] || row['OrderId'] || row['OrderNo'] || '';
            const tradeId = row['Trade ID'] || row['TradeId'] || '';
            const market = (row['Market'] || account.market || 'SPOT').toUpperCase();
            const exchange = row['Exchange'] || 'BINANCE';
            // Suportar múltiplos formatos de Order Type
            const orderType = row['Order Type'] || row['OrderType'] || row['Type'] || null;
            // Calcular PnL se não vier no CSV
            // PnL = (preço_venda - preço_compra) * quantidade - fees
            // Mas como não temos histórico de compras, vamos deixar como 0 por enquanto
            const realizedPnlStr = row['Realized PnL'] || row['RealizedPnl'] || row['PnL'] || '0';
            
            // Filtrar apenas ordens FILLED (executadas) se houver campo Status
            const status = row['Status'] || '';
            if (status && status.toUpperCase() !== 'FILLED' && status.toUpperCase() !== 'FULLY_FILLED') {
              // Pular ordens não executadas (NEW, CANCELED, PARTIALLY_FILLED, etc)
              skipped++;
              continue;
            }

            // Validar campos obrigatórios
            if (!symbol || !dateStr) {
              skipped++;
              continue;
            }

            const executedAt = parseDate(dateStr);
            if (!executedAt) {
              skipped++;
              continue;
            }

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
            const feePct = price > 0 && qty > 0 ? (feeValue / (price * qty)) * 100 : 0;
            
            // Determinar feeAsset se não fornecido
            // Se ainda não tiver feeAsset, tentar inferir do símbolo do par
            let finalFeeAsset = feeAsset;
            if (!finalFeeAsset) {
              // Se o par termina com BRL, a fee geralmente é em BRL ou na moeda base
              if (symbol.endsWith('BRL')) {
                // Para SELL, fee geralmente é em BRL; para BUY, pode ser na moeda base
                finalFeeAsset = side === 'SELL' ? 'BRL' : symbol.replace('BRL', '');
              } else if (symbol.endsWith('USDT')) {
                finalFeeAsset = side === 'SELL' ? 'USDT' : symbol.replace('USDT', '');
              } else {
                // Tentar extrair a moeda base (primeira parte do par)
                const baseCurrency = symbol.match(/^([A-Z]+)/)?.[1];
                finalFeeAsset = baseCurrency || 'USDT';
              }
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

            // Verificar se já existe (usando cache - lookup O(1))
            // Criar chave única mais robusta para evitar duplicatas
            let uniqueKey = '';
            if (orderId) {
              // Se tiver orderId, usar orderId + accountId (mesmo orderId pode existir em contas diferentes)
              uniqueKey = `${accountId}_${orderId.toString()}`;
            } else if (tradeId) {
              // Se tiver tradeId, usar tradeId + accountId
              uniqueKey = `${accountId}_${tradeId.toString()}`;
            } else {
              // Gerar chave única baseada em accountId+timestamp+par+side+preço+qty
              // Incluir side para evitar confundir BUY e SELL no mesmo momento
              // Usar valores numéricos normalizados para comparação precisa
              const timestamp = Math.floor(executedAt.getTime() / 1000); // Segundos para reduzir precisão
              const normalizedPrice = parseFloat(price.toString()).toFixed(8); // 8 casas decimais
              const normalizedQty = parseFloat(qty.toString()).toFixed(8);
              uniqueKey = `${accountId}_${timestamp}_${symbol}_${side}_${normalizedPrice}_${normalizedQty}`;
            }
            
            const existingId = existingTradesMap.get(uniqueKey);
            
            if (existingId) {
              // Trade já existe, atualizar
              tradesToUpdate.push({ id: existingId, data: tradeData });
            } else {
              // Verificar se já está no batch atual (evitar duplicatas dentro do mesmo CSV)
              const alreadyInBatch = tradesToCreate.some(t => {
                if (orderId && t.orderId === orderId) return true;
                if (tradeId && t.tradeId === tradeId) return true;
                // Verificar por chave única
                const tTimestamp = Math.floor(new Date(t.executedAt).getTime() / 1000);
                const tPrice = parseFloat(t.price.toString()).toFixed(8);
                const tQty = parseFloat(t.qty.toString()).toFixed(8);
                const tKey = `${accountId}_${tTimestamp}_${t.symbol}_${t.side}_${tPrice}_${tQty}`;
                return tKey === uniqueKey;
              });
              
              if (!alreadyInBatch) {
                tradesToCreate.push(tradeData);
              } else {
                skipped++; // Duplicata dentro do mesmo batch
              }
            }
          } catch (error) {
            console.error(`Error processing row ${i + 1}:`, error);
            skipped++;
          }
        }
        
        // Executar batch de creates com verificação adicional de duplicatas
        if (tradesToCreate.length > 0) {
          try {
            // Verificar duplicatas uma última vez antes de inserir (buscar por orderId/tradeId se disponível)
            type TradeData = {
              accountId: string;
              exchange: string;
              market: string;
              symbol: string;
              side: string;
              qty: string;
              price: string;
              feeValue: string;
              feeAsset: string;
              feePct: string;
              realizedPnl: string;
              orderId: string | null;
              tradeId: string | null;
              orderType: string | null;
              executedAt: Date;
            };
            const tradesToInsert: TradeData[] = [];
            const orderIdsToCheck = tradesToCreate.filter(t => t.orderId).map(t => t.orderId!);
            const tradeIdsToCheck = tradesToCreate.filter(t => t.tradeId).map(t => t.tradeId!);
            
            if (orderIdsToCheck.length > 0 || tradeIdsToCheck.length > 0) {
              const lastCheck = await prisma.trade.findMany({
                where: {
                  accountId,
                  OR: [
                    ...(orderIdsToCheck.length > 0 ? [{ orderId: { in: orderIdsToCheck } }] : []),
                    ...(tradeIdsToCheck.length > 0 ? [{ tradeId: { in: tradeIdsToCheck } }] : []),
                  ],
                },
                select: { id: true, orderId: true, tradeId: true },
              });
              
              const existingOrderIds = new Set(lastCheck.filter(t => t.orderId).map(t => t.orderId!));
              const existingTradeIds = new Set(lastCheck.filter(t => t.tradeId).map(t => t.tradeId!));
              
              // Filtrar trades que já existem
              for (const tradeData of tradesToCreate) {
                const exists = (tradeData.orderId && existingOrderIds.has(tradeData.orderId)) ||
                              (tradeData.tradeId && existingTradeIds.has(tradeData.tradeId));
                if (!exists) {
                  tradesToInsert.push(tradeData);
                } else {
                  skipped++; // Duplicata encontrada na última verificação
                }
              }
            } else {
              tradesToInsert.push(...tradesToCreate);
            }
            
            if (tradesToInsert.length > 0) {
              await prisma.trade.createMany({
                data: tradesToInsert,
                skipDuplicates: true, // Proteção adicional
              });
              inserted += tradesToInsert.length;
            }
          } catch (error) {
            console.error('Error in batch create:', error);
            // Fallback: criar individualmente com verificação
            for (const tradeData of tradesToCreate) {
              try {
                // Verificar se já existe antes de criar
                let exists = false;
                if (tradeData.orderId) {
                  const existing = await prisma.trade.findFirst({
                    where: { accountId, orderId: tradeData.orderId },
                  });
                  exists = !!existing;
                } else if (tradeData.tradeId) {
                  const existing = await prisma.trade.findFirst({
                    where: { accountId, tradeId: tradeData.tradeId },
                  });
                  exists = !!existing;
                }
                
                if (!exists) {
                  await prisma.trade.create({ data: tradeData });
                  inserted++;
                } else {
                  skipped++;
                }
              } catch {
                skipped++;
              }
            }
          }
        }
        
        // Executar batch de updates
        for (const { id, data } of tradesToUpdate) {
          try {
            await prisma.trade.update({
              where: { id },
              data,
            });
            updated++;
          } catch (error) {
            console.error(`Error updating trade ${id}:`, error);
            skipped++;
          }
        }
        
        // Atualizar progresso
        if (batchEnd % PROGRESS_UPDATE_INTERVAL === 0 || batchEnd === rows.length) {
          await setProgress(jobId, {
            jobId,
            userId,
            totalSteps: rows.length,
            currentStep: batchEnd,
            status: 'running',
            message: `Processando linha ${batchEnd} de ${rows.length}...`,
          });
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


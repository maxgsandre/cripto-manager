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

export async function POST(req: NextRequest) {
  try {
    const userId = await getUserIdFromToken(req);
    if (!userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Buscar todas as contas do usuário
    const accounts = await prisma.binanceAccount.findMany({
      where: { userId },
      select: { id: true }
    });

    if (accounts.length === 0) {
      return Response.json({ error: 'No accounts found' }, { status: 404 });
    }

    const accountIds = accounts.map(acc => acc.id);
    let totalUpdated = 0;

    // Para cada conta, recalcular PnL
    for (const accountId of accountIds) {
      // Buscar todos os trades da conta, ordenados por data (mais antigo primeiro)
      const allTrades = await prisma.trade.findMany({
        where: { accountId },
        orderBy: { executedAt: 'asc' }
      });

      // Criar mapa de posições (compras) por símbolo
      const positions = new Map<string, Array<{ qty: number; price: number; tradeId: string }>>();

      for (const trade of allTrades) {
        const symbol = trade.symbol;
        const qty = Number(trade.qty);
        const price = Number(trade.price);
        const side = trade.side;

        if (!positions.has(symbol)) {
          positions.set(symbol, []);
        }
        const symbolPositions = positions.get(symbol)!;

        if (side === 'BUY') {
          // Adicionar compra às posições
          symbolPositions.push({
            qty,
            price,
            tradeId: trade.id
          });
        } else if (side === 'SELL' && qty > 0 && price > 0) {
          // Calcular PnL usando FIFO
          let remainingQty = qty;
          let totalPnL = 0;

          // Processar do início ao fim (primeira compra primeiro)
          for (let i = 0; i < symbolPositions.length && remainingQty > 0; i++) {
            const pos = symbolPositions[i];
            if (pos.qty > 0) {
              const qtyToUse = Math.min(pos.qty, remainingQty);
              const pnl = (price - pos.price) * qtyToUse;
              totalPnL += pnl;

              pos.qty -= qtyToUse;
              remainingQty -= qtyToUse;

              if (pos.qty <= 0) {
                symbolPositions.splice(i, 1);
                i--; // Ajustar índice após remover elemento
              }
            }
          }

          // Atualizar o PnL do trade
          if (totalPnL !== Number(trade.realizedPnl)) {
            await prisma.trade.update({
              where: { id: trade.id },
              data: { realizedPnl: totalPnL.toString() }
            });
            totalUpdated++;
          }
        }
      }
    }

    return Response.json({
      ok: true,
      message: `PnL recalculado para ${totalUpdated} trades`,
      updated: totalUpdated
    });
  } catch (error) {
    console.error('Error recalculating PnL:', error);
    return Response.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}


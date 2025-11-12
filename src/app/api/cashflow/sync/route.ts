import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { syncFiatCashflow } from '@/lib/sync/fiat';
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

export async function POST(request: Request) {
  try {
    const userId = await getUserIdFromToken(request as NextRequest);
    if (!userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const startDate = body.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = body.endDate || new Date().toISOString().split('T')[0];

    const accounts = await prisma.binanceAccount.findMany({
      where: { userId },
      select: { id: true, name: true },
    });

    if (accounts.length === 0) {
      return Response.json({ error: 'No accounts found' }, { status: 404 });
    }

    console.log(`[CASHFLOW SYNC] Found ${accounts.length} account(s) for user ${userId}:`, accounts.map(a => ({ id: a.id, name: a.name })));

    const jobId = createJobId(userId);

    // Executar sincronização em background
    (async () => {
      const results: { accountId: string; name: string; inserted: number; updated: number; error?: string }[] = [];
      
      for (const acc of accounts) {
        try {
          const result = await syncFiatCashflow(
            { id: acc.id },
            startDate,
            endDate,
            request.headers.get('authorization') || undefined,
            jobId,
            userId
          );
          
          results.push({
            accountId: acc.id,
            name: acc.name,
            ...result,
          });
        } catch (error) {
          console.error(`Error syncing account ${acc.id}:`, error);
          results.push({
            accountId: acc.id,
            name: acc.name,
            inserted: 0,
            updated: 0,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      // Atualizar progresso final
      await setProgress(jobId, {
        jobId,
        userId,
        totalSteps: 0,
        currentStep: 0,
        status: 'completed',
        message: `Sincronização de ${accounts.length} conta(s) concluída!`,
        result: {
          inserted: results.reduce((sum, r) => sum + (r.inserted || 0), 0),
          updated: results.reduce((sum, r) => sum + (r.updated || 0), 0),
        },
      });
    })().catch(error => {
      console.error('Error in background sync:', error);
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
      message: 'Sincronização iniciada',
      jobId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error starting sync:', error);
    return Response.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}


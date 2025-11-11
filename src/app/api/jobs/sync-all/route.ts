import { prisma } from '@/lib/prisma';
import { syncAccount } from '@/lib/sync/binance';
import { createJobId, setProgress } from '@/lib/sync/progress';

async function getUserIdFromToken(authHeader: string | null): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  
  const token = authHeader.substring(7);
  
  // Decode JWT token (simplificado - em produção use Firebase Admin)
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
    // Ler parâmetros do body
    const body = await request.json().catch(() => ({}));
    const startDate = body.startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate = body.endDate || new Date().toISOString().split('T')[0];
    const symbols = body.symbols || ['BTCBRL', 'ETHBRL', 'BNBBRL'];
    
    // Tentar autenticação por usuário primeiro
    const authHeader = request.headers.get('authorization');
    const userId = await getUserIdFromToken(authHeader);
    
    // Se autenticação de usuário falhar, verificar se é cron job
    const cronSecret = process.env.VERCEL_CRON_SECRET;
    if (!userId && cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accounts = userId 
      ? await prisma.binanceAccount.findMany({ where: { userId } })
      : await prisma.binanceAccount.findMany({});
    
    if (accounts.length === 0) {
      return Response.json({ 
        ok: true, 
        message: 'No accounts found',
        results: [] 
      });
    }

    // Criar jobId para rastrear progresso
    const jobId = userId ? createJobId(userId) : createJobId('system');
    
    // Iniciar sincronização de forma assíncrona
    (async () => {
      const results = [] as { accountId: string; name: string; inserted: number; updated: number; error?: string }[];
      
      for (const acc of accounts) {
        try {
          const r = await syncAccount(
            { id: acc.id, market: acc.market }, 
            startDate, 
            endDate, 
            symbols, 
            request.headers.get('authorization') || undefined,
            jobId,
            userId || undefined
          );
          results.push({ 
            accountId: acc.id, 
            name: acc.name,
            ...r 
          });
        } catch (error) {
          results.push({ 
            accountId: acc.id, 
            name: acc.name,
            inserted: 0, 
            updated: 0, 
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }

      // Atualizar progresso final
      if (userId) {
        setProgress(jobId, {
          jobId,
          userId,
          totalSteps: 0,
          currentStep: 0,
          status: 'completed',
          message: `Sincronização de ${accounts.length} conta(s) concluída!`,
          result: {
            inserted: results.reduce((sum, r) => sum + (r.inserted || 0), 0),
            updated: results.reduce((sum, r) => sum + (r.updated || 0), 0)
          }
        });
      }
    })().catch(error => {
      console.error('Async sync error:', error);
      if (userId) {
        setProgress(jobId, {
          jobId,
          userId: userId,
          totalSteps: 0,
          currentStep: 0,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    // Retornar jobId imediatamente
    return Response.json({ 
      ok: true, 
      message: 'Sincronização iniciada',
      jobId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Sync error:', error);
    return Response.json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}



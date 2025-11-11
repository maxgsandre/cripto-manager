import { NextRequest } from 'next/server';
import { getProgress } from '@/lib/sync/progress';

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
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get('jobId');

  if (!jobId) {
    return Response.json({ error: 'jobId is required' }, { status: 400 });
  }

  const progress = getProgress(jobId);

  if (!progress) {
    return Response.json({ error: 'Job not found' }, { status: 404 });
  }

  // Verificar se o job pertence ao usuário
  if (progress.userId !== userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Calcular percentual
  const percent = progress.totalSteps > 0 
    ? Math.round((progress.currentStep / progress.totalSteps) * 100)
    : 0;

  return Response.json({
    jobId: progress.jobId,
    status: progress.status,
    percent,
    currentStep: progress.currentStep,
    totalSteps: progress.totalSteps,
    currentSymbol: progress.currentSymbol,
    currentDate: progress.currentDate,
    message: progress.message,
    result: progress.result,
    error: progress.error
  });
}


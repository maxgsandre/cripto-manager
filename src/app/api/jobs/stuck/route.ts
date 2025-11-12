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

export async function GET(req: NextRequest) {
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const includeAll = searchParams.get('all') === 'true'; // Se ?all=true, buscar TODOS os jobs em execução

  try {
    // Buscar jobs em execução
    const where: {
      userId: string;
      status: 'running';
      updatedAt?: { lt: Date };
    } = {
      userId,
      status: 'running',
    };

    // Se não for "all", buscar apenas travados (mais de 30 minutos)
    if (!includeAll) {
      where.updatedAt = {
        lt: new Date(Date.now() - 30 * 60 * 1000), // 30 minutos atrás
      };
    }

    const runningJobs = await prisma.syncJob.findMany({
      where,
      orderBy: {
        updatedAt: 'asc',
      },
    });

    // Se não for "all", marcar jobs travados como 'error'
    const updatedJobs = [];
    if (!includeAll) {
      for (const job of runningJobs) {
        const updated = await prisma.syncJob.update({
          where: { id: job.id },
          data: {
            status: 'error',
            error: 'Job travado - timeout após 30 minutos sem atualização',
          },
        });
        updatedJobs.push(updated);
      }
    }

    return Response.json({
      stuckJobs: runningJobs.length,
      jobs: runningJobs.map(job => ({
        jobId: job.jobId,
        status: job.status,
        message: job.message,
        currentStep: job.currentStep,
        totalSteps: job.totalSteps,
        updatedAt: job.updatedAt,
        minutesStuck: Math.floor((Date.now() - job.updatedAt.getTime()) / (60 * 1000)),
      })),
      updated: updatedJobs.length,
    });
  } catch (error) {
    console.error('Error checking stuck jobs:', error);
    return Response.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { jobId } = await req.json();

    if (!jobId) {
      return Response.json({ error: 'jobId is required' }, { status: 400 });
    }

    // Marcar job específico como cancelado/erro
    const job = await prisma.syncJob.findFirst({
      where: {
        jobId,
        userId,
      },
    });

    if (!job) {
      return Response.json({ error: 'Job not found' }, { status: 404 });
    }

    const updated = await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: 'error',
        error: 'Cancelado manualmente pelo usuário',
      },
    });

    return Response.json({
      ok: true,
      job: {
        jobId: updated.jobId,
        status: updated.status,
        error: updated.error,
      },
    });
  } catch (error) {
    console.error('Error canceling job:', error);
    return Response.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}


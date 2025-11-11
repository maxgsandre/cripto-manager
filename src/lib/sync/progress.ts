// Armazenamento de progresso de sincronização no banco de dados
// Compatível com ambiente serverless (Vercel)

import { prisma } from '@/lib/prisma';

interface SyncProgress {
  jobId: string;
  userId: string;
  totalSteps: number;
  currentStep: number;
  currentSymbol?: string;
  currentDate?: string;
  status: 'running' | 'completed' | 'error';
  message?: string;
  result?: {
    inserted: number;
    updated: number;
  };
  error?: string;
}

export function createJobId(userId: string): string {
  return `${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export async function setProgress(jobId: string, progress: Partial<SyncProgress>): Promise<void> {
  try {
    const existing = await prisma.syncJob.findUnique({
      where: { jobId }
    });

    if (existing) {
      await prisma.syncJob.update({
        where: { jobId },
        data: {
          totalSteps: progress.totalSteps ?? existing.totalSteps,
          currentStep: progress.currentStep ?? existing.currentStep,
          currentSymbol: progress.currentSymbol ?? existing.currentSymbol,
          currentDate: progress.currentDate ?? existing.currentDate,
          status: (progress.status as string) ?? existing.status,
          message: progress.message ?? existing.message,
          resultInserted: progress.result?.inserted ?? existing.resultInserted,
          resultUpdated: progress.result?.updated ?? existing.resultUpdated,
          error: progress.error ?? existing.error,
        }
      });
    } else {
      await prisma.syncJob.create({
        data: {
          jobId,
          userId: progress.userId!,
          totalSteps: progress.totalSteps ?? 0,
          currentStep: progress.currentStep ?? 0,
          currentSymbol: progress.currentSymbol,
          currentDate: progress.currentDate,
          status: (progress.status as string) ?? 'running',
          message: progress.message,
          resultInserted: progress.result?.inserted ?? 0,
          resultUpdated: progress.result?.updated ?? 0,
          error: progress.error,
        }
      });
    }
  } catch (error) {
    console.error('Error setting progress:', error);
    // Não lançar erro para não quebrar a sincronização
  }
}

export async function getProgress(jobId: string): Promise<SyncProgress | null> {
  try {
    const job = await prisma.syncJob.findUnique({
      where: { jobId }
    });

    if (!job) {
      return null;
    }

    return {
      jobId: job.jobId,
      userId: job.userId,
      totalSteps: job.totalSteps,
      currentStep: job.currentStep,
      currentSymbol: job.currentSymbol ?? undefined,
      currentDate: job.currentDate ?? undefined,
      status: job.status as 'running' | 'completed' | 'error',
      message: job.message ?? undefined,
      result: job.resultInserted !== null && job.resultUpdated !== null ? {
        inserted: job.resultInserted,
        updated: job.resultUpdated
      } : undefined,
      error: job.error ?? undefined,
    };
  } catch (error) {
    console.error('Error getting progress:', error);
    return null;
  }
}

// Limpar progressos antigos (mais de 1 hora)
export async function cleanupOldProgress(): Promise<void> {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.syncJob.deleteMany({
      where: {
        OR: [
          { status: 'completed', updatedAt: { lt: oneHourAgo } },
          { status: 'error', updatedAt: { lt: oneHourAgo } }
        ]
      }
    });
  } catch (error) {
    console.error('Error cleaning up old progress:', error);
  }
}

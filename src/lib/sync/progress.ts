// Cache em memória para armazenar progresso de sincronização
// Em produção, considere usar Redis ou outro sistema de cache distribuído

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

const progressCache = new Map<string, SyncProgress>();

export function setProgress(jobId: string, progress: Partial<SyncProgress>) {
  const existing = progressCache.get(jobId);
  if (existing) {
    progressCache.set(jobId, { ...existing, ...progress });
  } else {
    progressCache.set(jobId, progress as SyncProgress);
  }
}

export function getProgress(jobId: string): SyncProgress | null {
  return progressCache.get(jobId) || null;
}

export function createJobId(userId: string): string {
  return `${userId}_${Date.now()}`;
}

// Limpar progressos antigos (mais de 1 hora)
export function cleanupOldProgress() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [jobId, progress] of progressCache.entries()) {
    if (progress.status === 'completed' || progress.status === 'error') {
      const timestamp = parseInt(jobId.split('_').pop() || '0');
      if (timestamp < oneHourAgo) {
        progressCache.delete(jobId);
      }
    }
  }
}

// Limpar progressos a cada 5 minutos
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupOldProgress, 5 * 60 * 1000);
}


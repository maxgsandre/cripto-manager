import { endOfMonth, format, startOfMonth } from 'date-fns';

export function fmtCurrencyBRL(value: number | string): string {
  const num = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(num || 0);
}

export function fmtPct(value: number | string): string {
  const num = typeof value === 'string' ? Number(value) : value;
  return `${(num || 0) * 100} %`;
}

export function monthRange(monthYYYYMM: string): { start: Date; end: Date; label: string } {
  const [y, m] = monthYYYYMM.split('-').map((v) => Number(v));
  // Criar datas em UTC para evitar problemas de timezone com o Prisma
  // Primeiro dia do mês às 00:00:00 UTC
  // m - 1 porque Date usa mês 0-indexed (0 = janeiro, 11 = dezembro)
  const first = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  // Último dia do mês: Date.UTC(y, m, 0) retorna o último dia do mês (m-1) em UTC
  // Exemplo: para setembro (m=9), Date.UTC(2025, 9, 0) = último dia de agosto (errado!)
  // Correto: Date.UTC(2025, 10, 0) = último dia de setembro (mês 9)
  // Então usamos m (não m-1) para obter o último dia do mês correto
  const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  return { start: first, end, label: format(first, 'yyyy-MM') };
}



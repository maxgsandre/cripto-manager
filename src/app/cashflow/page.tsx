"use client";
import React, { useEffect, useState } from 'react';
import InternalLayout from '@/components/InternalLayout';
import { auth } from '@/lib/firebase/client';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';

declare global {
  interface Window {
    __cashflowPollInterval?: NodeJS.Timeout | null;
  }
}

type CashflowRow = {
  id: string;
  accountId: string;
  accountName: string;
  type: string;
  asset: string;
  amount: string;
  at: string;
  note: string | null;
};

function formatCurrency(value: string | number): string {
  const num = Number(value || 0);
  return new Intl.NumberFormat('pt-BR', { 
    style: 'currency', 
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
}

function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export default function CashflowPage() {
  const [rows, setRows] = useState<CashflowRow[]>([]);
  const [total, setTotal] = useState(0);
  const [tradesCount, setTradesCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [type, setType] = useState<string>('');
  const [asset, setAsset] = useState<string>('');
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncStartDate, setSyncStartDate] = useState('');
  const [syncEndDate, setSyncEndDate] = useState('');
  const [syncProgress, setSyncProgress] = useState<{
    jobId: string | null;
    percent: number;
    message: string;
    status: 'running' | 'completed' | 'error';
    result?: { inserted: number; updated: number };
    error?: string;
  } | null>(null);

  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importAccountId, setImportAccountId] = useState('');
  const [importProgress, setImportProgress] = useState<{
    jobId: string | null;
    percent: number;
    message: string;
    status: 'running' | 'completed' | 'error';
    result?: { inserted: number; updated: number };
    error?: string;
  } | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      const params = new URLSearchParams();
      
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (type) params.set('type', type);
      if (asset) params.set('asset', asset);
      params.set('page', page.toString());
      params.set('pageSize', pageSize.toString());

      try {
        const res = await fetch(`/api/cashflow?${params.toString()}`, {
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!res.ok) {
          console.error('Error fetching cashflow:', res.status);
          return;
        }

        const data = await res.json();
        setTotal(data.total);
        setRows(data.rows || []);
        setTradesCount(data.tradesCount || 0);
      } catch (error) {
        console.error('Error fetching cashflow:', error);
      }
    };

    fetchData();
  }, [page, pageSize, startDate, endDate, type, asset]);

  useEffect(() => {
    const fetchAccounts = async () => {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      try {
        const res = await fetch('/api/accounts', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (res.ok) {
          const data = await res.json();
          setAccounts(data.results || []);
          if (data.results && data.results.length > 0 && !selectedAccount) {
            setSelectedAccount(data.results[0].id);
            setImportAccountId(data.results[0].id);
          }
        }
      } catch (error) {
        console.error('Error fetching accounts:', error);
      }
    };

    fetchAccounts();
  }, [selectedAccount]);

  const syncCashflow = async () => {
    try {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      const response = await fetch('/api/cashflow/sync', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate: syncStartDate || undefined,
          endDate: syncEndDate || undefined,
        }),
      });

      const result = await response.json();

      if (result.error) {
        alert(`Erro: ${result.error}`);
        return;
      }

      if (result.jobId) {
        setSyncProgress({
          jobId: result.jobId,
          percent: 0,
          message: 'Iniciando sincronização...',
          status: 'running',
        });

        const pollInterval = setInterval(async () => {
          try {
            const statusResponse = await fetch(`/api/jobs/sync-status?jobId=${result.jobId}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const status = await statusResponse.json();

            if (status.error) {
              if (pollInterval) clearInterval(pollInterval);
              setSyncProgress(null);
              alert(`Erro: ${status.error}`);
              return;
            }

            setSyncProgress({
              jobId: status.jobId,
              percent: status.percent || 0,
              message: status.message || 'Processando...',
              status: status.status,
              result: status.result,
              error: status.error,
            });

            if (status.status === 'completed') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                if (status.result) {
                  alert(`Sincronização concluída! ${status.result.inserted || 0} inseridos, ${status.result.updated || 0} atualizados.`);
                }
                setSyncProgress(null);
                setShowSyncModal(false);
                window.location.reload();
              }, 2000);
            } else if (status.status === 'error') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                alert(`Erro na sincronização: ${status.error || 'Erro desconhecido'}`);
                setSyncProgress(null);
              }, 2000);
            }
          } catch (error) {
            console.error('Error polling status:', error);
            if (pollInterval) clearInterval(pollInterval);
          }
        }, 1000);

        window.__cashflowPollInterval = pollInterval;
      } else {
        alert('Erro: jobId não retornado');
      }
    } catch (error) {
      alert(`Erro ao sincronizar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
      setSyncProgress(null);
    }
  };

  const importCSV = async () => {
    if (!importFile || !importAccountId) {
      alert('Selecione um arquivo CSV e uma conta');
      return;
    }

    try {
      const user = auth.currentUser;
      if (!user) return;

      const token = await user.getIdToken();
      const formData = new FormData();
      formData.append('file', importFile);
      formData.append('accountId', importAccountId);

      const response = await fetch('/api/cashflow/import-csv', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      const result = await response.json();

      if (result.error) {
        alert(`Erro: ${result.error}`);
        return;
      }

      if (result.jobId) {
        setImportProgress({
          jobId: result.jobId,
          percent: 0,
          message: 'Iniciando importação...',
          status: 'running',
        });

        const pollInterval = setInterval(async () => {
          try {
            const statusResponse = await fetch(`/api/jobs/sync-status?jobId=${result.jobId}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const status = await statusResponse.json();

            if (status.error) {
              if (pollInterval) clearInterval(pollInterval);
              setImportProgress(null);
              alert(`Erro: ${status.error}`);
              return;
            }

            setImportProgress({
              jobId: status.jobId,
              percent: status.percent || 0,
              message: status.message || 'Processando...',
              status: status.status,
              result: status.result,
              error: status.error,
            });

            if (status.status === 'completed') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                if (status.result) {
                  alert(`Importação concluída! ${status.result.inserted || 0} inseridos, ${status.result.updated || 0} atualizados.`);
                }
                setImportProgress(null);
                setShowImportModal(false);
                setImportFile(null);
                window.location.reload();
              }, 2000);
            } else if (status.status === 'error') {
              if (pollInterval) clearInterval(pollInterval);
              setTimeout(() => {
                alert(`Erro na importação: ${status.error || 'Erro desconhecido'}`);
                setImportProgress(null);
              }, 2000);
            }
          } catch (error) {
            console.error('Error polling status:', error);
            if (pollInterval) clearInterval(pollInterval);
          }
        }, 1000);

        window.__cashflowPollInterval = pollInterval;
      } else {
        alert('Erro: jobId não retornado');
      }
    } catch (error) {
      alert(`Erro ao importar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
      setImportProgress(null);
    }
  };

  const columnHelper = createColumnHelper<CashflowRow>();

  const columns = [
    columnHelper.accessor('at', {
      header: 'Data/Hora',
      cell: (info) => formatDateTime(info.getValue()),
    }),
    columnHelper.accessor('accountName', {
      header: 'Conta',
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('type', {
      header: 'Tipo',
      cell: (info) => {
        const type = info.getValue();
        const isDeposit = type === 'DEPOSIT';
        return (
          <span className={`px-2 py-1 rounded text-xs font-semibold ${
            isDeposit ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {isDeposit ? '💰 Depósito' : '💸 Saque'}
          </span>
        );
      },
    }),
    columnHelper.accessor('asset', {
      header: 'Moeda',
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('amount', {
      header: 'Valor',
      cell: (info) => {
        const amount = Number(info.getValue());
        const isPositive = amount >= 0;
        return (
          <span className={isPositive ? 'text-green-400' : 'text-red-400'}>
            {formatCurrency(amount)}
          </span>
        );
      },
    }),
    columnHelper.accessor('note', {
      header: 'Observações',
      cell: (info) => info.getValue() || '-',
    }),
  ];

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: Math.ceil(total / pageSize),
  });

  const totalPages = Math.ceil(total / pageSize);

  // Calcular totais (apenas transações concretizadas, ignorando expiradas)
  const totalDeposits = rows
    .filter(r => r.type === 'DEPOSIT' && !r.note?.includes('Expired'))
    .reduce((sum, r) => sum + Number(r.amount), 0);
  
  const totalWithdrawals = rows
    .filter(r => r.type === 'WITHDRAWAL' && !r.note?.includes('Expired'))
    .reduce((sum, r) => sum + Math.abs(Number(r.amount)), 0);

  const netCashflow = totalDeposits - totalWithdrawals;

  return (
    <InternalLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-white">Depósitos e Saques</h1>
          <div className="flex gap-3">
            <button
              onClick={() => setShowSyncModal(true)}
              className="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white font-semibold py-2 px-6 rounded-lg transition-all duration-200 flex items-center gap-2"
            >
              <span>🔄</span>
              Sincronizar via API
            </button>
            <button
              onClick={() => setShowImportModal(true)}
              className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white font-semibold py-2 px-6 rounded-lg transition-all duration-200 flex items-center gap-2"
            >
              <span>📄</span>
              Importar CSV
            </button>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-gradient-to-r from-green-500/10 to-emerald-500/5 backdrop-blur-sm rounded-lg border border-white/10 p-4">
            <div className="text-2xl font-bold text-green-400">
              {formatCurrency(totalDeposits)}
            </div>
            <div className="text-sm text-slate-400">Total de Depósitos</div>
          </div>
          <div className="bg-gradient-to-r from-red-500/10 to-pink-500/5 backdrop-blur-sm rounded-lg border border-white/10 p-4">
            <div className="text-2xl font-bold text-red-400">
              {formatCurrency(totalWithdrawals)}
            </div>
            <div className="text-sm text-slate-400">Total de Saques</div>
          </div>
          <div className="bg-gradient-to-r from-blue-500/10 to-indigo-500/5 backdrop-blur-sm rounded-lg border border-white/10 p-4">
            <div className="text-2xl font-bold text-blue-400">
              {formatCurrency(netCashflow)}
            </div>
            <div className="text-sm text-slate-400">Fluxo de Caixa Líquido</div>
          </div>
        </div>

        {/* Filtros */}
        <div className="bg-slate-900/50 backdrop-blur-sm rounded-lg border border-white/10 p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm text-slate-300 mb-2">Data Inicial</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-300 mb-2">Data Final</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-300 mb-2">Tipo</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
              >
                <option value="">Todos</option>
                <option value="DEPOSIT">Depósito</option>
                <option value="WITHDRAWAL">Saque</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-300 mb-2">Moeda</label>
              <input
                type="text"
                value={asset}
                onChange={(e) => setAsset(e.target.value)}
                placeholder="Ex: BRL"
                className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
              />
            </div>
          </div>
          {/* Informações de disponibilidade */}
          <div className="pt-2 border-t border-white/10">
            <div className="flex flex-wrap gap-4 text-sm text-slate-400">
              <span>
                <span className="text-slate-300 font-semibold">{total.toLocaleString('pt-BR')}</span> transações disponíveis
              </span>
              <span>
                <span className="text-slate-300 font-semibold">{tradesCount.toLocaleString('pt-BR')}</span> trades disponíveis
              </span>
              {total > 0 && (
                <span>
                  <span className="text-slate-300 font-semibold">{Math.ceil(total / pageSize)}</span> página{Math.ceil(total / pageSize) !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Tabela */}
        <div className="bg-slate-900/50 backdrop-blur-sm rounded-lg border border-white/10 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-800/50">
                {table.getHeaderGroups().map(headerGroup => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map(header => (
                      <th
                        key={header.id}
                        className="px-4 py-3 text-left text-sm font-semibold text-slate-300"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody className="divide-y divide-white/5">
                {table.getRowModel().rows.map(row => (
                  <tr key={row.id} className="hover:bg-white/5 transition-colors">
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id} className="px-4 py-3 text-sm text-slate-300">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length === 0 && (
            <div className="text-center py-12 text-slate-400">
              Nenhum registro encontrado
            </div>
          )}

          {/* Paginação */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-white/10">
              <div className="text-sm text-slate-400">
                Mostrando {((page - 1) * pageSize) + 1} a {Math.min(page * pageSize, total)} de {total}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 bg-white/5 border border-white/10 rounded text-sm text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/10"
                >
                  Anterior
                </button>
                <span className="px-3 py-1 text-sm text-slate-300">
                  Página {page} de {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1 bg-white/5 border border-white/10 rounded text-sm text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/10"
                >
                  Próxima
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal de Sincronização */}
        {showSyncModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-slate-900 rounded-xl p-6 max-w-md w-full border border-white/10">
              <h3 className="text-xl text-white font-semibold mb-4">
                {syncProgress !== null ? 'Sincronizando' : 'Sincronizar via API'}
              </h3>
              {syncProgress !== null ? (
                <div className="space-y-4">
                  <div className="w-full bg-white/5 rounded-full h-2">
                    <div
                      className="bg-gradient-to-r from-blue-500 to-cyan-500 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${syncProgress.percent}%` }}
                    />
                  </div>
                  <div className="text-sm text-slate-300">{syncProgress.message}</div>
                  {syncProgress.status === 'completed' && syncProgress.result && (
                    <div className="text-sm text-green-400">
                      <div className="font-semibold mb-1">✓ Sincronização concluída!</div>
                      <div>
                        {syncProgress.result.inserted || 0} inseridos, {syncProgress.result.updated || 0} atualizados
                      </div>
                    </div>
                  )}
                  {syncProgress.status === 'error' && (
                    <div className="text-sm text-red-400">
                      <div className="font-semibold mb-1">✗ Erro na sincronização</div>
                      <div>{syncProgress.error || 'Erro desconhecido'}</div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-slate-300 text-sm mb-2">📅 Data inicial (opcional)</label>
                    <input
                      type="date"
                      value={syncStartDate}
                      onChange={(e) => setSyncStartDate(e.target.value)}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    />
                    <p className="text-xs text-slate-400 mt-1">Deixe vazio para últimos 30 dias</p>
                  </div>
                  <div>
                    <label className="block text-slate-300 text-sm mb-2">📅 Data final (opcional)</label>
                    <input
                      type="date"
                      value={syncEndDate}
                      onChange={(e) => setSyncEndDate(e.target.value)}
                      min={syncStartDate}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    />
                    <p className="text-xs text-slate-400 mt-1">Deixe vazio para hoje</p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={syncCashflow}
                      disabled={!!syncProgress}
                      className="flex-1 bg-gradient-to-r from-blue-500 to-cyan-500 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Sincronizar
                    </button>
                    <button
                      onClick={() => {
                        if (window.__cashflowPollInterval) {
                          clearInterval(window.__cashflowPollInterval);
                          window.__cashflowPollInterval = null;
                        }
                        setShowSyncModal(false);
                        setSyncProgress(null);
                        setSyncStartDate('');
                        setSyncEndDate('');
                      }}
                      className="flex-1 bg-white/10 hover:bg-white/20 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Modal de Importação CSV */}
        {showImportModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-slate-900 rounded-xl p-6 max-w-md w-full border border-white/10">
              <h3 className="text-xl text-white font-semibold mb-4">
                {importProgress !== null ? 'Importando CSV' : 'Importar CSV'}
              </h3>
              {importProgress !== null ? (
                <div className="space-y-4">
                  <div className="w-full bg-white/5 rounded-full h-2">
                    <div
                      className="bg-gradient-to-r from-purple-500 to-pink-500 h-2 rounded-full transition-all duration-300"
                      style={{ width: `${importProgress.percent}%` }}
                    />
                  </div>
                  <div className="text-sm text-slate-300">{importProgress.message}</div>
                  {importProgress.status === 'completed' && importProgress.result && (
                    <div className="text-sm text-green-400">
                      <div className="font-semibold mb-1">✓ Importação concluída!</div>
                      <div>
                        {importProgress.result.inserted || 0} inseridos, {importProgress.result.updated || 0} atualizados
                      </div>
                    </div>
                  )}
                  {importProgress.status === 'error' && (
                    <div className="text-sm text-red-400">
                      <div className="font-semibold mb-1">✗ Erro na importação</div>
                      <div>{importProgress.error || 'Erro desconhecido'}</div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-slate-300 text-sm mb-2">Conta</label>
                    <select
                      value={importAccountId}
                      onChange={(e) => setImportAccountId(e.target.value)}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    >
                      <option value="">Selecione uma conta</option>
                      {accounts.map(acc => (
                        <option key={acc.id} value={acc.id}>{acc.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-300 text-sm mb-2">Arquivo CSV</label>
                    <input
                      type="file"
                      accept=".csv"
                      onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                      className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      Formato esperado: Data (UTC), Tipo, Moeda, Valor, Taxa, Método, Status, Número do Pedido
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={importCSV}
                      disabled={!importFile || !importAccountId || !!importProgress}
                      className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Importar
                    </button>
                    <button
                      onClick={() => {
                        if (window.__cashflowPollInterval) {
                          clearInterval(window.__cashflowPollInterval);
                          window.__cashflowPollInterval = null;
                        }
                        setShowImportModal(false);
                        setImportProgress(null);
                        setImportFile(null);
                      }}
                      className="flex-1 bg-white/10 hover:bg-white/20 text-white font-semibold py-2 px-4 rounded-lg transition-all duration-200"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </InternalLayout>
  );
}


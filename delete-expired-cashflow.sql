-- Script para deletar transações expiradas do banco
-- Execute este script no SQL Editor do Supabase

-- Deletar todas as transações com status "Expired"
DELETE FROM "Cashflow"
WHERE "note" LIKE '%Expired%';

-- Verificar quantas foram deletadas (execute separadamente)
-- SELECT COUNT(*) FROM "Cashflow" WHERE "note" LIKE '%Expired%';


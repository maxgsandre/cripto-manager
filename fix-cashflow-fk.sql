-- Script para corrigir a foreign key da tabela Cashflow
-- Execute este script no SQL Editor do Supabase

-- 1. Verificar se a tabela Cashflow existe
-- Se não existir, criar:
CREATE TABLE IF NOT EXISTS "Cashflow" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" DECIMAL(38,18) NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cashflow_pkey" PRIMARY KEY ("id")
);

-- 2. Remover a foreign key antiga (se existir e apontar para Account)
ALTER TABLE "Cashflow" 
DROP CONSTRAINT IF EXISTS "Cashflow_accountId_fkey";

-- 3. Adicionar a foreign key correta apontando para BinanceAccount
ALTER TABLE "Cashflow" 
ADD CONSTRAINT "Cashflow_accountId_fkey" 
FOREIGN KEY ("accountId") 
REFERENCES "BinanceAccount"("id") 
ON DELETE RESTRICT 
ON UPDATE CASCADE;


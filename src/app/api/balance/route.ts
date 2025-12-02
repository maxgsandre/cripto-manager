import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/encryption';
import crypto from 'crypto';
import { getProxyUrl, proxyGet } from '@/lib/binanceProxyClient';

// Types for Binance responses
interface SpotBalanceItem { asset: string; free: string; locked: string }
interface FuturesAssetItem { asset: string; availableBalance: string; walletBalance: string }
interface SpotAccountResponse { balances?: SpotBalanceItem[] }
interface FuturesAccountResponse { assets?: FuturesAssetItem[] }

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

function createSignature(queryString: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function fetchBinanceBalance(apiKey: string, apiSecret: string, market: string): Promise<{ asset: string; free: string; locked: string }[]> {
  const baseUrl = market === 'FUTURES' 
    ? 'https://fapi.binance.com' 
    : 'https://api.binance.com';
  
  const endpoint = market === 'FUTURES'
    ? '/fapi/v2/account'
    : '/api/v3/account';
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {};
  params.recvWindow = 5000;
  params.timestamp = Date.now();
  
  const queryString = new URLSearchParams(params).toString();
  const signature = createSignature(queryString, apiSecret);
  const fullUrl = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;
  
  console.log(`[BALANCE] Calling Binance API: ${market} at ${fullUrl.substring(0, 100)}...`);
  
  const response = await fetch(fullUrl, {
    headers: {
      'X-MBX-APIKEY': apiKey,
    },
  });

  console.log(`[BALANCE] Binance API response status: ${response.status}`);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Binance API error:', response.status, errorText);
    throw new Error(`Binance API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  console.log(`[BALANCE] Binance API response data keys:`, Object.keys(data));
  console.log(`[BALANCE] Market: ${market}, Has balances?`, market === 'FUTURES' ? data.assets?.length : data.balances?.length);
  
  if (market === 'FUTURES') {
    const assets = data.assets?.map((asset: { asset: string; availableBalance: string; walletBalance: string }) => ({
      asset: asset.asset,
      free: asset.availableBalance,
      locked: asset.walletBalance,
    })) || [];
    console.log(`[BALANCE] Returning ${assets.length} FUTURES assets`);
    return assets;
  } else {
    const balances = data.balances?.filter((b: { free: string; locked: string }) => 
      Number(b.free) > 0 || Number(b.locked) > 0
    ).map((b: { asset: string; free: string; locked: string }) => ({
      asset: b.asset,
      free: b.free,
      locked: b.locked,
    })) || [];
    console.log(`[BALANCE] Returning ${balances.length} SPOT balances`);
    return balances;
  }
}

async function getPriceInUSDT(asset: string): Promise<number> {
  // Se já for USDT, retorna 1
  if (asset === 'USDT' || asset === 'BUSD') return 1;
  
  try {
    // Buscar preço no mercado spot da Binance
    const proxyBase = getProxyUrl();
    const response = await (proxyBase
      ? fetch(`${proxyBase}/ticker/price?symbol=${asset}USDT`)
      : fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${asset}USDT`));
    if (response.ok) {
      const data = await response.json();
      return Number(data.price);
    }
  } catch (error) {
    console.error(`Error fetching price for ${asset}:`, error);
  }
  
  // Se não encontrar o par direto, tentar outras moedas
  const alternatives = ['BUSD', 'BRL', 'BTC', 'ETH'];
  for (const alt of alternatives) {
    if (asset === alt) continue;
    try {
      const proxyBase = getProxyUrl();
      const response = await (proxyBase
        ? fetch(`${proxyBase}/ticker/price?symbol=${asset}${alt}`)
        : fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${asset}${alt}`));
      if (response.ok) {
        const data = await response.json();
        const price = Number(data.price);
        
        // Se encontrou via BUSD/BRL, precisamos converter para USDT
        if (alt === 'BUSD') return price; // BUSD ~= USDT
        if (alt === 'BRL') {
          // Buscar cotação BRL/USDT
          const brlUsdt = await (getProxyUrl()
            ? fetch(`${getProxyUrl()}/ticker/price?symbol=USDTBRL`)
            : fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL'))
            .then(r => r.json())
            .then(d => 1 / Number(d.price))
            .catch(() => 0.19); // Fallback
          return price * brlUsdt;
        }
        
        // Para BTC/ETH, buscar suas cotações em USDT
        if (alt === 'BTC' || alt === 'ETH') {
          const altUsdt = await (getProxyUrl()
            ? fetch(`${getProxyUrl()}/ticker/price?symbol=${alt}USDT`)
            : fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${alt}USDT`))
            .then(r => r.json())
            .then(d => Number(d.price))
            .catch(() => 0);
          return price * altUsdt;
        }
        
        return price;
      }
    } catch (error) {
      console.error(`Error fetching price for ${asset}${alt}:`, error);
    }
  }
  
  return 0;
}

export async function GET(req: NextRequest) {
  const userId = await getUserIdFromToken(req);
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const accounts = await prisma.binanceAccount.findMany({
      where: { userId }
    });

    if (accounts.length === 0) {
      return Response.json({ 
        ok: true, 
        balance: '0',
        accounts: []
      });
    }

    // Buscar saldo de todas as contas
    const allBalances: { asset: string; total: number }[] = [];
    
    const proxyBase = getProxyUrl();
    const authHeader = req.headers.get('authorization') || undefined;

    for (const account of accounts) {
      try {
        console.log(`[BALANCE] Processing account: ${account.name}`);

        let balances: { asset: string; free: string; locked: string }[] = [];

        if (proxyBase && authHeader) {
          // Usar proxy local
          const res = await proxyGet<{ ok: boolean; data: SpotAccountResponse | FuturesAccountResponse }>(
            `/account?market=${encodeURIComponent(account.market)}&accountId=${encodeURIComponent(account.id)}`,
            authHeader
          );
          const data = res.data;
          if (account.market === 'FUTURES') {
            const assets = (data as FuturesAccountResponse).assets || [];
            balances = assets.map((a: FuturesAssetItem) => ({
              asset: a.asset,
              free: a.availableBalance,
              locked: a.walletBalance,
            }));
          } else {
            const spotBalances = (data as SpotAccountResponse).balances || [];
            balances = spotBalances
              .filter((b: SpotBalanceItem) => Number(b.free) > 0 || Number(b.locked) > 0)
              .map((b: SpotBalanceItem) => ({ asset: b.asset, free: b.free, locked: b.locked }));
          }
        } else {
          // Caminho antigo (chamada direta)
          const apiKey = await decrypt(account.apiKeyEnc);
          const apiSecret = await decrypt(account.apiSecretEnc);
          const direct = await fetchBinanceBalance(apiKey, apiSecret, account.market);
          balances = direct;
        }

        console.log(`[BALANCE] Fetched ${balances.length} assets for ${account.name}`);
        
        for (const bal of balances) {
          const existing = allBalances.find(b => b.asset === bal.asset);
          const total = Number(bal.free) + Number(bal.locked);
          
          if (existing) {
            existing.total += total;
          } else {
            allBalances.push({ asset: bal.asset, total });
          }
        }
      } catch (error) {
        console.error(`[BALANCE] Error fetching balance for account ${account.name}:`, error);
      }
    }
    
    console.log(`[BALANCE] Total assets found: ${allBalances.length}`);
    console.log(`[BALANCE] Assets:`, allBalances.map(b => `${b.asset}: ${b.total}`).join(', '));

    // Se não tem assets, retorna zero
    if (allBalances.length === 0) {
      return Response.json({ 
        ok: true, 
        balance: '0',
        balanceUSDT: '0',
        exchangeRate: '5.37',
        assets: [],
        accounts: accounts.map(acc => ({ id: acc.id, name: acc.name })),
        debug: {
          allBalancesLength: allBalances.length,
          accountsCount: accounts.length
        }
      });
    }

    // Buscar cotação USDT/BRL
    let brlPerUsdt = 5.37; // Fallback
    try {
      const usdtBrlResponse = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL');
      if (usdtBrlResponse.ok) {
        const data = await usdtBrlResponse.json();
        brlPerUsdt = Number(data.price);
      }
    } catch (error) {
      console.error('Error fetching USDT/BRL price:', error);
    }

    // Calcular valor total em USDT para cada ativo e depois em BRL
    let totalUSDT = 0;
    let totalBRLFiat = 0; // Saldo fiat em BRL (já está em reais, não precisa conversão)
    const assetsWithValue: { asset: string; amount: number; usdtValue: number; brlValue: number }[] = [];
    
    for (const bal of allBalances) {
      // BRL fiat já está em reais, não precisa conversão
      if (bal.asset === 'BRL') {
        totalBRLFiat += bal.total;
        const usdtValue = bal.total / brlPerUsdt; // Converter BRL para USDT apenas para exibição
        
        assetsWithValue.push({
          asset: bal.asset,
          amount: bal.total,
          usdtValue,
          brlValue: bal.total // BRL fiat já está em reais
        });
        
        // Não adicionar ao totalUSDT, pois será somado separadamente ao totalBRL
      } else {
        // Para criptomoedas, converter para USDT e depois para BRL
        const priceInUSDT = await getPriceInUSDT(bal.asset);
        const usdtValue = bal.total * priceInUSDT;
        const brlValue = usdtValue * brlPerUsdt;
        
        totalUSDT += usdtValue;
        
        assetsWithValue.push({
          asset: bal.asset,
          amount: bal.total,
          usdtValue,
          brlValue
        });
      }
    }

    // Total em BRL = criptomoedas convertidas + BRL fiat direto
    const totalBRL = (totalUSDT * brlPerUsdt) + totalBRLFiat;
    // Total em USDT = criptomoedas + BRL fiat convertido
    const totalUSDTWithFiat = totalUSDT + (totalBRLFiat / brlPerUsdt);

    return Response.json({ 
      ok: true, 
      balance: totalBRL.toFixed(8),
      balanceUSDT: totalUSDTWithFiat.toFixed(8),
      exchangeRate: brlPerUsdt.toFixed(2),
      assets: assetsWithValue,
      accounts: accounts.map(acc => ({ id: acc.id, name: acc.name }))
    });
  } catch (error) {
    console.error('Error fetching balance:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}


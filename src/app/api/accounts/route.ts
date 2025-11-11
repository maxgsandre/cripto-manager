import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { encrypt } from '@/lib/encryption';

async function getUserIdFromToken(req: NextRequest): Promise<{ userId: string; email: string | null } | null> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  
  const token = authHeader.substring(7);
  
  // Decode JWT token (simplificado - em produção use Firebase Admin)
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    const userId = payload.user_id || payload.uid || null;
    const email = payload.email || null; // Email do usuário no Firebase
    if (!userId) return null;
    return { userId, email };
  } catch (error) {
    console.error('Token decode error:', error);
    return null;
  }
}

export async function GET(req: NextRequest) {
  const auth = await getUserIdFromToken(req);
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const accounts = await prisma.binanceAccount.findMany({ 
    where: { userId: auth.userId },
    orderBy: { createdAt: 'desc' } 
  });
  return Response.json({ ok: true, message: accounts.length > 0 ? `${accounts.length} accounts found` : 'No accounts found', results: accounts });
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getUserIdFromToken(req);
    if (!auth) {
      console.error('POST /api/accounts: Unauthorized - auth is null');
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { userId, email } = auth;
    console.log('POST /api/accounts: userId =', userId, 'email =', email);

    let body;
    try {
      body = await req.json();
      console.log('POST /api/accounts: body received', { 
        hasName: !!body?.name, 
        hasMarket: !!body?.market, 
        hasApiKey: !!body?.apiKey, 
        hasApiSecret: !!body?.apiSecret 
      });
    } catch (error) {
      console.error('POST /api/accounts: JSON parse error:', error);
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const name: string = body?.name?.trim();
    const market: string = body?.market?.trim();
    const apiKey: string = body?.apiKey?.trim();
    const apiSecret: string = body?.apiSecret?.trim();

    if (!name || !market || !apiKey || !apiSecret) {
      return Response.json({ error: 'name, market, apiKey, apiSecret required' }, { status: 400 });
    }

    // Validar market
    if (!['SPOT', 'FUTURES'].includes(market)) {
      return Response.json({ error: 'market must be SPOT or FUTURES' }, { status: 400 });
    }

    // Criptografar as chaves com libsodium
    let apiKeyEnc: string;
    let apiSecretEnc: string;
    try {
      apiKeyEnc = await encrypt(apiKey);
      apiSecretEnc = await encrypt(apiSecret);
    } catch (error) {
      console.error('Encryption error:', error);
      return Response.json({ error: 'Failed to encrypt credentials', details: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
    }

    // Criar ou sincronizar usuário no Prisma se não existir
    try {
      console.log('POST /api/accounts: Syncing user', { userId });
      
      // Verificar se o usuário já existe
      const existingUser = await prisma.user.findUnique({
        where: { id: userId }
      });
      
      if (!existingUser) {
        // Criar novo usuário com o email do token Firebase
        await prisma.user.create({
          data: {
            id: userId,
            email: email || null, // Usar email do token, ou null se não tiver
            name: null,
          },
        });
        console.log('POST /api/accounts: User created successfully with email:', email || 'null');
      } else {
        // Se o usuário existe mas não tem email, atualizar com o email do token
        if (!existingUser.email && email) {
          await prisma.user.update({
            where: { id: userId },
            data: { email },
          });
          console.log('POST /api/accounts: User email updated to:', email);
        } else {
          console.log('POST /api/accounts: User already exists');
        }
      }
    } catch (error) {
      console.error('POST /api/accounts: User sync error:', error);
      // Se falhar na criação do usuário, não podemos continuar
      if (error instanceof Error && error.message.includes('Unique constraint')) {
        // Tentar novamente com findUnique para garantir que o usuário existe
        const userExists = await prisma.user.findUnique({ where: { id: userId } });
        if (!userExists) {
          return Response.json({ 
            error: 'Failed to create user account. Please try logging in again.' 
          }, { status: 500 });
        }
      } else {
        return Response.json({ 
          error: 'Failed to sync user account', 
          details: error instanceof Error ? error.message : 'Unknown error' 
        }, { status: 500 });
      }
    }

    // Criar conta
    try {
      console.log('POST /api/accounts: Attempting to create account', { 
        userId, 
        name, 
        market, 
        apiKeyEncLength: apiKeyEnc?.length, 
        apiSecretEncLength: apiSecretEnc?.length 
      });
      
      const acc = await prisma.binanceAccount.create({
        data: { 
          userId, 
          name, 
          market, 
          apiKeyEnc, 
          apiSecretEnc
        },
      });
      
      console.log('POST /api/accounts: Account created successfully', { id: acc.id, name: acc.name });
      return Response.json({ ok: true, account: acc }, { status: 201 });
    } catch (error) {
      console.error('POST /api/accounts: Database create error:', error);
      console.error('POST /api/accounts: Error details:', {
        message: error instanceof Error ? error.message : 'Unknown',
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined
      });
      
      // Verificar se é erro de constraint (conta duplicada, etc)
      if (error instanceof Error && (error.message.includes('Unique constraint') || error.message.includes('duplicate'))) {
        return Response.json({ error: 'Account with this name already exists' }, { status: 409 });
      }
      
      // Verificar se é erro de foreign key (usuário não existe)
      if (error instanceof Error && error.message.includes('Foreign key constraint')) {
        return Response.json({ error: 'User not found. Please try logging in again.' }, { status: 400 });
      }
      
      return Response.json({ 
        error: 'Failed to create account', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      }, { status: 500 });
    }
  } catch (error) {
    console.error('Unexpected error in POST /api/accounts:', error);
    return Response.json({ 
      error: 'Internal server error', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, { status: 500 });
  }
}



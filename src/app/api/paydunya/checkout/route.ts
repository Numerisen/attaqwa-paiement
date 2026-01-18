import { db } from '@/db/client';
import { auditLogs, payments } from '@/db/schema';
import { requireUser } from '@/lib/auth';
import { badRequest, serverError } from '@/lib/http';
import { error, jsonRes, log } from '@/lib/logger';
import { createCheckoutInvoice } from '@/lib/paydunya';
import { rateLimit } from '@/lib/ratelimit';
import { checkoutSchema, validateAndParse } from '@/lib/validation';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

const PLAN_PRICES: Record<string, {amount: number, description: string}> = {
  BOOK_PART_2: { amount: 3000, description: 'Livre Partie 2' },
  BOOK_PART_3: { amount: 3000, description: 'Livre Partie 3' },
};

export async function POST(req: NextRequest) {
  try {
    // Debug: traces minimales
    const hasAuth = (req.headers.get('authorization') || '').startsWith('Bearer ');
    log('Checkout request received', { hasAuth });

    // Rate limiting
    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    if (!rateLimit(clientIp, 10, 60_000)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const uid = await requireUser(req);
    
    // Validation avec Zod
    const rawBody = await req.json().catch(() => ({}));
    const validation = validateAndParse(checkoutSchema, rawBody);
    if (!validation.success) {
      return badRequest(validation.error);
    }
    const { planId } = validation.data;
    
    if (!PLAN_PRICES[planId]) return badRequest('Invalid planId');

    const { amount, description } = PLAN_PRICES[planId];

    const baseUrl = process.env.BASE_URL || 'https://attaqwa-paiement.vercel.app';
    const callbackUrl = `${baseUrl}/api/paydunya/ipn`;
    const cancelUrl = `${baseUrl}/payment/cancel`;
    const returnUrl = `${baseUrl}/payment/return`;

    const invoice = await createCheckoutInvoice({ 
      planId, 
      amount, 
      description, 
      callbackUrl, 
      cancelUrl, 
      returnUrl 
    });

    // Enregistrer paiement PENDING
    const [row] = await db.insert(payments).values({
      uid,
      planId,
      provider: 'paydunya',
      providerToken: invoice.token,
      status: 'PENDING',
      amount,
      currency: 'XOF',
    }).returning();

    await db.insert(auditLogs).values({
      uid, 
      action: 'PAYMENT_CREATED', 
      meta: { planId, providerToken: invoice.token }
    });

    return jsonRes({ 
      paymentId: row.id, 
      token: invoice.token, 
      checkout_url: invoice.checkout_url 
    }, 201);
  } catch (err: unknown) {
    error('Checkout error', err);
    return serverError(err);
  }
}

// Route legacy pour compatibilité
export async function OPTIONS() {
  return new Response(null, { 
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
    }
  });
} 
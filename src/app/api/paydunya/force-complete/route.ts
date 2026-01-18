import { db } from '@/db/client';
import { entitlements, payments } from '@/db/schema';
import { requireAdmin } from '@/lib/adminAuth';
import { badRequest, serverError, unauthorized } from '@/lib/http';
import { jsonRes } from '@/lib/logger';
import { rateLimit } from '@/lib/ratelimit';
import { forceCompleteSchema, validateAndParse } from '@/lib/validation';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    // Rate limiting
    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    if (!rateLimit(clientIp, 10, 60_000)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    // 🔒 AUTHENTIFICATION ADMIN REQUISE
    let adminUid: string;
    try {
      adminUid = await requireAdmin(req);
    } catch {
      return unauthorized('Admin authentication required');
    }

    // Validation avec Zod
    const body = await req.json().catch(() => ({}));
    const validation = validateAndParse(forceCompleteSchema, body);
    if (!validation.success) {
      return badRequest(validation.error);
    }
    const { token, planId } = validation.data;
    
    // Vérifier que le paiement existe
    const [payment] = await db.select().from(payments).where(eq(payments.providerToken, token));
    if (!payment) return jsonRes({ error: 'Payment not found' }, 404);
    
    // Mettre à jour le statut du paiement
    await db.update(payments)
      .set({ status: 'COMPLETED' })
      .where(eq(payments.providerToken, token));
    
    // Créer l'entitlement
    await db.insert(entitlements).values({
      uid: payment.uid,
      resourceId: planId,
      grantedAt: new Date(),
      sourcePaymentId: payment.id,
    }).onConflictDoUpdate({
      target: [entitlements.uid, entitlements.resourceId],
      set: {
        grantedAt: new Date(),
        sourcePaymentId: payment.id,
      }
    });
    
    return jsonRes({ 
      success: true, 
      message: 'Payment completed and entitlement granted' 
    });
  } catch (err: unknown) {
    return serverError(err);
  }
}

export async function OPTIONS() {
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  const origin = allowedOrigins.length > 0 ? allowedOrigins[0] : '*';
  return new Response(null, { 
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
    }
  });
} 
 
 
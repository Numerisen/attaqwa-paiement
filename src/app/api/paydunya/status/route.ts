import { db } from '@/db/client';
import { auditLogs, entitlements, payments } from '@/db/schema';
import { badRequest, serverError } from '@/lib/http';
import { jsonRes, log } from '@/lib/logger';
import { mergePaydunyaStatus } from '@/lib/paydunya';
import { rateLimit } from '@/lib/ratelimit';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    // Rate limiting
    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    if (!rateLimit(clientIp, 60, 60_000)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const token = new URL(req.url).searchParams.get('token');
    if (!token) return badRequest('token required');
    
    const [row] = await db.select().from(payments).where(eq(payments.providerToken, token));
    if (!row) {
      // Inconnu côté DB → tenter une confirmation côté PayDunya (au cas où l'IPN n'est pas encore arrivé)
      const confirmed = await confirmWithPayDunya(token);
      if (!confirmed) return jsonRes({ status: 'UNKNOWN' }, 404);
      return jsonRes({ status: confirmed });
    }
    // Si déjà COMPLETED mais entitlements manquants (edge case), garantir l'octroi
    if (row.status !== 'PENDING') {
      if (row.status === 'COMPLETED') {
        await ensureEntitlementsGranted(row.uid, row.id);
      }
      return jsonRes({ status: row.status });
    }

    // Fallback: DB = PENDING → interroger PayDunya et mettre à jour si nécessaire (avec validation montants)
    const confirmed = await confirmWithPayDunya(token, {
      amount: row.amount,
      currency: row.currency,
      uid: row.uid,
      paymentId: row.id
    });
    if (confirmed) {
      const merged = mergePaydunyaStatus(row.status as 'PENDING'|'COMPLETED'|'FAILED', confirmed);
      if (merged !== row.status) {
        await db.update(payments).set({ status: merged }).where(eq(payments.id, row.id));
      }
      // Si paiement confirmé côté PayDunya, accorder les deux entitlements (fallback)
      if (merged === 'COMPLETED') {
        const resources = ['BOOK_PART_2','BOOK_PART_3'] as const;
        for (const resourceId of resources) {
          await db
            .insert(entitlements)
            .values({ uid: row.uid, resourceId, sourcePaymentId: row.id })
            .onConflictDoUpdate({
              target: [entitlements.uid, entitlements.resourceId],
              set: { sourcePaymentId: row.id },
            });
        }
        await db.insert(auditLogs).values({
          uid: row.uid,
          action: 'ENTITLEMENTS_GRANTED_FALLBACK',
          meta: { resources: ['BOOK_PART_2','BOOK_PART_3'], paymentId: row.id, via: 'status_confirm' },
        });
      }
      return jsonRes({ status: merged });
    }
    return jsonRes({ status: row.status });
  } catch (err: unknown) {
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
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    }
  });
} 

async function confirmWithPayDunya(
  token: string,
  expect?: { amount: number; currency: string; uid?: string; paymentId?: number }
): Promise<'PENDING'|'COMPLETED'|'FAILED'|null> {
  try {
    const { PAYDUNYA_MODE, PAYDUNYA_MASTER_KEY, PAYDUNYA_PRIVATE_KEY, PAYDUNYA_TOKEN } = process.env;
    if (!PAYDUNYA_MASTER_KEY || !PAYDUNYA_PRIVATE_KEY || !PAYDUNYA_TOKEN) return null;
    const BASE = PAYDUNYA_MODE === 'live'
      ? 'https://app.paydunya.com/api/v1'
      : 'https://app.paydunya.com/sandbox-api/v1';
    const headers = {
      'Content-Type': 'application/json',
      'PAYDUNYA-MASTER-KEY': PAYDUNYA_MASTER_KEY,
      'PAYDUNYA-PRIVATE-KEY': PAYDUNYA_PRIVATE_KEY,
      'PAYDUNYA-TOKEN': PAYDUNYA_TOKEN,
    };
    const res = await fetch(`${BASE}/checkout-invoice/confirm/${token}`, { headers, method: 'GET' });
    const data: Record<string, unknown> = await res.json().catch(()=> ({} as Record<string, unknown>));
    log('Confirm PayDunya status response', { ok: res.ok, dataSnippet: JSON.stringify(data).slice(0, 300) });
    if (!res.ok) return null;
    if (data.response_code !== '00') return null;
    const topStatus = typeof data.status === 'string' ? data.status : '';
    const invoiceObj = typeof data.invoice === 'object' && data.invoice ? (data.invoice as Record<string, unknown>) : {};
    const invStatus = typeof invoiceObj.status === 'string' ? invoiceObj.status : '';
    const statusRaw: string = String(topStatus || invStatus || '').toUpperCase();
    let mapped: 'PENDING'|'COMPLETED'|'FAILED' = 'PENDING';
    if (statusRaw.includes('COMPLETE') || statusRaw === 'PAID' || statusRaw === 'SUCCESS' || statusRaw === 'COMPLETED') mapped = 'COMPLETED';
    else if (statusRaw.includes('CANCEL') || statusRaw.includes('FAIL')) mapped = 'FAILED';

    // Validation montant/devise si on a des attentes locales
    if (mapped === 'COMPLETED' && expect) {
      const rawAmount =
        (typeof invoiceObj['total_amount'] === 'number' || typeof invoiceObj['total_amount'] === 'string') ? invoiceObj['total_amount']
        : (data['amount'] as unknown);
      const rawCurrency =
        (typeof invoiceObj['currency'] === 'string') ? invoiceObj['currency']
        : (typeof data['currency'] === 'string' ? (data['currency'] as string) : undefined);

      const receivedAmount = typeof rawAmount === 'string' ? Number(rawAmount) : (typeof rawAmount === 'number' ? rawAmount : NaN);
      const receivedCurrency = typeof rawCurrency === 'string' ? rawCurrency.toUpperCase() : undefined;
      const expectedAmount = expect.amount;
      const expectedCurrency = (expect.currency || '').toUpperCase();
      const amountOk = Number.isFinite(receivedAmount) ? receivedAmount === expectedAmount : true;
      const currencyOk = receivedCurrency ? (receivedCurrency === expectedCurrency) : true;

      if (!amountOk || !currencyOk) {
        // journaliser l’anomalie et ne pas valider COMPLETED
        if (expect.uid && typeof expect.paymentId === 'number') {
          await db.insert(auditLogs).values({
            uid: expect.uid,
            action: 'PAYMENT_MISMATCH',
            meta: {
              provider: 'paydunya',
              token,
              expectedAmount,
              receivedAmount,
              expectedCurrency,
              receivedCurrency,
              where: 'confirm'
            }
          });
        }
        return 'PENDING';
      }
    }

    return mapped;
  } catch {
    return null;
  }
}

async function ensureEntitlementsGranted(uid: string, paymentId: number) {
  const resources = ['BOOK_PART_2','BOOK_PART_3'] as const;
  for (const resourceId of resources) {
    await db
      .insert(entitlements)
      .values({ uid, resourceId, sourcePaymentId: paymentId })
      .onConflictDoUpdate({
        target: [entitlements.uid, entitlements.resourceId],
        set: { sourcePaymentId: paymentId },
      });
  }
  await db.insert(auditLogs).values({
    uid,
    action: 'ENTITLEMENTS_GRANTED_VERIFY_PASS',
    meta: { resources: ['BOOK_PART_2','BOOK_PART_3'], paymentId, via: 'status_verify' },
  });
}
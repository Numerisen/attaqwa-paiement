import { db } from '@/db/client';
import { auditLogs, entitlements, ipnEvents, payments } from '@/db/schema';
import { serverError } from '@/lib/http';
import { jsonRes } from '@/lib/logger';
import { mergePaydunyaStatus, verifyIpnSignature } from '@/lib/paydunya';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text(); // garder le raw pour signature
    const contentType = req.headers.get('content-type') || '';
    console.log('🔔 IPN reçu:', { contentType, rawSnippet: raw.slice(0, 200) });
    
    const signatureOk = verifyIpnSignature(req as Request, raw);
    console.log('🔐 Signature IPN:', signatureOk);
    
    // PayDunya envoie l'IPN en application/x-www-form-urlencoded (clé "data")
    let payload: Record<string, unknown> = {};
    const getString = (obj: Record<string, unknown>, key: string): string | undefined => {
      const v = obj[key];
      return typeof v === 'string' ? v : undefined;
    };
    try {
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const form = new URLSearchParams(raw);
        const data = form.get('data');
        if (data) {
          // data contient généralement un JSON stringifié
          try {
            payload = JSON.parse(data);
          } catch {
            payload = { data };
          }
        } else {
          // Champs plats (ex: data[token], data[status], token, status, transaction_id)
          const flat = Object.fromEntries(form.entries());
          const normalized: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(flat)) {
            const m = k.match(/^data\[(.+)\]$/);
            if (m) {
              normalized[m[1]] = v;
            } else {
              normalized[k] = v;
            }
          }
          payload = normalized;
        }
      } else if (contentType.includes('application/json')) {
        payload = JSON.parse(raw || '{}');
      } else {
        // Fallback: tentative JSON puis key=value parsing simple
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          const form = new URLSearchParams(raw);
          payload = Object.fromEntries(form.entries());
        }
      }
    } catch (e) {
      console.error('❌ Erreur parsing IPN:', e);
      payload = {};
    }
    console.log('📦 Payload IPN (normalisé):', JSON.stringify(payload, null, 2));

    const providerRef =
      getString(payload, 'transaction_id') ||
      getString(payload, 'token') ||
      getString(payload, 'reference') ||
      'unknown';
    
    // idempotence
    try {
      await db.insert(ipnEvents).values({
        providerRef, 
        rawPayload: payload, 
        signatureOk
      });
    } catch {
      // en double → ok
      return jsonRes({ ok: true, duplicate: true }, 200);
    }

    if (!signatureOk) {
      // Ne pas traiter sans signature valide
      return jsonRes({ ok: false, error: 'Invalid signature' }, 403);
    }

    // Trouver payment par token
    // Extraction robuste du token:
    // - token / reference à la racine
    // - invoice.token quand data est JSON imbriqué
    // - clés form-urlencoded "plates" de type data[invoice][token] / invoice][token / invoice.token
    const tokenCandidates: Array<string | undefined> = [];
    tokenCandidates.push(getString(payload, 'token'));
    tokenCandidates.push(getString(payload, 'reference'));
    // invoice.token si présent
    const maybeInvoice = (payload as Record<string, unknown>)['invoice'];
    if (maybeInvoice && typeof maybeInvoice === 'object') {
      const invToken = (maybeInvoice as Record<string, unknown>)['token'];
      if (typeof invToken === 'string') tokenCandidates.push(invToken);
    }
    // scan des clés "plates" qui contiennent invoice + token (ex: 'invoice][token') ou finissent par ']token'
    for (const [k, v] of Object.entries(payload)) {
      const keyLower = k.toLowerCase();
      if (typeof v === 'string' && (keyLower.endsWith(']token') || (keyLower.includes('invoice') && keyLower.includes('token')) || keyLower.includes('invoice.token'))) {
        tokenCandidates.push(v);
      }
    }
    const token = tokenCandidates.find(t => typeof t === 'string' && t.length > 5) || null;
    if (!token) return jsonRes({ ok:false, error:'No token' }, 400);

    const [pay] = await db.select().from(payments).where(eq(payments.providerToken, token));
    if (!pay) return jsonRes({ ok:false, error:'Payment not found' }, 404);

    // Traduire statut PayDunya vers notre statut
    const providerStatus = String(getString(payload, 'status') || '').toUpperCase(); // ex: COMPLETED/FAILED/CANCELLED/PAID
    let status: 'PENDING'|'COMPLETED'|'FAILED' = 'PENDING';
    if (providerStatus.includes('COMPLETE') || providerStatus === 'PAID' || providerStatus === 'SUCCESS') {
      status = 'COMPLETED';
    } else if (providerStatus.includes('CANCEL') || providerStatus.includes('FAIL')) {
      status = 'FAILED';
    }

    // Validation montant/devise avant de confirmer COMPLETED
    const invoiceObj = (maybeInvoice && typeof maybeInvoice === 'object') ? (maybeInvoice as Record<string, unknown>) : {};
    const rawAmount =
      (typeof invoiceObj['total_amount'] === 'number' || typeof invoiceObj['total_amount'] === 'string') ? invoiceObj['total_amount']
      : (payload['amount'] as unknown);
    const rawCurrency =
      (typeof invoiceObj['currency'] === 'string') ? invoiceObj['currency']
      : (typeof payload['currency'] === 'string' ? (payload['currency'] as string) : undefined);

    const receivedAmount = typeof rawAmount === 'string' ? Number(rawAmount) : (typeof rawAmount === 'number' ? rawAmount : NaN);
    const receivedCurrency = typeof rawCurrency === 'string' ? rawCurrency.toUpperCase() : undefined;

    const expectedAmount = pay.amount;
    const expectedCurrency = (pay.currency || '').toUpperCase();

    const amountOk = Number.isFinite(receivedAmount) ? receivedAmount === expectedAmount : true; // si non fourni, on ne bloque pas
    const currencyOk = receivedCurrency ? (receivedCurrency === expectedCurrency) : true; // si non fourni, on ne bloque pas

    if (status === 'COMPLETED' && (!amountOk || !currencyOk)) {
      // Ne pas promouvoir en COMPLETED
      await db.insert(auditLogs).values({
        uid: pay.uid,
        action: 'PAYMENT_MISMATCH',
        meta: {
          provider: 'paydunya',
          token,
          expectedAmount,
          receivedAmount,
          expectedCurrency,
          receivedCurrency,
          where: 'ipn'
        }
      });
      // Répondre 200 pour ne pas faire échouer le callback PayDunya, mais sans accorder les droits
      return jsonRes({ ok: false, mismatch: true }, 200);
    }

    // Idempotence: ne pas rétrograder
    const merged = mergePaydunyaStatus(pay.status as 'PENDING'|'COMPLETED'|'FAILED', status);
    if (merged !== pay.status) {
      await db.update(payments).set({ status: merged }).where(eq(payments.id, pay.id));
    }

    if (merged === 'COMPLETED') {
      // Grant BOTH entitlements for a single successful payment
      const resources = ['BOOK_PART_2','BOOK_PART_3'] as const;
      for (const resourceId of resources) {
        await db
          .insert(entitlements)
          .values({ uid: pay.uid, resourceId, sourcePaymentId: pay.id })
          .onConflictDoUpdate({
            target: [entitlements.uid, entitlements.resourceId],
            set: { sourcePaymentId: pay.id },
          });
      }
      await db.insert(auditLogs).values({
        uid: pay.uid, 
        action: 'ENTITLEMENTS_GRANTED',
        meta: { resources: ['BOOK_PART_2','BOOK_PART_3'], paymentId: pay.id, via: 'ipn' }
      });
    }

    return jsonRes({ ok: true });
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
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
    }
  });
} 
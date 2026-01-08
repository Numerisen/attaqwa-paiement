import { db } from '@/db/client';
import { auditLogs, payments } from '@/db/schema';
import { verifyIdToken } from '@/lib/firebaseAdmin';
import { badRequest, serverError } from '@/lib/http';
import { error, jsonRes, log } from '@/lib/logger';
import { createCheckoutInvoice } from '@/lib/paydunya';
import { rateLimit } from '@/lib/ratelimit';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';

export const runtime = 'nodejs';

/**
 * Obtenir l'UID de l'utilisateur si authentifié, sinon générer un UID anonyme
 */
async function getUserId(req: NextRequest): Promise<string> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  
  if (token) {
    try {
      const decoded = await verifyIdToken(token);
      return decoded.uid;
    } catch (err) {
      // Si le token est invalide, continuer comme utilisateur anonyme
      log('Invalid token, proceeding as anonymous', { error: err });
    }
  }
  
  // Générer un UID anonyme unique basé sur l'IP et le timestamp
  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const anonymousId = `anonymous_${crypto.createHash('md5').update(`${clientIp}_${Date.now()}`).digest('hex').substring(0, 16)}`;
  return anonymousId;
}

/**
 * Endpoint pour créer un paiement de don avec montant personnalisé
 * 
 * L'authentification est OPTIONNELLE - les dons peuvent être effectués sans compte
 * 
 * Body attendu:
 * {
 *   donationType: 'quete' | 'denier' | 'cierge' | 'messe',
 *   amount: number, // Montant en FCFA (XOF) - peut être 10000 ou plus
 *   description?: string, // Description optionnelle
 *   parishId?: string, // ID de la paroisse (optionnel, pour tracking)
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const hasAuth = (req.headers.get('authorization') || '').startsWith('Bearer ');
    log('Donation checkout request received', { hasAuth, anonymous: !hasAuth });

    // Rate limiting
    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    if (!rateLimit(clientIp, 10, 60_000)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    // Obtenir l'UID (authentifié ou anonyme)
    const uid = await getUserId(req);
    const isAnonymous = !hasAuth;
    const body = await req.json().catch(() => ({}));
    
    const donationType = body?.donationType as string;
    const amount = typeof body?.amount === 'number' ? body.amount : Number(body?.amount);
    const description = body?.description || `Don ${donationType || 'général'}`;
    const parishId = body?.parishId as string | undefined;

    // Validation du type de don
    const validDonationTypes = ['quete', 'denier', 'cierge', 'messe'];
    if (!donationType || !validDonationTypes.includes(donationType)) {
      return badRequest('Invalid donationType. Must be one of: quete, denier, cierge, messe');
    }

    // Validation du montant
    if (!Number.isFinite(amount) || amount <= 0) {
      return badRequest('Invalid amount. Must be a positive number');
    }

    // Pas de limite maximale - accepte 10000, 100000, 1000000, etc.
    if (amount < 100) {
      return badRequest('Amount must be at least 100 FCFA');
    }

    // Créer un planId unique pour le don
    const planId = `DONATION_${donationType.toUpperCase()}_${Date.now()}`;

    const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3001';
    const callbackUrl = `${baseUrl}/api/paydunya/ipn`;
    const cancelUrl = `${baseUrl}/payment/cancel`;
    const returnUrl = `${baseUrl}/payment/return?token={token}`;

    // Créer la facture PayDunya avec le montant personnalisé
    const invoice = await createCheckoutInvoice({ 
      planId: planId, // planId est maintenant de type string (pas seulement BOOK_PART_2|BOOK_PART_3)
      amount, 
      description, 
      callbackUrl, 
      cancelUrl, 
      returnUrl 
    });

    // Enregistrer le paiement PENDING
    const [row] = await db.insert(payments).values({
      uid,
      planId,
      provider: 'paydunya',
      providerToken: invoice.token,
      status: 'PENDING',
      amount: Math.round(amount), // S'assurer que c'est un entier
      currency: 'XOF',
    }).returning();

    await db.insert(auditLogs).values({
      uid: uid, // Utilise l'UID anonyme ou authentifié
      action: 'DONATION_CREATED', 
      meta: { 
        planId, 
        donationType,
        amount,
        parishId,
        providerToken: invoice.token,
        isAnonymous
      }
    });

    return jsonRes({ 
      paymentId: row.id, 
      token: invoice.token, 
      checkout_url: invoice.checkout_url,
      amount,
      donationType,
      planId
    }, 201);
  } catch (err: unknown) {
    error('Donation checkout error', err);
    return serverError(err);
  }
}

// CORS pour les requêtes depuis l'app mobile
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


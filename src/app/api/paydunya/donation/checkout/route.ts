import { db } from '@/db/client';
import { auditLogs, payments } from '@/db/schema';
import { verifyIdToken } from '@/lib/firebaseAdmin';
import { badRequest, serverError } from '@/lib/http';
import { error, jsonRes, log } from '@/lib/logger';
import { createCheckoutInvoice } from '@/lib/paydunya';
import { rateLimit } from '@/lib/ratelimit';
import { donationCheckoutSchema, validateAndParse } from '@/lib/validation';
import type { NextRequest } from 'next/server';
import crypto from 'crypto';
import { getFirestoreAdmin } from '@/lib/firestoreAdmin';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const corsOrigin = (origin: string | null) => {
  if (!origin) return '*';
  if (allowedOrigins.length === 0) return '*';
  return allowedOrigins.includes(origin) ? origin : null;
};

/**
 * Obtenir l'UID de l'utilisateur si authentifié, sinon utiliser l'UID anonyme fourni ou en générer un
 */
async function getUserId(req: NextRequest, body?: { anonymousUid?: string }): Promise<string> {
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
  
  // Pour les utilisateurs anonymes, accepter un UID anonyme dans le header ou le body
  const anonymousUid = req.headers.get('x-anonymous-uid') || body?.anonymousUid;
  
  if (anonymousUid && anonymousUid.startsWith('anonymous_')) {
    log('Using provided anonymous UID', { uid: anonymousUid });
    return anonymousUid;
  }
  
  // Générer un nouvel UID anonyme uniquement si aucun n'est fourni
  const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
  const anonymousId = `anonymous_${crypto.randomBytes(16).toString('hex')}`;
  log('Generated new anonymous UID', { uid: anonymousId });
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

    // Parser et valider le body avec Zod
    const rawBody = await req.json().catch(() => ({}));
    const validation = validateAndParse(donationCheckoutSchema, rawBody);
    if (!validation.success) {
      return badRequest(validation.error);
    }
    const body = validation.data;
    
    // Obtenir l'UID (authentifié ou anonyme) - utiliser l'UID du body si fourni
    const uid = await getUserId(req, { anonymousUid: body.anonymousUid });
    const isAnonymous = !hasAuth;
    
    const donationType = body.donationType;
    const amount = body.amount;
    const description = body.description || `Don ${donationType}`;
    const parishId = body.parishId;

    // Créer un planId unique pour le don
    const planId = `DONATION_${donationType.toUpperCase()}_${Date.now()}`;

    // Utiliser l'URL de production par défaut au lieu de localhost
    // Vercel fournit automatiquement VERCEL_URL, mais on préfère BASE_URL si défini
    const baseUrl = process.env.BASE_URL || 
                    process.env.NEXT_PUBLIC_BASE_URL || 
                    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://payment-api-pink.vercel.app');
    const callbackUrl = `${baseUrl}/api/paydunya/ipn`;
    const cancelUrl = `${baseUrl}/payment/cancel`;
    // PayDunya ajoute automatiquement le token à l'URL de retour, ne pas mettre {token} dans l'URL
    const returnUrl = `${baseUrl}/payment/return`;

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

    // 🔁 Synchronisation vers Firestore pour l'interface admin (admin_donations)
    // L'admin ne lit pas la DB payment-api, elle lit Firestore (collection admin_donations)
    try {
      const fs = getFirestoreAdmin();
      let parishName: string | undefined;
      let dioceseName: string | undefined;
      let dioceseId: string | undefined;

      if (parishId) {
        const parishSnap = await fs.collection('parishes').doc(parishId).get();
        if (parishSnap.exists) {
          const p = parishSnap.data() as Record<string, unknown>;
          parishName = typeof p.name === 'string' ? p.name : undefined;
          dioceseName =
            (typeof p.dioceseName === 'string' ? p.dioceseName : undefined) ||
            (typeof p.diocese === 'string' ? p.diocese : undefined);
          dioceseId = typeof p.dioceseId === 'string' ? p.dioceseId : undefined;
        }
      }

      const donorName =
        (typeof (validation.data as any)?.donorName === 'string' && (validation.data as any)?.donorName) ||
        (isAnonymous ? 'Donateur anonyme' : 'Utilisateur');

      // Doc ID basé sur le token PayDunya pour idempotence (même paiement → même doc)
      const docId = `paydunya_${invoice.token}`;
      await fs.collection('admin_donations').doc(docId).set(
        {
          donorName,
          amount: Math.round(amount),
          type: donationType,
          date: new Date().toISOString(),
          diocese: dioceseName || 'Non spécifié',
          parish: parishName || 'Non spécifié',
          description,
          status: 'pending',
          // Champs de liaison
          uid,
          parishId: parishId || null,
          dioceseId: dioceseId || null,
          provider: 'paydunya',
          providerToken: invoice.token,
          paymentId: row.id,
          source: 'mobile',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (e) {
      // Ne pas bloquer le checkout si Firestore est indisponible
      log('Firestore admin_donations sync failed (checkout)', { error: e instanceof Error ? e.message : String(e) });
    }

    return jsonRes({ 
      paymentId: row.id, 
      token: invoice.token, 
      checkout_url: invoice.checkout_url,
      amount,
      donationType,
      planId,
      uid: uid // Retourner l'UID (authentifié ou anonyme) pour que l'app puisse le stocker
    }, 201);
  } catch (err: unknown) {
    error('Donation checkout error', err);
    return serverError(err);
  }
}

// CORS pour les requêtes depuis l'app mobile
export async function OPTIONS() {
  const origin = corsOrigin(null);
  return new Response(null, { 
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
    }
  });
}


import { db } from '@/db/client';
import { payments } from '@/db/schema';
import { verifyIdToken } from '@/lib/firebaseAdmin';
import { jsonRes } from '@/lib/logger';
import { badRequest } from '@/lib/http';
import { rateLimit } from '@/lib/ratelimit';
import { donationsHistoryQuerySchema, validateAndParse } from '@/lib/validation';
import { eq, and, desc } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import * as crypto from 'crypto';

export const runtime = 'nodejs';

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const corsOrigin = (origin: string | null) => {
  if (!origin) return '*';
  if (allowedOrigins.length === 0) return '*';
  return allowedOrigins.includes(origin) ? origin : null;
};

/**
 * Obtenir l'UID de l'utilisateur si authentifié, sinon utiliser l'UID anonyme fourni
 */
async function getUserId(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  
  if (token) {
    try {
      const decoded = await verifyIdToken(token);
      return decoded.uid;
    } catch (err) {
      // Si le token est invalide, continuer comme utilisateur anonyme
      console.log('Invalid token, proceeding as anonymous', { error: err });
    }
  }
  
  // Pour les utilisateurs anonymes, accepter un UID anonyme dans le header ou query
  const anonymousUid = req.headers.get('x-anonymous-uid') || 
                       new URL(req.url).searchParams.get('anonymousUid');
  
  if (anonymousUid && anonymousUid.startsWith('anonymous_')) {
    return anonymousUid;
  }
  
  return null;
}

/**
 * Extraire le type de don depuis le planId
 * Exemple: DONATION_QUETE_1767844133206 -> "quete"
 */
function extractDonationType(planId: string): string {
  if (planId.startsWith('DONATION_')) {
    const parts = planId.split('_');
    if (parts.length >= 2) {
      return parts[1].toLowerCase(); // quete, denier, cierge, prière
    }
  }
  return 'autre';
}

/**
 * Formater le type de don pour l'affichage
 */
function formatDonationType(type: string): string {
  const types: Record<string, string> = {
    'quete': 'Quête dominicale',
    'denier': 'Denier du culte',
    'cierge': 'Cierge pascal',
    'prière': 'prière',
  };
  return types[type] || 'Don';
}

/**
 * Endpoint pour récupérer l'historique des contributions
 * 
 * Fonctionne avec ou sans authentification :
 * - Si authentifié : utilise le token Firebase
 * - Si anonyme : utilise l'UID anonyme (fourni dans header x-anonymous-uid ou query param)
 * 
 * Query params:
 * - anonymousUid: UID anonyme (si utilisateur non authentifié)
 */
export async function GET(req: NextRequest) {
  try {
    // Rate limiting
    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    if (!rateLimit(clientIp, 30, 60_000)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    // Validation des query params avec Zod
    const url = new URL(req.url);
    const queryParams = {
      anonymousUid: url.searchParams.get('anonymousUid') || undefined,
    };
    const validation = validateAndParse(donationsHistoryQuerySchema, queryParams);
    if (!validation.success && queryParams.anonymousUid) {
      return badRequest(validation.error);
    }
    
    // Obtenir l'UID (authentifié ou anonyme)
    const uid = await getUserId(req);
    
    if (!uid) {
      return Response.json({ 
        error: 'User ID required',
        message: 'Provide either a Firebase token (Authorization header) or an anonymous UID (x-anonymous-uid header or anonymousUid query param)'
      }, { status: 401 });
    }

    // Récupérer tous les paiements de type DONATION pour cet utilisateur
    const userPayments = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.uid, uid),
          // Filtrer seulement les dons (planId commence par DONATION_)
          // Note: Drizzle ne supporte pas directement LIKE, on filtre en mémoire
        )
      )
      .orderBy(desc(payments.createdAt));

    // Filtrer les dons (planId commence par DONATION_)
    const donations = userPayments
      .filter(payment => payment.planId.startsWith('DONATION_'))
      .map(payment => {
        const donationType = extractDonationType(payment.planId);
        // Normaliser le statut : PENDING/COMPLETED/FAILED → pending/completed/failed
        const statusUpper = (payment.status || 'PENDING').toUpperCase();
        let normalizedStatus = 'pending';
        if (statusUpper === 'COMPLETED' || statusUpper === 'PAID') {
          normalizedStatus = 'completed';
        } else if (statusUpper === 'FAILED' || statusUpper === 'CANCELED' || statusUpper === 'CANCELLED') {
          normalizedStatus = 'failed';
        }
        
        return {
          id: payment.id.toString(),
          paymentId: payment.id,
          type: formatDonationType(donationType),
          donationType: donationType, // Type brut (quete, denier, etc.)
          amount: payment.amount,
          currency: payment.currency || 'XOF',
          status: normalizedStatus, // pending, completed, failed
          date: payment.createdAt?.toISOString() || new Date().toISOString(),
          createdAt: payment.createdAt?.toISOString(),
          updatedAt: payment.updatedAt?.toISOString(),
          provider: payment.provider,
          providerToken: payment.providerToken,
        };
      });

    // Calculer les statistiques
    const completedDonations = donations.filter(d => d.status === 'completed');
    const pendingDonations = donations.filter(d => d.status === 'pending');
    
    // Total seulement des dons complétés (terminés) - ne pas compter les pending
    const totalAmount = completedDonations.reduce((sum, d) => sum + d.amount, 0);
    
    // Total seulement des dons complétés (pour référence)
    const completedAmount = totalAmount;
    
    const totalCount = donations.length;
    const completedCount = completedDonations.length;

    return jsonRes({
      donations,
      statistics: {
        totalAmount, // Total de tous les dons (pending + completed)
        completedAmount, // Total seulement des dons complétés
        totalCount,
        completedCount,
        pendingCount: pendingDonations.length,
        failedCount: donations.filter(d => d.status === 'failed' || d.status === 'canceled').length,
      },
      uid,
    });
  } catch (err: unknown) {
    console.error('Error fetching donation history:', err);
    return Response.json({ 
      error: 'Server Error',
      message: err instanceof Error ? err.message : 'Unknown error'
    }, { status: 500 });
  }
}

// CORS pour les requêtes depuis l'app mobile
export async function OPTIONS() {
  const origin = corsOrigin(null);
  return new Response(null, { 
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-anonymous-uid',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    }
  });
}


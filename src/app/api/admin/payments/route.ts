import { db } from '@/db/client';
import { payments } from '@/db/schema';
import { requireAdmin } from '@/lib/adminAuth';
import { serverError, unauthorized } from '@/lib/http';
import { jsonRes } from '@/lib/logger';
import { rateLimit } from '@/lib/ratelimit';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

function getCorsHeaders(origin: string | null) {
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  
  // En développement, autoriser localhost
  const isLocalhost = origin?.startsWith('http://localhost:') || origin?.startsWith('http://127.0.0.1:');
  const allowOrigin = isLocalhost ? origin : 
                     (allowedOrigins.length > 0 && origin && allowedOrigins.includes(origin)) ? origin :
                     allowedOrigins.length > 0 ? allowedOrigins[0] : '*';
  
  return {
    'Access-Control-Allow-Origin': allowOrigin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
  };
}

export async function GET(req: NextRequest) {
  try {
    const origin = req.headers.get('origin');
    const corsHeaders = getCorsHeaders(origin);
    
    // Rate limiting
    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    if (!rateLimit(clientIp, 60, 60_000)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429, headers: corsHeaders });
    }

    // 🔒 AUTHENTIFICATION ADMIN REQUISE
    let adminUid: string;
    try {
      adminUid = await requireAdmin(req);
    } catch {
      return unauthorized('Admin authentication required', corsHeaders);
    }

    // Récupérer tous les paiements
    const allPayments = await db.select().from(payments).orderBy(payments.createdAt);
    
    // Filtrer seulement les dons (planId commence par DONATION_)
    // Note: Le filtrage par parishId/dioceseId se fait côté client car
    // la table payments n'a pas ces colonnes (elles sont dans Firestore admin_donations)
    const donations = allPayments.filter(p => p.planId.startsWith('DONATION_'));
    
    const response = jsonRes({ 
      payments: donations, // Retourner seulement les dons
      total: donations.length
    });
    
    // Ajouter les headers CORS
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    
    return response;
  } catch (err: unknown) {
    const origin = req.headers.get('origin');
    const corsHeaders = getCorsHeaders(origin);
    return serverError(err, corsHeaders);
  }
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);
  
  return new Response(null, { 
    status: 204,
    headers: corsHeaders
  });
} 
 
 
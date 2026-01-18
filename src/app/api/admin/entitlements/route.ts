import { db } from '@/db/client';
import { entitlements } from '@/db/schema';
import { requireAdmin } from '@/lib/adminAuth';
import { serverError, unauthorized } from '@/lib/http';
import { jsonRes } from '@/lib/logger';
import { rateLimit } from '@/lib/ratelimit';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    // Rate limiting
    const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown';
    if (!rateLimit(clientIp, 60, 60_000)) {
      return Response.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    // 🔒 AUTHENTIFICATION ADMIN REQUISE
    let adminUid: string;
    try {
      adminUid = await requireAdmin(req);
    } catch {
      return unauthorized('Admin authentication required');
    }

    // Récupérer tous les entitlements
    const allEntitlements = await db.select().from(entitlements).orderBy(entitlements.grantedAt);
    
    return jsonRes({ 
      entitlements: allEntitlements,
      total: allEntitlements.length
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
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    }
  });
} 
 
 
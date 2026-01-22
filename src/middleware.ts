import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const parseAllowedOrigins = () =>
  (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

function resolveOrigin(origin: string | null, allowed: string[]) {
  if (!origin) return '*';
  // Autoriser localhost en développement
  if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
    return origin;
  }
  if (allowed.length === 0) return '*';
  return allowed.includes(origin) ? origin : (allowed.length > 0 ? allowed[0] : '*');
}

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const allowedOrigins = parseAllowedOrigins();
  const origin = req.headers.get('origin');
  const allowedOrigin = resolveOrigin(origin, allowedOrigins);

  res.headers.set("Access-Control-Allow-Origin", allowedOrigin || "*");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-anonymous-uid");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Vary", "Origin");

  // Headers de sécurité minimaux
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');

  return res;
}

export const config = { matcher: ["/api/:path*"] }; 
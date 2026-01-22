function getCorsHeaders(origin: string | null) {
  const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
  const isLocalhost = origin?.startsWith('http://localhost:') || origin?.startsWith('http://127.0.0.1:');
  const allowOrigin = isLocalhost ? origin : 
                     (allowedOrigins.length > 0 && origin && allowedOrigins.includes(origin)) ? origin :
                     allowedOrigins.length > 0 ? allowedOrigins[0] : '*';
  
  return {
    'Access-Control-Allow-Origin': allowOrigin || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };
}

export function badRequest(msg='Bad Request', corsHeaders?: Record<string, string>){ 
  const response = Response.json({error:msg},{status:400});
  if (corsHeaders) {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }
  return response;
}

export function unauthorized(msg='Unauthorized', corsHeaders?: Record<string, string>){ 
  const response = Response.json({error:msg},{status:401});
  if (corsHeaders) {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }
  return response;
}

export function forbidden(msg='Forbidden', corsHeaders?: Record<string, string>){ 
  const response = Response.json({error:msg},{status:403});
  if (corsHeaders) {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }
  return response;
}

export function serverError(err: unknown, corsHeaders?: Record<string, string>) {
  const payload =
    err instanceof Error
      ? { error: 'Server Error', message: err.message, stack: err.stack }
      : { error: 'Server Error', message: String(err) };
  const response = Response.json(payload, { status: 500 });
  if (corsHeaders) {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }
  return response;
}
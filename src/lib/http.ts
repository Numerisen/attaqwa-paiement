export function badRequest(msg='Bad Request'){ return Response.json({error:msg},{status:400});}
export function unauthorized(msg='Unauthorized'){ return Response.json({error:msg},{status:401});}
export function forbidden(msg='Forbidden'){ return Response.json({error:msg},{status:403});}
export function serverError(err: unknown) {
  const payload =
    err instanceof Error
      ? { error: 'Server Error', message: err.message, stack: err.stack }
      : { error: 'Server Error', message: String(err) };
  // Réponse plus verbeuse temporaire pour diagnostic
  return Response.json(payload, { status: 500 });
}
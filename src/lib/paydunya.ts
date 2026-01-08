import crypto from 'crypto';
import { error, log } from './logger';

/**
 * Intégration PayDunya (HTTP JSON) - Récapitulatif du flux
 *
 * 1) Création de facture (checkout-invoice/create)
 *    - Route: POST /api/paydunya/checkout
 *    - On crée une facture PayDunya, on enregistre un paiement en base (status = PENDING)
 *
 * 2) IPN (Instant Payment Notification)
 *    - Route: POST /api/paydunya/ipn
 *    - PayDunya envoie un callback (le plus souvent en application/x-www-form-urlencoded)
 *    - On vérifie la signature (voir verifyIpnSignature ci-dessous), on parse le payload,
 *      on applique une transition d'état idempotente et, si COMPLETED et montants conformes,
 *      on accorde les droits premium (Partie 2 et Partie 3).
 *
 * 3) Page de retour (return_url)
 *    - Page: /payment/return
 *    - Lit le token, appelle /api/paydunya/status et redirige vers le deep-link mobile.
 *
 * 4) Fallback de statut (confirm)
 *    - Route: GET /api/paydunya/status?token=...
 *    - Si DB = PENDING ou inconnue, on interroge PayDunya (checkout-invoice/confirm/{token}),
 *      on valide montant/devise puis on met à jour le statut local de façon idempotente.
 */

type CreateInvoiceParams = {
  planId: string; // Accepte maintenant n'importe quel planId (BOOK_PART_2, BOOK_PART_3, ou DONATION_*)
  amount: number;
  description: string;
  callbackUrl: string; // IPN webhook
  cancelUrl: string;
  returnUrl: string;
};

// Typages basiques des réponses PayDunya (d’après la doc HTTP JSON)
export type PaydunyaInvoiceCreateResponse = {
  response_code?: string;
  response_text?: string;
  token?: string;
  // D’autres champs existent côté PayDunya mais non utilisés ici
};

export type PaydunyaConfirmInvoice = {
  status?: string;
  total_amount?: number | string;
  currency?: string;
  token?: string;
};

export type PaydunyaConfirmResponse = {
  response_code?: string;
  response_text?: string;
  status?: string;
  currency?: string;
  amount?: number | string;
  invoice?: PaydunyaConfirmInvoice | null;
  // D’autres champs existent côté PayDunya mais non utilisés ici
};

export async function createCheckoutInvoice(p: CreateInvoiceParams) {
  const { PAYDUNYA_MODE, PAYDUNYA_MASTER_KEY, PAYDUNYA_PRIVATE_KEY, PAYDUNYA_TOKEN, PAYDUNYA_MERCHANT_NAME } = process.env;
  
  if (!PAYDUNYA_MASTER_KEY || !PAYDUNYA_PRIVATE_KEY || !PAYDUNYA_TOKEN) {
    throw new Error('PayDunya keys missing');
  }

  const BASE = PAYDUNYA_MODE === 'live' 
    ? 'https://app.paydunya.com/api/v1' 
    : 'https://app.paydunya.com/sandbox-api/v1';

  const payload = {
    invoice: {
      items: [{
        name: p.description,
        price: p.amount,
        quantity: 1
      }],
      total_amount: p.amount,
      description: p.description,
      return_url: p.returnUrl,
      cancel_url: p.cancelUrl,
      custom_data: {
        planId: p.planId
      }
    },
    store: {
      name: PAYDUNYA_MERCHANT_NAME || 'AT-TAQWA'
    },
    actions: {
      callback_url: p.callbackUrl,
      return_url: p.returnUrl,
      cancel_url: p.cancelUrl
    }
  };

  const headers = {
    'Content-Type': 'application/json',
    'PAYDUNYA-MASTER-KEY': PAYDUNYA_MASTER_KEY,
    'PAYDUNYA-PRIVATE-KEY': PAYDUNYA_PRIVATE_KEY,
    'PAYDUNYA-TOKEN': PAYDUNYA_TOKEN,
  };

  type PaydunyaCreateResult = { token: string; checkout_url: string | undefined; provider_ref: string };
  try {
    log('Creating PayDunya invoice:', { planId: p.planId, amount: p.amount });
    
    const response = await fetch(`${BASE}/checkout-invoice/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const data: PaydunyaInvoiceCreateResponse = await response.json();
    
    if (data.response_code === '00') {
      log('PayDunya invoice created successfully:', { token: data.token });
      if (!data.token) {
        throw new Error('PayDunya create invoice: missing token in success response');
      }
      const result: PaydunyaCreateResult = {
        token: String(data.token),
        checkout_url: data.response_text,
        provider_ref: String(data.token)
      };
      return result;
    } else {
      error('PayDunya invoice creation failed:', data);
      throw new Error(`PayDunya error: ${data.response_text || 'Unknown error'}`);
    }
  } catch (err) {
    error('PayDunya API error:', err);
    throw err;
  }
}

/**
 * Vérification de la signature IPN PayDunya.
 *
 * Remarque doc:
 * - La documentation PayDunya HTTP JSON indique un mécanisme de signature côté IPN.
 * - Selon les intégrations courantes, un header de signature est fourni (ex: `X-Paydunya-Signature`
 *   ou `PAYDUNYA-SIGNATURE`). Le hash est souvent un HMAC (sha256 ou sha512) calculé
 *   sur le corps RAW de la requête, avec la clé privée (PAYDUNYA_PRIVATE_KEY) comme secret.
 *
 * Choix d’implémentation (documenté et ajustable):
 * - On accepte plusieurs en-têtes possibles: `x-paydunya-signature`, `paydunya-signature`,
 *   `PAYDUNYA-SIGNATURE`.
 * - On calcule 2 variantes de HMAC (sha256 et sha512) avec `PAYDUNYA_PRIVATE_KEY`.
 * - Si la doc de votre compte diffère (ex: utilisation du MASTER_KEY, ou format prefixé
 *   `sha256=...`), adaptez facilement dans cette fonction.
 */
export function verifyIpnSignature(req: Request, rawBody: string): boolean {
  const provided =
    req.headers.get('x-paydunya-signature') ||
    req.headers.get('paydunya-signature') ||
    req.headers.get('PAYDUNYA-SIGNATURE') ||
    '';

  if (!provided) {
    log('PayDunya IPN: signature header missing');
    return false;
  }

  const privateKey = process.env.PAYDUNYA_PRIVATE_KEY || '';
  if (!privateKey) {
    error('PayDunya IPN: missing PAYDUNYA_PRIVATE_KEY env var for signature verification');
    return false;
  }

  // Nettoyer d’éventuels préfixes "sha256=" / "sha512=".
  const normalize = (sig: string) => sig.trim().replace(/^sha(256|512)=/i, '').toLowerCase();
  const providedNorm = normalize(provided);

  const makeHmac = (algo: 'sha256'|'sha512') =>
    crypto.createHmac(algo, privateKey).update(rawBody, 'utf8').digest('hex').toLowerCase();

  const expected256 = makeHmac('sha256');
  const expected512 = makeHmac('sha512');

  // Comparaison en temps constant
  const timingSafeEq = (a: string, b: string) => {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  };

  const match256 = timingSafeEq(providedNorm, expected256);
  const match512 = timingSafeEq(providedNorm, expected512);

  const ok = match256 || match512;
  if (!ok) {
    error('PayDunya IPN invalid signature', {
      provided: provided.slice(0, 16) + '…',
      match256,
      match512
    });
  }
  return ok;
}

/**
 * Fusion de statuts PayDunya vers notre statut local, de manière idempotente.
 * Règle de priorité: COMPLETED > FAILED > PENDING
 */
export function mergePaydunyaStatus(
  current: 'PENDING'|'COMPLETED'|'FAILED',
  incoming: 'PENDING'|'COMPLETED'|'FAILED'
): 'PENDING'|'COMPLETED'|'FAILED' {
  if (current === 'COMPLETED' || incoming === 'COMPLETED') return 'COMPLETED';
  if (current === 'FAILED' || incoming === 'FAILED') return 'FAILED';
  return 'PENDING';
}
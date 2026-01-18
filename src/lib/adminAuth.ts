import { NextRequest } from 'next/server';
import { verifyIdToken } from './firebaseAdmin';
import { unauthorized } from './http';

/**
 * Vérifie que l'utilisateur est authentifié ET est un admin
 * 
 * Pour l'instant, on vérifie seulement l'authentification.
 * Plus tard, vous pouvez ajouter une vérification de rôle depuis Firestore.
 */
export async function requireAdmin(req: NextRequest): Promise<string> {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  
  if (!token) {
    throw new Error('UNAUTHORIZED');
  }
  
  try {
    const decoded = await verifyIdToken(token);
    // TODO: Vérifier le rôle admin depuis Firestore si nécessaire
    // const userDoc = await adminDb.collection('users').doc(decoded.uid).get();
    // if (userDoc.data()?.role !== 'admin') throw new Error('FORBIDDEN');
    
    return decoded.uid;
  } catch (error) {
    throw new Error('UNAUTHORIZED');
  }
}

/**
 * Helper pour retourner une erreur 401
 */
export function adminUnauthorized() {
  return unauthorized('Admin authentication required');
}


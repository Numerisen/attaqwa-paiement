import { getFirestore } from 'firebase-admin/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';
import { cert } from 'firebase-admin/app';

// Normalisation de la clé privée (gestion des échappements)
function normalizePrivateKey(key?: string | null) {
  if (!key) return '';
  return key.replace(/\\n/g, '\n');
}

function buildFirebaseConfig() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

  if (!projectId || !clientEmail || !privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY sont requis');
  }

  return { projectId, clientEmail, privateKey };
}

let firestore: ReturnType<typeof getFirestore> | null = null;

export function getFirestoreAdmin() {
  if (firestore) return firestore;

  // Réutiliser l’app firebase-admin si déjà initialisée
  if (getApps().length === 0) {
    const firebaseConfig = buildFirebaseConfig();
    initializeApp({ credential: cert(firebaseConfig) });
  }

  firestore = getFirestore();
  return firestore;
}



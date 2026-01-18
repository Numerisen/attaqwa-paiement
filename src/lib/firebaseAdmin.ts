import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

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

let app: ReturnType<typeof initializeApp> | null = null;

function getApp() {
  if (app) return app;

  const firebaseConfig = buildFirebaseConfig();

  try {
    app = getApps().length
      ? getApps()[0]
      : initializeApp({
          credential: cert(firebaseConfig),
        });
    return app;
  } catch (error) {
    console.error('Firebase initialization failed:', error);
    throw error;
  }
}

export async function verifyIdToken(idToken: string) {
  try {
    return await getAuth(getApp()).verifyIdToken(idToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Token verification failed:', message);
    throw new Error(`Invalid token: ${message}`);
  }
}
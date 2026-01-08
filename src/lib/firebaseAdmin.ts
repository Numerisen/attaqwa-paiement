import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Configuration Firebase Admin avec les variables d'environnement
const firebaseConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID || 'at-taqwa-app-14b7f',
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL || 'firebase-adminsdk-fbsvc@at-taqwa-app-14b7f.iam.gserviceaccount.com',
  privateKey: (process.env.FIREBASE_PRIVATE_KEY || '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDRL6wJXsryMW/a\nRF5yTemgDw0nPTPePSjh/AKbeGS87hQP1K82vf27pK1EVWYrjJ8zHwevwlSn9lTO\nG29N+0LKu2afHLh5p5BLNJ3Y0G1i2zdbh4xBu/KdOZSujcMHUcoqUNRO+WNVDymH\n89wEXlw6sTlkSr3alYYMGUnoI3rE/fuua7POWZ2XbF0RgfZhsOFrlKzJ55xS/LLt\nI19JysodWMFWyWCKBMuRCNX0NDXTiHrwGjayrzF59VftlmWRDOgSyANWTbyJq4ry\nHAvtNKnZLmcegGfxUDPXHjtTdIAZhRBfCCn2MmK3dERDzTJZ70lzdtDg0ozNzNRH\nFBrrc9XZAgMBAAECggEADFMKh+YhqdbszUdq6GwbtWuS7aVm9BMsC0hoNOsJGwfM\nfx7w5cDtfTaCDifD5GadYzXS+PFyQGURxlo1Grs7dQCegVr//rbhwvSKJOHUGAIX\nXFlQ6Pc0SjwVZ5qq4LhaY1eDcqsHGwCmL0AtoxpAxSUiNFJM+4mvWJt4Jb5Kt5FY\ndDK4dn0vua/hWhtX97GlP4qb7atvoGMjFlp+v099pnVm3uTXF+ZdwCXUasN2xUei\nVwrOFRTsWMGmyAd0MUJNVqzuJMvSpxJf+UKkHbXoDMi1T0gBgLzJkniwB1kgp3XT\nZoc5ABSAWNQOpPaVrkBfRRJMfTDlgG1gUKwi3yGqKQKBgQD+iPX9C4S/nXvYWICg\nYvSAG+Mt0GmbfZkMLdzrSS1KUZteLKD+OiVtsobt4YJFaZEsZDrAbyAjbZ0ZScWn\naKboDoEBucYHdyFxqXYPd+XbhwxN0PNaE9NRK4pUpErA97vP5C9kGxxudngNxojD\nGgfLEVNihEe1wRv2NT8la0beBQKBgQDSY+SXjW1S1Fyhit5j559VPj5VMogBkxe6\nJBHWIUkzJ69gP/qdbPs/VidYiSk+8U3du/b9mmyPlr+jj3p+Cp5WrIKI33xI6LOZ\nrZtA6bszwpXEIPFIYcigBTX2ncJ7ehFJS+thKEhIFLahrMdvq1pZGoz3sa5BE67G\nIbbYIjPMxQKBgFo2uNjjCD3R118qnww5hmcRe0d1oriVn3UNnEtYOFEq82JBdx4k\nBbgHmoMddkqby/Rr4dbqi/2CkDeySfe3w9Bjs52k9mcW9ieO5GU/HZzdFKNP97Bp\nbnBKelDdmhEivNJGEfXtFfqgypQ3VamwxCpZDbDRKYll1D9DSAo/J3LxAoGBAJw5\nQMyoX71Zo07w5yIYI+AQUAjDdOp2Zu/5SKVQIiKyHS/DUj0DZ60oNB8x+kaat88m\ne8jkmiglMDgrmjFtgRWrE2K/UHJzGKnMl7Qj2rYcj0kLjR7KPUdVlzSBAKDfi2Z5\n0VZbqxCbEOIMgisReg0gAf0LGvGHxAerkTH8c6phAoGAKbdBfu0dxhZPWrxShgBD\nvHDobJ7myHjibXA8h5+QmFpa0eIvBc3MxNB5xYt3rdYU5IhwCiYPAu8WW7ILvLwY\nFCRfic6nSb2wia01P6F2M4BM3IX0EOMb6nK5pXVzbwBl/6Ag1E8EAJJEOnqnhU5D\n9zolTBwsSUTV+nA1zoMgh1w=\n-----END PRIVATE KEY-----\n').replace(/\\n/g, '\n'),
};

let app: ReturnType<typeof initializeApp> | null = null;

function getApp() {
  if (app) return app;
  
  // Vérifier que la clé privée est présente
  if (!firebaseConfig.privateKey || !firebaseConfig.privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new Error('FIREBASE_PRIVATE_KEY is not configured. Please set it in Vercel environment variables.');
  }
  
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
    // Remonte une erreur plus explicite pour le diagnostic
    const message = error instanceof Error ? error.message : String(error);
    console.error('Token verification failed:', message);
    throw new Error(`Invalid token: ${message}`);
  }
} 
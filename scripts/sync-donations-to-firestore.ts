/**
 * Script de migration : Synchroniser les dons Neon (payments) → Firestore (admin_donations)
 * 
 * Usage:
 *   npx tsx scripts/sync-donations-to-firestore.ts
 * 
 * Prérequis:
 *   - Variables d'environnement configurées (DATABASE_URL, FIREBASE_*)
 *   - Accès en lecture à Neon Postgres
 *   - Accès en écriture à Firestore (Firebase Admin)
 */

// Charger les variables d'environnement depuis .env
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { db } from '../src/db/client';
import { payments } from '../src/db/schema';
import { getFirestoreAdmin } from '../src/lib/firestoreAdmin';
import { eq } from 'drizzle-orm';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * Extraire le type de don depuis le planId
 * Exemple: DONATION_QUETE_1767844133206 -> "quete"
 */
function extractDonationType(planId: string): string {
  if (planId.startsWith('DONATION_')) {
    const parts = planId.split('_');
    if (parts.length >= 2) {
      return parts[1].toLowerCase(); // QUETE → quete
    }
  }
  return 'autre';
}

/**
 * Normaliser le statut Postgres (PENDING|COMPLETED|FAILED) → Firestore (pending|confirmed|cancelled)
 */
function normalizeStatus(pgStatus: string): 'pending' | 'confirmed' | 'cancelled' {
  switch (pgStatus) {
    case 'COMPLETED':
      return 'confirmed';
    case 'FAILED':
      return 'cancelled';
    case 'PENDING':
    default:
      return 'pending';
  }
}

/**
 * Récupérer parishId/dioceseId depuis Firestore users/{uid}
 */
async function getUserParishAndDiocese(
  fs: ReturnType<typeof getFirestoreAdmin>,
  uid: string
): Promise<{ parishId?: string; dioceseId?: string }> {
  try {
    const userSnap = await fs.collection('users').doc(uid).get();
    if (userSnap.exists) {
      const userData = userSnap.data() as Record<string, unknown>;
      return {
        parishId: typeof userData.parishId === 'string' ? userData.parishId : undefined,
        dioceseId: typeof userData.dioceseId === 'string' ? userData.dioceseId : undefined,
      };
    }
  } catch (error) {
    console.warn(`⚠️  Impossible de récupérer parishId/dioceseId pour uid=${uid}:`, error);
  }
  return {};
}

/**
 * Récupérer nom paroisse + diocèse depuis Firestore parishes/{parishId}
 */
async function getParishInfo(
  fs: ReturnType<typeof getFirestoreAdmin>,
  parishId?: string
): Promise<{ parishName?: string; dioceseName?: string; dioceseId?: string }> {
  if (!parishId) return {};
  try {
    const parishSnap = await fs.collection('parishes').doc(parishId).get();
    if (parishSnap.exists) {
      const p = parishSnap.data() as Record<string, unknown>;
      return {
        parishName: typeof p.name === 'string' ? p.name : undefined,
        dioceseName:
          (typeof p.dioceseName === 'string' ? p.dioceseName : undefined) ||
          (typeof p.diocese === 'string' ? p.diocese : undefined),
        dioceseId: typeof p.dioceseId === 'string' ? p.dioceseId : undefined,
      };
    }
  } catch (error) {
    console.warn(`⚠️  Impossible de récupérer info paroisse parishId=${parishId}:`, error);
  }
  return {};
}

async function main() {
  console.log('🚀 Début de la synchronisation Neon → Firestore (admin_donations)...\n');

  const fs = getFirestoreAdmin();

  // 1) Lire tous les dons depuis Neon (payments où planId commence par DONATION_)
  const allPayments = await db.select().from(payments).orderBy(payments.createdAt);
  const donations = allPayments.filter((p) => p.planId.startsWith('DONATION_'));

  console.log(`📊 ${donations.length} dons trouvés dans Neon.\n`);

  let syncCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const payment of donations) {
    const { id, uid, planId, providerToken, status, amount, currency, createdAt, updatedAt } = payment;

    try {
      // Extraire le type de don
      const donationType = extractDonationType(planId);

      // Statut normalisé
      const normalizedStatus = normalizeStatus(status);

      // Récupérer parishId/dioceseId depuis l'utilisateur
      const { parishId: userParishId, dioceseId: userDioceseId } = await getUserParishAndDiocese(fs, uid);

      // Récupérer info paroisse
      const { parishName, dioceseName, dioceseId: parishDioceseId } = await getParishInfo(fs, userParishId);

      // Priorité: dioceseId depuis paroisse > dioceseId depuis user
      const finalDioceseId = parishDioceseId || userDioceseId;

      // Nom donateur (fallback: anonyme)
      const donorName = uid.startsWith('anonymous_') ? 'Donateur anonyme' : 'Utilisateur';

      // Doc ID basé sur providerToken PayDunya (ou fallback sur payment.id)
      const docId = providerToken ? `paydunya_${providerToken}` : `payment_${id}`;

      // Vérifier si le doc existe déjà
      const existingDoc = await fs.collection('admin_donations').doc(docId).get();
      if (existingDoc.exists) {
        console.log(`⏭️  Skip (existe déjà): ${docId}`);
        skipCount++;
        continue;
      }

      // Créer le doc dans admin_donations
      await fs.collection('admin_donations').doc(docId).set({
        donorName,
        fullname: donorName, // Alias pour compatibilité admin paroisse
        amount: Math.round(amount),
        type: donationType,
        date: createdAt.toISOString(),
        diocese: dioceseName || 'Non spécifié',
        parish: parishName || 'Non spécifié',
        description: `Don ${donationType} (migré depuis Neon)`,
        status: normalizedStatus,
        // Champs de liaison
        uid,
        parishId: userParishId || null,
        dioceseId: finalDioceseId || null,
        provider: 'paydunya',
        providerToken: providerToken || null,
        paymentId: id,
        source: 'mobile',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(`✅ Synchronisé: ${docId} (${donationType}, ${amount} FCFA, ${normalizedStatus})`);
      syncCount++;
    } catch (error) {
      console.error(`❌ Erreur sur payment.id=${id}:`, error);
      errorCount++;
    }
  }

  console.log(`\n📈 Synchronisation terminée :`);
  console.log(`   ✅ Synchronisés : ${syncCount}`);
  console.log(`   ⏭️  Ignorés (déjà présents) : ${skipCount}`);
  console.log(`   ❌ Erreurs : ${errorCount}`);
}

main()
  .then(() => {
    console.log('\n✅ Script terminé avec succès.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Erreur fatale:', error);
    process.exit(1);
  });


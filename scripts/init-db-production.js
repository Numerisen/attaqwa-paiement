/**
 * Script pour initialiser la base de données en production
 * À exécuter une seule fois pour créer les tables nécessaires
 */

const { Client } = require('pg');
require('dotenv').config({ path: '.env.local' });

// Utiliser les variables d'environnement de Vercel
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ POSTGRES_URL ou DATABASE_URL doit être défini');
  process.exit(1);
}

async function initDatabase() {
  const client = new Client({
    connectionString,
    ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
    console.log('✅ Connecté à la base de données\n');

    // Vérifier si la table payments existe
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'payments'
      );
    `);

    if (tableExists.rows[0].exists) {
      console.log('⚠️  La table payments existe déjà');
      console.log('📋 Vérification de la structure...\n');
      
      // Vérifier les colonnes
      const columns = await client.query(`
        SELECT column_name, data_type, character_maximum_length
        FROM information_schema.columns
        WHERE table_name = 'payments'
        ORDER BY ordinal_position;
      `);
      
      console.log('Colonnes actuelles:');
      columns.rows.forEach(col => {
        console.log(`  - ${col.column_name} (${col.data_type}${col.character_maximum_length ? `(${col.character_maximum_length})` : ''})`);
      });
      
      // Vérifier si plan_id existe
      const hasPlanId = columns.rows.some(col => col.column_name === 'plan_id');
      if (!hasPlanId) {
        console.log('\n❌ La colonne plan_id est manquante !');
        console.log('🔧 Ajout de la colonne plan_id...');
        await client.query(`
          ALTER TABLE payments 
          ADD COLUMN IF NOT EXISTS plan_id VARCHAR(64) NOT NULL DEFAULT 'UNKNOWN';
        `);
        console.log('✅ Colonne plan_id ajoutée');
      }
    } else {
      console.log('🔨 Création de la table payments...\n');
      
      // Créer la table payments
      await client.query(`
        CREATE TABLE IF NOT EXISTS payments (
          id SERIAL PRIMARY KEY,
          uid VARCHAR(128) NOT NULL,
          plan_id VARCHAR(64) NOT NULL,
          provider VARCHAR(32) NOT NULL DEFAULT 'paydunya',
          provider_token VARCHAR(128) NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
          amount INTEGER NOT NULL DEFAULT 0,
          currency VARCHAR(8) NOT NULL DEFAULT 'XOF',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Table payments créée');
    }

    // Créer les autres tables nécessaires
    console.log('\n🔨 Création des autres tables...\n');

    // Table users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(128) NOT NULL,
        email VARCHAR(256),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table users créée');

    // Table entitlements
    await client.query(`
      CREATE TABLE IF NOT EXISTS entitlements (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(128) NOT NULL,
        resource_id VARCHAR(64) NOT NULL,
        granted_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP,
        source_payment_id INTEGER,
        UNIQUE(uid, resource_id)
      );
    `);
    console.log('✅ Table entitlements créée');

    // Table ipn_events
    await client.query(`
      CREATE TABLE IF NOT EXISTS ipn_events (
        id SERIAL PRIMARY KEY,
        provider_ref VARCHAR(128) NOT NULL,
        raw_payload JSONB NOT NULL,
        signature_ok BOOLEAN NOT NULL,
        processed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(provider_ref)
      );
    `);
    console.log('✅ Table ipn_events créée');

    // Table audit_logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(128),
        action VARCHAR(64) NOT NULL,
        meta JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table audit_logs créée');

    console.log('\n🎉 Base de données initialisée avec succès !\n');

    // Vérification finale
    const tables = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('payments', 'users', 'entitlements', 'ipn_events', 'audit_logs')
      ORDER BY table_name;
    `);

    console.log('📋 Tables créées:');
    tables.rows.forEach(row => {
      console.log(`  ✅ ${row.table_name}`);
    });

  } catch (error) {
    console.error('❌ Erreur lors de l\'initialisation:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

initDatabase();


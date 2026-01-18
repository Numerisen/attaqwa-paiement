/**
 * Script pour initialiser la base de données Vercel
 * Utilise l'URL depuis les variables d'environnement Vercel
 * 
 * IMPORTANT : Vous devez passer l'URL de la base de données en argument
 * ou la définir dans POSTGRES_URL
 */

const { Client } = require('pg');

// L'URL peut être passée en argument ou via variable d'environnement
const connectionString = process.argv[2] || process.env.POSTGRES_URL || process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ POSTGRES_URL ou DATABASE_URL doit être défini');
  console.error('Usage: node init-db-vercel.js "postgres://user:pass@host/db"');
  console.error('OU définissez POSTGRES_URL dans votre environnement');
  process.exit(1);
}

async function initDatabase() {
  const client = new Client({
    connectionString,
    ssl: connectionString.includes('sslmode=require') || connectionString.includes('ssl=true') 
      ? { rejectUnauthorized: false } 
      : false,
  });

  try {
    await client.connect();
    console.log('✅ Connecté à la base de données\n');

    // Créer toutes les tables nécessaires
    console.log('🔨 Création des tables...\n');

    // Table payments
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
    console.error('❌ Erreur lors de l\'initialisation:', error.message);
    if (error.message.includes('does not exist')) {
      console.error('\n💡 Vérifiez que l\'URL de la base de données est correcte');
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

initDatabase();


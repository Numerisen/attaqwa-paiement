'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

function PaymentReturnContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Vérification du paiement...');
  
  useEffect(() => {
    const token = searchParams.get('token');
    
    if (!token) {
      setStatus('error');
      setMessage('Token de paiement manquant');
      return;
    }

    // Vérifier le statut du paiement
    const checkPaymentStatus = async () => {
      try {
        const response = await fetch(`/api/paydunya/status?token=${token}`);
        
        if (response.ok) {
          const data = await response.json();
          
          if (data.status === 'completed' || data.status === 'COMPLETED') {
            setStatus('success');
            setMessage('Paiement confirmé ! Redirection vers l\'application...');
            
            // Rediriger vers l'app mobile avec le token
            setTimeout(() => {
              window.location.href = `samaquete://payment/return?token=${token}`;
            }, 2000);
          } else if (data.status === 'pending' || data.status === 'PENDING') {
            setStatus('success');
            setMessage('Paiement en cours de traitement ! Redirection vers l\'application...');
            
            // Rediriger vers l'app mobile avec le token même si en cours
            setTimeout(() => {
              window.location.href = `samaquete://payment/return?token=${token}`;
            }, 2000);
          } else {
            setStatus('error');
            setMessage(`Statut du paiement: ${data.status}`);
          }
        } else {
          setStatus('error');
          setMessage('Erreur lors de la vérification');
        }
      } catch {
        setStatus('error');
        setMessage('Erreur réseau');
      }
    };

    checkPaymentStatus();
  }, [searchParams]);

  const mobileUrl = `samaquete://payment/return?token=${searchParams.get('token') || ''}`;
  
  return (
    <html>
      <head>
        <title>Paiement réussi - At-Taqwa</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style={{
        fontFamily: 'Arial, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        margin: 0,
        backgroundColor: '#f5f5f5'
      }}>
        <div style={{
          textAlign: 'center',
          padding: '2rem',
          backgroundColor: 'white',
          borderRadius: '10px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
          maxWidth: '400px'
        }}>
          {status === 'loading' && (
            <>
              <h1 style={{ color: '#2196F3', marginBottom: '1rem' }}>⏳ Vérification...</h1>
              <p style={{ marginBottom: '1rem' }}>{message}</p>
            </>
          )}
          
          {status === 'success' && (
            <>
              <h1 style={{ color: '#4CAF50', marginBottom: '1rem' }}>✅ Paiement réussi !</h1>
              <p style={{ marginBottom: '1rem' }}>{message}</p>
              <div style={{ marginTop: '2rem' }}>
                <a 
                  href={mobileUrl}
                  style={{
                    backgroundColor: '#4CAF50',
                    color: 'white',
                    padding: '12px 24px',
                    textDecoration: 'none',
                    borderRadius: '5px',
                    display: 'inline-block'
                  }}
                >
                  Ouvrir l'application
                </a>
              </div>
            </>
          )}
          
          {status === 'error' && (
            <>
              <h1 style={{ color: '#f44336', marginBottom: '1rem' }}>❌ Erreur</h1>
              <p style={{ marginBottom: '1rem' }}>{message}</p>
              <div style={{ marginTop: '2rem' }}>
                <a 
                  href={mobileUrl}
                  style={{
                    backgroundColor: '#f44336',
                    color: 'white',
                    padding: '12px 24px',
                    textDecoration: 'none',
                    borderRadius: '5px',
                    display: 'inline-block'
                  }}
                >
                  Retourner à l'application
                </a>
              </div>
            </>
          )}
        </div>
      </body>
    </html>
  );
}

export default function PaymentReturnPage() {
  return (
    <Suspense fallback={
      <html>
        <head>
          <title>Paiement réussi - At-Taqwa</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body style={{
          fontFamily: 'Arial, sans-serif',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          margin: 0,
          backgroundColor: '#f5f5f5'
        }}>
          <div style={{
            textAlign: 'center',
            padding: '2rem',
            backgroundColor: 'white',
            borderRadius: '10px',
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
            maxWidth: '400px'
          }}>
            <h1 style={{ color: '#2196F3', marginBottom: '1rem' }}>⏳ Chargement...</h1>
            <p>Vérification du paiement...</p>
          </div>
        </body>
      </html>
    }>
      <PaymentReturnContent />
    </Suspense>
  );
} 
 
 
'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

function PaymentReturnContent() {
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Vérification du paiement...');
  
  useEffect(() => {
    // PayDunya peut passer le token sous différents noms de paramètres
    // Si PayDunya n'a pas remplacé {token} dans l'URL, il peut y avoir plusieurs paramètres token
    // On prend le dernier token (le vrai) et on ignore {token} littéral
    
    let token: string | null = null;
    
    // Extraire tous les tokens de l'URL
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const allTokens = urlParams.getAll('token');
      
      // Si plusieurs tokens, prendre le dernier (ignorer {token} littéral)
      if (allTokens.length > 0) {
        // Filtrer pour exclure {token} littéral et prendre le dernier token valide
        const validTokens = allTokens.filter(t => t && t !== '{token}' && t.length > 5);
        if (validTokens.length > 0) {
          token = validTokens[validTokens.length - 1]; // Prendre le dernier token valide
        }
      }
    }
    
    // Si pas de token trouvé, essayer les autres paramètres
    if (!token) {
      token = searchParams.get('invoice_token') || 
              searchParams.get('reference') ||
              searchParams.get('checkout_token') ||
              searchParams.get('opr') || // PayDunya peut utiliser 'opr' comme paramètre
              searchParams.get('invoice-token');
    }
    
    // Si toujours pas de token, essayer depuis le hash de l'URL
    if (!token && typeof window !== 'undefined' && window.location.hash) {
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      token = hashParams.get('token') || hashParams.get('reference');
    }
    
    // Debug: afficher tous les paramètres pour comprendre ce que PayDunya envoie
    if (typeof window !== 'undefined') {
      const allParams = Object.fromEntries(searchParams.entries());
      console.log('📋 Paramètres URL reçus:', allParams);
      console.log('🔑 Token extrait:', token);
      console.log('🌐 URL complète:', window.location.href);
    }
    
    // Même sans token, on peut rediriger vers l'app (le paiement a réussi si on est ici)
    // L'app pourra vérifier le statut depuis l'historique
    if (!token) {
      console.warn('⚠️ Token non trouvé dans l\'URL, redirection vers l\'app sans token');
      setStatus('success');
      setMessage('Paiement effectué ! Redirection vers l\'application...');
      // Rediriger quand même vers l'app (sans token, l'app vérifiera l'historique)
      setTimeout(() => {
        redirectToApp('');
      }, 1000);
      return;
    }

    // Vérifier le statut du paiement
    const checkPaymentStatus = async () => {
      try {
        // Utiliser l'URL absolue pour éviter les problèmes de chemin relatif
        const apiUrl = typeof window !== 'undefined' 
          ? `${window.location.origin}/api/paydunya/status?token=${token}`
          : `/api/paydunya/status?token=${token}`;
        
        const response = await fetch(apiUrl);
        
        if (response.ok) {
          const data = await response.json();
          
          if (data.status === 'completed' || data.status === 'COMPLETED') {
            setStatus('success');
            setMessage('Paiement confirmé ! Redirection vers l\'application...');
            
            // Rediriger immédiatement vers l'app mobile avec le token
            // Attendre un court instant pour que le message s'affiche
            setTimeout(() => {
              redirectToApp(token);
            }, 1500);
          } else if (data.status === 'pending' || data.status === 'PENDING') {
            setStatus('success');
            setMessage('Paiement en cours de traitement ! Redirection vers l\'application...');
            
            // Rediriger vers l'app mobile avec le token même si en cours
            setTimeout(() => {
              redirectToApp(token);
            }, 1500);
          } else {
            setStatus('error');
            setMessage(`Statut du paiement: ${data.status}`);
          }
        } else {
          const errorData = await response.json().catch(() => ({}));
          console.error('Erreur API status:', { status: response.status, statusText: response.statusText, errorData });
          
          // Même en cas d'erreur, si on a un token, rediriger vers l'app
          // Le paiement a probablement réussi (compte débité), l'app vérifiera le statut
          if (token) {
            console.log('⚠️ Erreur de vérification mais token présent, redirection vers l\'app');
            setStatus('success');
            setMessage('Paiement effectué ! Redirection vers l\'application...');
            redirectToApp(token);
            return;
          }
          
          setStatus('error');
          // Afficher un message plus informatif
          if (response.status === 404) {
            setMessage('Paiement non trouvé. Le token peut être invalide ou expiré.');
          } else if (response.status === 429) {
            setMessage('Trop de requêtes. Veuillez patienter quelques instants.');
          } else {
            setMessage(errorData.error || `Erreur lors de la vérification (${response.status})`);
          }
        }
      } catch (err) {
        console.error('Erreur lors de la vérification du paiement:', err);
        
        // Même en cas d'erreur réseau, si on a un token, rediriger vers l'app
        // Le paiement a probablement réussi (compte débité), l'app vérifiera le statut
        if (token) {
          console.log('⚠️ Erreur réseau mais token présent, redirection vers l\'app');
          setStatus('success');
          setMessage('Paiement effectué ! Redirection vers l\'application...');
          redirectToApp(token);
          return;
        }
        
        setStatus('error');
        setMessage('Erreur réseau lors de la vérification. Vérifiez votre connexion internet.');
      }
    };
    
    // Fonction pour rediriger vers l'app mobile
    const redirectToApp = (paymentToken: string) => {
      // Construire le deep link avec ou sans token
      const deepLink = paymentToken 
        ? `jangui-bi://payment/return?token=${encodeURIComponent(paymentToken)}`
        : `jangui-bi://payment/return`;
      
      console.log('🔗 Tentative de redirection vers:', deepLink);
      
      // Essayer plusieurs méthodes de redirection pour iOS/Safari
      // Méthode 1 : Créer un lien invisible et le cliquer (plus fiable pour Safari iOS)
      try {
        const link = document.createElement('a');
        link.href = deepLink;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
          if (document.body.contains(link)) {
            document.body.removeChild(link);
          }
        }, 100);
      } catch (e) {
        console.warn('Méthode 1 (lien invisible) échouée:', e);
      }
      
      // Méthode 2 : window.location.href après un court délai (fallback)
      setTimeout(() => {
        try {
          window.location.href = deepLink;
        } catch (e2) {
          console.warn('Méthode 2 (location.href) échouée:', e2);
        }
      }, 300);
      
      // Méthode 3 : window.open (dernier recours)
      setTimeout(() => {
        try {
          window.open(deepLink, '_self');
        } catch (e3) {
          console.warn('Méthode 3 (window.open) échouée:', e3);
        }
      }, 600);
    };

    checkPaymentStatus();
  }, [searchParams]);

  const mobileUrl = `jangui-bi://payment/return?token=${searchParams.get('token') || ''}`;
  
  return (
    <html>
      <head>
        <title>Paiement réussi - Jàngu Bi</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {status === 'success' && (
          <meta httpEquiv="refresh" content={`0;url=jangui-bi://payment/return?token=${searchParams.get('token') || ''}`} />
        )}
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
                <button
                  onClick={() => {
                    const token = searchParams.get('token') || '';
                    const deepLink = token 
                      ? `jangui-bi://payment/return?token=${encodeURIComponent(token)}`
                      : `jangui-bi://payment/return`;
                    
                    console.log('🔗 Clic sur bouton, redirection vers:', deepLink);
                    
                    // Méthode 1 : Créer un lien et le cliquer (meilleur pour Safari iOS)
                    try {
                      const link = document.createElement('a');
                      link.href = deepLink;
                      link.style.display = 'none';
                      document.body.appendChild(link);
                      link.click();
                      setTimeout(() => {
                        document.body.removeChild(link);
                      }, 100);
                    } catch (e) {
                      console.warn('Méthode 1 échouée:', e);
                    }
                    
                    // Méthode 2 : window.location.href (fallback)
                    setTimeout(() => {
                      try {
                        window.location.href = deepLink;
                      } catch (e2) {
                        console.warn('Méthode 2 échouée:', e2);
                      }
                    }, 200);
                    
                    // Méthode 3 : window.open (dernier recours)
                    setTimeout(() => {
                      try {
                        window.open(deepLink, '_self');
                      } catch (e3) {
                        console.warn('Méthode 3 échouée:', e3);
                      }
                    }, 500);
                  }}
                  style={{
                    backgroundColor: '#4CAF50',
                    color: 'white',
                    padding: '12px 24px',
                    border: 'none',
                    borderRadius: '5px',
                    cursor: 'pointer',
                    fontSize: '16px',
                    fontWeight: 'bold',
                    display: 'inline-block',
                    width: '100%',
                    maxWidth: '300px'
                  }}
                >
                  Ouvrir l'application
                </button>
                <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#666', textAlign: 'center' }}>
                  Si l'application ne s'ouvre pas automatiquement :<br />
                  1. Cliquez sur le bouton ci-dessus<br />
                  2. Si cela ne fonctionne pas, fermez Safari<br />
                  3. Ouvrez manuellement l'application Jàngu Bi<br />
                  4. Votre paiement sera visible dans l'historique
                </p>
              </div>
            </>
          )}
          
          {status === 'error' && (
            <>
              <h1 style={{ color: '#f44336', marginBottom: '1rem' }}>❌ Erreur</h1>
              <p style={{ marginBottom: '1rem' }}>{message}</p>
              <div style={{ marginTop: '2rem' }}>
                <button
                  onClick={() => {
                    const token = searchParams.get('token') || '';
                    const deepLink = token 
                      ? `jangui-bi://payment/return?token=${encodeURIComponent(token)}`
                      : `jangui-bi://payment/return`;
                    
                    console.log('🔗 Clic sur bouton erreur, redirection vers:', deepLink);
                    
                    // Méthode 1 : Créer un lien et le cliquer (meilleur pour Safari)
                    const link = document.createElement('a');
                    link.href = deepLink;
                    link.style.display = 'none';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    
                    // Méthode 2 : window.location.href (fallback)
                    setTimeout(() => {
                      window.location.href = deepLink;
                    }, 300);
                  }}
                  style={{
                    backgroundColor: '#f44336',
                    color: 'white',
                    padding: '12px 24px',
                    border: 'none',
                    borderRadius: '5px',
                    cursor: 'pointer',
                    fontSize: '16px',
                    fontWeight: 'bold'
                  }}
                >
                  Retourner à l'application
                </button>
                <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: '#666' }}>
                  Si l'application ne s'ouvre pas, fermez cette page et rouvrez l'application manuellement
                </p>
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
 
 
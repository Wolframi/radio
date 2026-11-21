import { useCallback, useEffect, useState } from 'react';
import { AdminView } from './components/AdminView';
import { DesktopConsoleView } from './components/DesktopConsoleView';
import { OrderPageView } from './components/OrderPageView';
import { WebPlayerView } from './components/WebPlayerView';
import { api, type AuthUser, type SetupStatusResponse } from './lib/api';

function readRoute(): { pathname: string; search: string } {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

export default function App() {
  const [route, setRoute] = useState(readRoute);
  // Session token held strictly in React memory (never localStorage/sessionStorage)
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);
  const [authAttempted, setAuthAttempted] = useState(false);

  const refreshSetup = useCallback(async () => {
    try {
      const status = await api.getSetupStatus();
      setSetupStatus(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const status = await refreshSetup();
      if (status?.authDisabled && !token && !authAttempted) {
        setAuthAttempted(true);
        try {
          const session = await api.getPreviewSession();
          setToken(session.token);
          setUser(session.user);
        } catch {
          // ignore
        }
      }
    })();
  }, [refreshSetup, token, authAttempted]);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to);
    setRoute(readRoute());
  }, []);

  const handleAuthChange = useCallback((nextToken: string | null, nextUser: AuthUser | null) => {
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  // Route 1: /player/:userSlug/:branchSlug (OBS Browser Source — completely hidden unless ?debug=1)
  const playerMatch = route.pathname.match(/^\/player\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/i);
  if (playerMatch) {
    const params = new URLSearchParams(route.search);
    return (
      <WebPlayerView
        userSlug={playerMatch[1]}
        branchSlug={playerMatch[2]}
        debug={params.get('debug') === '1'}
        obsPassword={params.get('obsPassword') || undefined}
      />
    );
  }

  // Route 2: /order/:userSlug (Public viewer track request form)
  const orderMatch = route.pathname.match(/^\/order\/([a-z0-9_-]+)$/i);
  if (orderMatch) {
    return <OrderPageView userSlug={orderMatch[1]} onNavigate={navigate} />;
  }

  // Route 3: /admin (Admin panel + first-run admin setup)
  if (route.pathname === '/admin') {
    return (
      <AdminView
        token={token}
        user={user}
        setupStatus={setupStatus}
        onAuthChange={handleAuthChange}
        onRefreshSetup={async () => {
          await refreshSetup();
        }}
        onNavigate={navigate}
      />
    );
  }

  // Default Route: Streamer Radio Desktop Console
  return (
    <DesktopConsoleView
      token={token}
      user={user}
      setupStatus={setupStatus}
      onAuthChange={handleAuthChange}
      onNavigate={navigate}
    />
  );
}

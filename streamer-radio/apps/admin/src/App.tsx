import { useCallback, useEffect, useState } from 'react';
import type { StreamerAdminSummary } from '@streamer-radio/shared';

export default function App() {
  const [serverUrl, setServerUrl] = useState(window.location.origin);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [users, setUsers] = useState<StreamerAdminSummary[]>([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    if (!token) return;
    const resp = await fetch(`${serverUrl.replace(/\/$/, '')}/api/admin/users`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      setUsers(data.users ?? []);
    }
  }, [serverUrl, token]);

  useEffect(() => {
    if (!token) return;
    void loadUsers();
    const timer = setInterval(() => void loadUsers(), 5000);
    return () => clearInterval(timer);
  }, [token, loadUsers]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const resp = await fetch(`${serverUrl.replace(/\/$/, '')}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok || data.user?.role !== 'admin') {
      setMessage(data.error || 'Требуются права администратора');
      return;
    }
    setToken(data.token);
    setPassword('');
  }

  async function createStreamer(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setMessage(null);
    const resp = await fetch(`${serverUrl.replace(/\/$/, '')}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ username: newUsername, password: newPassword, role: 'streamer' }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setMessage(data.error || 'Ошибка создания');
      return;
    }
    setNewUsername('');
    setNewPassword('');
    setMessage(`Создан стример ${data.user.username}`);
    void loadUsers();
  }

  async function resetPassword(userId: string, nextPassword: string) {
    if (!token || nextPassword.length < 8) return;
    const resp = await fetch(`${serverUrl.replace(/\/$/, '')}/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password: nextPassword }),
    });
    if (resp.ok) setMessage('Пароль успешно обновлён');
  }

  return (
    <div style={{ maxWidth: 920, margin: '40px auto', padding: '0 20px' }}>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Streamer Radio — Admin Panel</h1>
      {message && <div style={{ marginBottom: 12, padding: 10, background: '#1c1f24', borderRadius: 6 }}>{message}</div>}
      {!token ? (
        <form onSubmit={login} style={{ maxWidth: 360, background: '#16181c', padding: 20, borderRadius: 8, border: '1px solid #262930' }}>
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="Server URL" style={inputCss} />
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Admin username" style={{ ...inputCss, marginTop: 10 }} />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" style={{ ...inputCss, marginTop: 10 }} />
          <button type="submit" style={{ ...btnCss, marginTop: 14, width: '100%' }}>Войти</button>
        </form>
      ) : (
        <>
          <form onSubmit={createStreamer} style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
            <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="Логин стримера (slug)" style={inputCss} required />
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Пароль (мин. 8 симв.)" style={inputCss} required />
            <button type="submit" style={btnCss}>Создать стримера</button>
          </form>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #262930', color: '#9ca3af' }}>
                <th style={{ padding: 10 }}>Пользователь</th>
                <th style={{ padding: 10 }}>Роль</th>
                <th style={{ padding: 10 }}>Статус</th>
                <th style={{ padding: 10 }}>Режим</th>
                <th style={{ padding: 10 }}>Очередь</th>
                <th style={{ padding: 10 }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <ResetRow key={u.id} user={u} onReset={resetPassword} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function ResetRow({ user, onReset }: { user: StreamerAdminSummary; onReset: (id: string, pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('');
  return (
    <tr style={{ borderBottom: '1px solid #1e2127' }}>
      <td style={{ padding: 10 }}>{user.username}</td>
      <td style={{ padding: 10 }}>{user.role}</td>
      <td style={{ padding: 10 }}>{user.online ? 'Онлайн' : 'Оффлайн'}</td>
      <td style={{ padding: 10, fontFamily: 'monospace' }}>{user.mode}</td>
      <td style={{ padding: 10, fontFamily: 'monospace' }}>{user.queueLength}</td>
      <td style={{ padding: 10, display: 'flex', gap: 6 }}>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Новый пароль" style={{ ...inputCss, maxWidth: 160 }} />
        <button onClick={() => { void onReset(user.id, pw); setPw(''); }} style={btnCss}>Сбросить</button>
      </td>
    </tr>
  );
}

const inputCss: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid #2f333c',
  background: '#111214',
  color: '#e5e7eb',
  fontSize: 13,
};

const btnCss: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid #3f444e',
  background: '#2c3038',
  color: '#fff',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, KeyRound, LogOut, RefreshCw, Shield, UserPlus } from 'lucide-react';
import type { StreamerAdminSummary } from '../../shared/schemas';
import { api, type AuthUser, type SetupStatusResponse } from '../lib/api';

interface AdminViewProps {
  token: string | null;
  user: AuthUser | null;
  setupStatus: SetupStatusResponse | null;
  onAuthChange: (token: string | null, user: AuthUser | null) => void;
  onRefreshSetup: () => Promise<void>;
  onNavigate: (path: string) => void;
}

export function AdminView({
  token,
  user,
  setupStatus,
  onAuthChange,
  onRefreshSetup,
  onNavigate,
}: AdminViewProps) {
  // First-run admin claim state
  const [claimAdminPassword, setClaimAdminPassword] = useState('');
  const [claimStreamerName, setClaimStreamerName] = useState('streamer1');
  const [claimStreamerPassword, setClaimStreamerPassword] = useState('');

  // Login state
  const [loginUser, setLoginUser] = useState('admin');
  const [loginPass, setLoginPass] = useState('');

  // Admin panel state
  const [users, setUsers] = useState<StreamerAdminSummary[]>([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'streamer' | 'admin'>('streamer');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const isAdmin = Boolean(token && user?.role === 'admin');

  const loadUsers = useCallback(async () => {
    if (!token || user?.role !== 'admin') return;
    try {
      const res = await api.getAdminUsers(token);
      setUsers(res.users);
    } catch (err: unknown) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Ошибка загрузки пользователей' });
    }
  }, [token, user?.role]);

  useEffect(() => {
    if (!isAdmin) return;
    void loadUsers();
    const interval = setInterval(() => void loadUsers(), 4000);
    return () => clearInterval(interval);
  }, [isAdmin, loadUsers]);

  async function handleClaimAdmin(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setBusy(true);
    try {
      const res = await api.setupAdmin({
        adminPassword: claimAdminPassword,
        initialStreamerUsername: claimStreamerName.trim() || undefined,
        initialStreamerPassword: claimStreamerPassword || undefined,
      });
      onAuthChange(res.token, res.user);
      setClaimAdminPassword('');
      setClaimStreamerPassword('');
      await onRefreshSetup();
      setFeedback({
        kind: 'ok',
        text: res.createdStreamer
          ? `Администратор инициализирован и создан стример ${res.createdStreamer}.`
          : 'Аккаунт администратора инициализирован.',
      });
    } catch (err: unknown) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Ошибка инициализации' });
    } finally {
      setBusy(false);
    }
  }

  async function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setBusy(true);
    try {
      const res = await api.login(loginUser, loginPass);
      if (res.user.role !== 'admin') {
        setFeedback({ kind: 'err', text: 'Этот аккаунт не имеет прав администратора.' });
        return;
      }
      onAuthChange(res.token, res.user);
      setLoginPass('');
    } catch (err: unknown) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Неверный логин или пароль' });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setFeedback(null);
    setBusy(true);
    try {
      const res = await api.createUser(token, {
        username: newUsername.trim().toLowerCase(),
        password: newPassword,
        role: newRole,
      });
      setNewUsername('');
      setNewPassword('');
      setFeedback({ kind: 'ok', text: `Создан пользователь ${res.user.username} (${res.user.role}).` });
      await onRefreshSetup();
      await loadUsers();
    } catch (err: unknown) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Ошибка создания пользователя' });
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(userId: string, nextPw: string) {
    if (!token) return;
    setFeedback(null);
    try {
      await api.resetUserPassword(token, userId, nextPw);
      setFeedback({ kind: 'ok', text: 'Пароль обновлён и захэширован через bcrypt.' });
    } catch (err: unknown) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : 'Ошибка сброса пароля' });
    }
  }

  return (
    <div className="min-h-screen bg-[#111214] text-[#e5e7eb]">
      <header className="border-b border-[#24272f] bg-[#15171b]">
        <div className="mx-auto flex max-w-[1140px] items-center justify-between gap-8 px-6 py-4">
          <span className="text-[15px] font-semibold tracking-tight text-white whitespace-nowrap shrink-0">
            Streamer Radio
          </span>
          <nav className="flex items-center gap-6 text-sm text-[#9ca3af]">
            <button
              onClick={() => onNavigate('/')}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Desktop App
            </button>
            <button
              onClick={() => onNavigate('/admin')}
              className="text-white font-medium whitespace-nowrap shrink-0"
            >
              Админ-панель
            </button>
          </nav>
          <div className="flex items-center gap-3 shrink-0">
            {isAdmin ? (
              <button
                onClick={() => onAuthChange(null, null)}
                className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-3 py-1.5 text-xs font-medium text-[#e5e7eb] hover:bg-[#262a32] whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
                Выйти ({user?.username})
              </button>
            ) : (
              <button
                onClick={() => onNavigate('/')}
                className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-3 py-1.5 text-xs font-medium text-[#e5e7eb] hover:bg-[#262a32] whitespace-nowrap shrink-0"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Назад
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1140px] px-6 py-8">
        {feedback && (
          <div
            className={`mb-6 rounded-[6px] border px-4 py-3 text-sm ${
              feedback.kind === 'ok'
                ? 'border-[#26382c] bg-[#141d17] text-[#86efac]'
                : 'border-[#402326] bg-[#1e1415] text-[#fca5a5]'
            }`}
          >
            {feedback.text}
          </div>
        )}

        {setupStatus?.needsAdminSetup && !isAdmin ? (
          <section className="mx-auto max-w-[460px] rounded-[8px] border border-[#282c34] bg-[#17191d] p-6">
            <div className="flex items-center gap-2 text-base font-semibold text-white">
              <Shield className="h-4 w-4 text-[#9ca3af]" />
              Первичная настройка администратора
            </div>
            <p className="mt-2 text-sm text-[#9ca3af]">
              Задайте пароль для учётной записи <span className="font-mono text-[#e5e7eb]">admin</span>. Пароль
              хэшируется на сервере (bcrypt) и сохраняется атомарно в <span className="font-mono">data/users.json</span>.
            </p>
            <form onSubmit={handleClaimAdmin} className="mt-5 space-y-4">
              <div>
                <label className="mb-1.5 block text-xs text-[#9ca3af]">Пароль администратора (мин. 8 символов)</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={claimAdminPassword}
                  onChange={(e) => setClaimAdminPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white focus:border-[#525866] focus:outline-none"
                />
              </div>

              <div className="border-t border-[#24272f] pt-4">
                <div className="text-xs font-medium text-[#d1d5db]">
                  Опционально: сразу создать первого стримера
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <input
                    value={claimStreamerName}
                    onChange={(e) => setClaimStreamerName(e.target.value)}
                    placeholder="Логин (slug)"
                    className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white focus:border-[#525866] focus:outline-none"
                  />
                  <input
                    type="password"
                    value={claimStreamerPassword}
                    onChange={(e) => setClaimStreamerPassword(e.target.value)}
                    placeholder="Пароль стримера (≥8)"
                    className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white focus:border-[#525866] focus:outline-none"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-[6px] bg-[#e5e7eb] px-4 py-2.5 text-sm font-semibold text-[#111214] hover:bg-white disabled:opacity-50"
              >
                {busy ? 'Инициализация...' : 'Завершить настройку'}
              </button>
            </form>
          </section>
        ) : !isAdmin ? (
          <section className="mx-auto max-w-[400px] rounded-[8px] border border-[#282c34] bg-[#17191d] p-6">
            <h1 className="text-lg font-semibold text-white">Вход для администратора</h1>
            <p className="mt-1 text-xs text-[#9ca3af]">
              Создание стримеров и сброс паролей доступны только с ролью admin.
            </p>
            <form onSubmit={handleAdminLogin} className="mt-5 space-y-3.5">
              <div>
                <label className="mb-1 block text-xs text-[#9ca3af]">Логин</label>
                <input
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                  required
                  className="w-full rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white focus:border-[#525866] focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-[#9ca3af]">Пароль</label>
                <input
                  type="password"
                  value={loginPass}
                  onChange={(e) => setLoginPass(e.target.value)}
                  required
                  className="w-full rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white focus:border-[#525866] focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-[6px] bg-[#e5e7eb] px-4 py-2.5 text-sm font-semibold text-[#111214] hover:bg-white disabled:opacity-50"
              >
                {busy ? 'Вход...' : 'Войти в админ-панель'}
              </button>
            </form>
          </section>
        ) : (
          <div className="space-y-8">
            <section className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-6">
              <div className="flex items-center justify-between gap-4 border-b border-[#24272f] pb-4">
                <div>
                  <h1 className="text-lg font-semibold text-white">Создать аккаунт стримера</h1>
                  <p className="mt-0.5 text-xs text-[#9ca3af]">
                    Для каждого стримера создаётся изолированный каталог data/users/:id/ с 4 ветвями по умолчанию.
                  </p>
                </div>
              </div>

              <form onSubmit={handleCreateUser} className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_150px_auto]">
                <input
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  placeholder="Логин / slug (например: streamer2)"
                  required
                  className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:border-[#525866] focus:outline-none"
                />
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Пароль (минимум 8 символов)"
                  required
                  minLength={8}
                  className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white placeholder-[#6b7280] focus:border-[#525866] focus:outline-none"
                />
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as 'streamer' | 'admin')}
                  className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3 py-2 text-sm text-white focus:border-[#525866] focus:outline-none"
                >
                  <option value="streamer">streamer</option>
                  <option value="admin">admin</option>
                </select>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center justify-center gap-2 rounded-[6px] bg-[#e5e7eb] px-4 py-2 text-sm font-semibold text-[#111214] hover:bg-white disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <UserPlus className="h-4 w-4" />
                  Создать
                </button>
              </form>
            </section>

            <section className="rounded-[8px] border border-[#282c34] bg-[#17191d]">
              <div className="flex items-center justify-between border-b border-[#24272f] px-6 py-4">
                <h2 className="text-sm font-semibold text-white">Аккаунты и статус эфира</h2>
                <button
                  onClick={() => void loadUsers()}
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-3 py-1.5 text-xs text-[#d1d5db] hover:bg-[#262a32]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Обновить
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-[#24272f] text-xs text-[#9ca3af]">
                      <th className="px-6 py-3 font-medium">Пользователь</th>
                      <th className="px-4 py-3 font-medium">Роль</th>
                      <th className="px-4 py-3 font-medium">Статус</th>
                      <th className="px-4 py-3 font-medium">Режим Main</th>
                      <th className="px-4 py-3 font-medium text-right">Слушатели</th>
                      <th className="px-4 py-3 font-medium text-right">Заказы</th>
                      <th className="px-6 py-3 font-medium">Сброс пароля</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#22252d]">
                    {users.map((u) => (
                      <AdminUserRow key={u.id} user={u} onReset={handleResetPassword} onNavigate={onNavigate} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function AdminUserRow({
  user,
  onReset,
  onNavigate,
}: {
  user: StreamerAdminSummary;
  onReset: (id: string, nextPw: string) => Promise<void>;
  onNavigate: (path: string) => void;
}) {
  const [nextPw, setNextPw] = useState('');
  const [saving, setSaving] = useState(false);

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    if (nextPw.length < 8) return;
    setSaving(true);
    try {
      await onReset(user.id, nextPw);
      setNextPw('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="hover:bg-[#1c1f25]">
      <td className="px-6 py-3">
        <div className="font-medium text-white">{user.username}</div>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-[#6b7280]">
          <span>{user.id}</span>
          {user.role === 'streamer' && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => onNavigate(`/order/${user.username}`)}
                className="text-[#9ca3af] hover:text-white underline"
              >
                /order/{user.username}
              </button>
            </>
          )}
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-[#9ca3af]">{user.role}</td>
      <td className="px-4 py-3 text-xs">
        <span className={user.online ? 'text-[#22c55e]' : 'text-[#6b7280]'}>
          {user.online ? 'Онлайн' : 'Оффлайн'}
        </span>
        {user.activeBranches.length > 0 && (
          <div className="font-mono text-[11px] text-[#6b7280]">{user.activeBranches.join(', ')}</div>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-[#e5e7eb]">{user.mode}</td>
      <td className="px-4 py-3 text-right font-mono text-xs text-[#d1d5db] tabular-nums">{user.listenerCount}</td>
      <td className="px-4 py-3 text-right font-mono text-xs text-[#d1d5db] tabular-nums">{user.queueLength}</td>
      <td className="px-6 py-3">
        <form onSubmit={submitReset} className="flex items-center gap-2">
          <input
            type="password"
            minLength={8}
            value={nextPw}
            onChange={(e) => setNextPw(e.target.value)}
            placeholder="Новый пароль (≥8)"
            className="w-[150px] rounded-[6px] border border-[#2f343d] bg-[#111214] px-2.5 py-1.5 text-xs text-white placeholder-[#6b7280] focus:border-[#525866] focus:outline-none"
          />
          <button
            type="submit"
            disabled={saving || nextPw.length < 8}
            className="inline-flex items-center gap-1 rounded-[6px] border border-[#2f343d] bg-[#22262e] px-2.5 py-1.5 text-xs text-[#e5e7eb] hover:bg-[#2c313b] disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <KeyRound className="h-3 w-3" />
            Сбросить
          </button>
        </form>
      </td>
    </tr>
  );
}

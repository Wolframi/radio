import { useEffect, useState } from 'react';
import { ArrowLeft, Check, ListMusic, Radio, Send } from 'lucide-react';
import type { Order, PlaybackStateSnapshot } from '../../shared/schemas';
import { api } from '../lib/api';

interface OrderPageViewProps {
  userSlug: string;
  onNavigate: (path: string) => void;
}

const STATUS_LABELS: Record<Order['status'], { label: string; color: string }> = {
  pending: { label: 'В очереди', color: 'text-[#9ca3af]' },
  downloading: { label: 'Поиск / загрузка', color: 'text-[#d97706]' },
  ready: { label: 'Готов к эфиру', color: 'text-[#22c55e]' },
  playing: { label: 'Играет сейчас', color: 'text-[#22c55e]' },
  failed: { label: 'Не найден', color: 'text-[#ef4444]' },
};

export function OrderPageView({ userSlug, onNavigate }: OrderPageViewProps) {
  const [query, setQuery] = useState('');
  const [requestedBy, setRequestedBy] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [playback, setPlayback] = useState<PlaybackStateSnapshot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .getOrders(userSlug)
      .then((res) => {
        if (!active) return;
        setOrders(res.orders);
        setPlayback(res.playback);
      })
      .catch(() => {
        if (active) setNotFound(true);
      });

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/events/${encodeURIComponent(userSlug)}`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'sync') {
          setOrders(msg.data.queue ?? []);
          setPlayback(msg.data.state ?? null);
        } else if (msg.event === 'queue:updated') {
          setOrders(msg.data ?? []);
        } else if (msg.event === 'playback:state') {
          setPlayback(msg.data ?? null);
        }
      } catch {
        // ignore
      }
    };

    return () => {
      active = false;
      ws.close();
    };
  }, [userSlug]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setError(null);
    setSuccessMsg(null);
    setSubmitting(true);
    try {
      await api.createOrder(userSlug, {
        query: query.trim(),
        requestedBy: requestedBy.trim() || undefined,
      });
      setQuery('');
      setSuccessMsg('Заказ добавлен в очередь основной ветви.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить заказ');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#111214] text-[#e5e7eb]">
      <header className="border-b border-[#24272f] bg-[#15171b]">
        <div className="mx-auto flex max-w-[920px] items-center justify-between gap-8 px-6 py-4">
          <span className="text-[15px] font-semibold tracking-tight text-white whitespace-nowrap shrink-0">
            Streamer Radio
          </span>
          <div className="text-xs text-[#9ca3af] whitespace-nowrap shrink-0">
            Заказ треков / <span className="font-mono text-[#e5e7eb]">{userSlug}</span>
          </div>
          <button
            onClick={() => onNavigate('/')}
            className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#2f343d] bg-[#1d2026] px-3 py-1.5 text-xs font-medium text-[#e5e7eb] transition-colors hover:bg-[#262a32] whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            В консоль
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[920px] px-6 py-8">
        {notFound ? (
          <div className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-6">
            <h1 className="text-lg font-semibold text-white">Стример не найден</h1>
            <p className="mt-2 text-sm text-[#9ca3af]">
              Аккаунт <span className="font-mono text-[#e5e7eb]">{userSlug}</span> ещё не создан администратором.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            <section className="rounded-[8px] border border-[#282c34] bg-[#17191d] p-6">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#24272f] pb-4">
                <div>
                  <h1 className="text-xl font-semibold text-white">Заказать трек для {userSlug}</h1>
                  <p className="mt-1 text-sm text-[#9ca3af]">
                    Заказ не прерывает текущий трек и воспроизводится в основной ветви по очереди.
                  </p>
                </div>
                {playback && (
                  <div className="flex items-center gap-2 font-mono text-xs text-[#9ca3af] tabular-nums">
                    <Radio className="h-3.5 w-3.5 text-[#22c55e]" />
                    <span>Режим: {playback.mode}</span>
                    <span aria-hidden="true">·</span>
                    <span>В очереди: {orders.length}</span>
                  </div>
                )}
              </div>

              <form onSubmit={handleSubmit} className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_200px_auto]">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Исполнитель — Название трека"
                  required
                  maxLength={240}
                  className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3.5 py-2.5 text-sm text-white placeholder-[#6b7280] focus:border-[#525866] focus:outline-none"
                />
                <input
                  value={requestedBy}
                  onChange={(e) => setRequestedBy(e.target.value)}
                  placeholder="Ваш ник (опционально)"
                  maxLength={64}
                  className="rounded-[6px] border border-[#2f343d] bg-[#111214] px-3.5 py-2.5 text-sm text-white placeholder-[#6b7280] focus:border-[#525866] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center justify-center gap-2 rounded-[6px] bg-[#e5e7eb] px-4 py-2.5 text-sm font-semibold text-[#111214] transition-colors hover:bg-white disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Send className="h-4 w-4" />
                  {submitting ? 'Отправка...' : 'Заказать'}
                </button>
              </form>

              {error && <p className="mt-3 text-xs text-[#ef4444]">{error}</p>}
              {successMsg && (
                <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-[#22c55e]">
                  <Check className="h-3.5 w-3.5" />
                  {successMsg}
                </p>
              )}
            </section>

            <section className="rounded-[8px] border border-[#282c34] bg-[#17191d]">
              <div className="flex items-center justify-between border-b border-[#24272f] px-6 py-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <ListMusic className="h-4 w-4 text-[#9ca3af]" />
                  Текущая очередь заказов
                </div>
                <span className="font-mono text-xs text-[#9ca3af] tabular-nums">{orders.length} трек(ов)</span>
              </div>

              {orders.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-[#6b7280]">
                  Очередь пуста — ваш трек станет первым после текущего трека плейлиста.
                </div>
              ) : (
                <div className="divide-y divide-[#22252d]">
                  {orders.map((order, idx) => {
                    const st = STATUS_LABELS[order.status];
                    const title = order.resolvedTitle
                      ? `${order.resolvedArtist || ''} — ${order.resolvedTitle}`
                      : order.query;
                    return (
                      <div key={order.id} className="flex items-center justify-between gap-4 px-6 py-3.5 text-sm">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-[#e5e7eb]">
                            <span className="mr-2 font-mono text-xs text-[#6b7280] tabular-nums">
                              {String(idx + 1).padStart(2, '0')}
                            </span>
                            {title}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-[#6b7280]">
                            <span>{order.requestedBy || 'Зритель'}</span>
                            {order.sourceProvider && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono">{order.sourceProvider}</span>
                              </>
                            )}
                            {order.durationMs && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono tabular-nums">
                                  {Math.floor(order.durationMs / 60000)}:
                                  {String(Math.floor((order.durationMs % 60000) / 1000)).padStart(2, '0')}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <span className={`font-mono text-xs whitespace-nowrap shrink-0 ${st.color}`}>{st.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

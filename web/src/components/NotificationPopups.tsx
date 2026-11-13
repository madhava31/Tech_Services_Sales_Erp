import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { BellIcon, XIcon } from 'lucide-react';
import { api, NotificationList } from '../lib/api';

type Item = NotificationList['items'][number];
const SEEN_KEY = 'notifications-seen';
const CHECK_EVERY_MS = 45 * 1000;
const SHOW_FOR_MS = 8000;

function lastSeen(): number | null {
  try {
    const v = sessionStorage.getItem(SEEN_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}
function remember(id: number) {
  try {
    sessionStorage.setItem(SEEN_KEY, String(id));
  } catch {
    // Without storage the pop-ups still work for as long as the page is open.
  }
}

// New notifications pop up for a few seconds wherever the person is in the app: "Sent for approval",
// "Ravi is asking for approval of …", "Approved: …". Checks every 45 seconds, when the app comes back
// into view, and at once when something in the app announces one ('notifications-check').
export default function NotificationPopups({ onUnread }: { onUnread: (n: number) => void }) {
  const navigate = useNavigate();
  const [shown, setShown] = useState<Item[]>([]);
  const seen = useRef<number | null>(lastSeen());

  const check = useCallback(() => {
    api.notifications
      .list()
      .then((n) => {
        onUnread(n.unread);
        const newest = Math.max(0, ...n.items.map((i) => i.id));
        // The first look on this visit only notes where things stand: old ones don't pop up.
        if (seen.current === null) {
          seen.current = newest;
          remember(newest);
          return;
        }
        const fresh = n.items.filter((i) => i.id > (seen.current ?? 0) && !i.read_at).reverse();
        if (newest > (seen.current ?? 0)) {
          seen.current = newest;
          remember(newest);
        }
        if (fresh.length) setShown((s) => [...s, ...fresh].slice(-3));
      })
      .catch(() => undefined);
  }, [onUnread]);

  useEffect(() => {
    check();
    const timer = setInterval(() => document.visibilityState === 'visible' && check(), CHECK_EVERY_MS);
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('notifications-check', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('notifications-check', check);
    };
  }, [check]);

  // Each pop-up goes away by itself.
  useEffect(() => {
    if (!shown.length) return;
    const timer = setTimeout(() => setShown((s) => s.slice(1)), SHOW_FOR_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  if (!shown.length) return null;
  return createPortal(
    <div className="fixed z-[90] right-4 bottom-6 max-[860px]:left-3 max-[860px]:right-3 max-[860px]:top-3 max-[860px]:bottom-auto flex flex-col gap-2 min-[861px]:w-[360px]" role="status" aria-live="polite">
      {shown.map((n) => (
        <div key={n.id} className="ts-card ts-white !mt-0 !p-0 flex items-start shadow-lg">
          <button
            type="button"
            className="flex-1 min-w-0 flex items-start gap-3 text-left px-4 py-3"
            onClick={() => {
              setShown((s) => s.filter((x) => x.id !== n.id));
              navigate(n.url);
            }}
          >
            <BellIcon className="size-4 mt-0.5 shrink-0 text-brand" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{n.title}</span>
              <span className="block text-xs text-ink-muted mt-0.5">{n.body}</span>
            </span>
          </button>
          <button type="button" onClick={() => setShown((s) => s.filter((x) => x.id !== n.id))} className="grid place-items-center size-11 shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}

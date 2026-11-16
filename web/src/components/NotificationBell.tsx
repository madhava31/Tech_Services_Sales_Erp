import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BellIcon } from 'lucide-react';
import { api, NotificationList } from '../lib/api';
import { formatDateTime } from '../lib/labels';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './layout/dropdown-menu';

// The bell opens the reminders right where the person is, as a pop-up under the bell. Opening it marks
// them seen; choosing one goes to what it is about. The full page (and the choice to also get them on
// the phone) is one tap away at the bottom.
export default function NotificationBell({ unread }: { unread: number }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<NotificationList | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setFailed(false);
    api.notifications
      .list()
      .then((l) => {
        if (!current) return;
        setList(l);
        if (l.unread) api.notifications.readAll().then(() => window.dispatchEvent(new Event('notifications-read'))).catch(() => undefined);
      })
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [open]);

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger className="ts-iconbtn" aria-label={unread ? `Reminders, ${unread} new` : 'Reminders'}>
        <BellIcon aria-hidden="true" />
        {unread > 0 && <span className="absolute -top-0.5 -right-0.5 grid place-items-center min-w-[18px] h-[18px] px-1 rounded-full bg-cta text-oncta text-[10px] font-medium">{unread}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="ts-menu !w-[380px] !max-w-[calc(100vw-24px)] !p-0">
        <div className="px-4 pt-3 pb-2.5 border-b border-dashed border-line2">
          <p className="text-[14px] font-medium text-fg">Reminders</p>
          <p className="text-[12px] text-subtle">Your follow-ups and overdue opportunities.</p>
        </div>
        <div className="max-h-[min(60vh,420px)] overflow-y-auto">
          {failed && <p className="px-4 py-4 text-sm text-danger">Could not load reminders. Try again.</p>}
          {!failed && !list && <p className="px-4 py-4 text-sm text-subtle">Loading…</p>}
          {!failed && list && list.items.length === 0 && <p className="px-4 py-4 text-sm text-subtle">Nothing yet. Reminders arrive at 9 am when something is due.</p>}
          {!failed &&
            list?.items.map((n) => (
              <DropdownMenuItem key={n.id} className="ts-mi !block !whitespace-normal !rounded-none !px-4 !py-3 border-b border-dashed border-line2 last:border-b-0" onSelect={() => navigate(n.url)}>
                <span className={`block text-sm ${n.read_at ? '' : 'font-medium'}`}>{n.title}</span>
                <span className="block text-sm text-ink-muted">{n.body}</span>
                <span className="block text-xs text-subtle mt-0.5">{formatDateTime(n.created_at)}</span>
              </DropdownMenuItem>
            ))}
        </div>
        <DropdownMenuItem className="ts-mi !block !rounded-none !px-4 !py-3 text-center text-sm font-medium border-t border-dashed border-line2" onSelect={() => navigate('/notifications')}>
          See all, and reminders on this phone
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

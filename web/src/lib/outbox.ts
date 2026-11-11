import { useCallback, useEffect, useState } from 'react';
import type { CompanyDetail, CompanySummary, Contact, Task, TodayData, Visit, VisitDetail } from './api';
import { ApiError } from './apiError';
import { cacheGet, cacheSet, outboxAdd, outboxAll, outboxDelete, outboxPut } from './localStore';

// Changes made without signal wait here and are sent, in order, when the connection returns. Each has
// its own Idempotency-Key, so a retry after a dropped connection can't apply it twice. If the server
// refuses one (someone else got there first), it stays here for the person to retry or discard: work
// typed in the field is never silently thrown away.

export type OutboxMeta =
  | { kind: 'visit.create'; uuid: string; visit: Pick<Visit, 'company_id' | 'company_name' | 'company_city' | 'contact_name' | 'salesperson_id' | 'salesperson_name' | 'visited_at' | 'notes' | 'company_approval_status'> }
  | { kind: 'visit.complete'; visitId?: number; uuid?: string }
  | { kind: 'task.done'; taskId: number }
  | { kind: 'task.due'; taskId: number; dueDate: string }
  | { kind: 'task.create'; task: Task };

export interface OutboxItem {
  id?: number;
  key: string;
  userId: number;
  label: string;
  method: 'POST' | 'PUT';
  path: string;
  body: unknown;
  status: 'pending' | 'conflict';
  error?: string;
  createdAt: string;
  meta: OutboxMeta;
}

export type SendResult<T> = { queued: false; data: T } | { queued: true };

const VISIT_MAP = 'outbox:visit-ids';
const CHANGED = 'outbox-changed';

let currentUserId: number | null = null;
export function setOutboxUser(id: number | null) {
  currentUserId = id;
}

const notify = () => window.dispatchEvent(new Event(CHANGED));

export async function myItems(): Promise<OutboxItem[]> {
  if (currentUserId === null) return [];
  try {
    return (await outboxAll<OutboxItem>()).filter((i) => i.userId === currentUserId).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  } catch {
    return [];
  }
}

function post(item: Pick<OutboxItem, 'key' | 'method' | 'path' | 'body'>) {
  return fetch(`/api${item.path}`, {
    method: item.method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': item.key },
    body: JSON.stringify(item.body),
  });
}

async function errorMessage(res: Response) {
  try {
    return ((await res.json()) as { error?: string }).error || `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

async function enqueue(item: Omit<OutboxItem, 'id' | 'userId' | 'status' | 'createdAt'>) {
  if (currentUserId === null) throw new ApiError('Sign in again to save this.', 401);
  await outboxAdd({ ...item, userId: currentUserId, status: 'pending', createdAt: new Date().toISOString() });
  notify();
}

// Sends now if possible, otherwise keeps it for later. `queueOnly` is for changes that depend on an
// earlier one still waiting, such as finishing a visit that was started offline.
export async function sendOrQueue<T>(opts: { method: 'POST' | 'PUT'; path: string; body: unknown; label: string; meta: OutboxMeta; queueOnly?: boolean }): Promise<SendResult<T>> {
  const { queueOnly, ...rest } = opts;
  const item = { ...rest, key: crypto.randomUUID() };
  if (queueOnly || !navigator.onLine) {
    await enqueue(item);
    return { queued: true };
  }
  let res: Response;
  try {
    res = await post(item);
  } catch {
    await enqueue(item);
    return { queued: true };
  }
  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  return { queued: false, data: (await res.json()) as T };
}

let syncing: Promise<void> | null = null;

// Sends what's waiting, oldest first. Stops at the first sign of no connection or an expired sign-in;
// a refusal is marked on that one item and the rest carry on.
export function syncOutbox(): Promise<void> {
  if (!syncing) syncing = drain().finally(() => (syncing = null));
  return syncing;
}

async function drain() {
  if (!navigator.onLine) return;
  const visitIds = (await cacheGet<Record<string, number>>(VISIT_MAP)) ?? {};
  for (const item of await myItems()) {
    if (item.status !== 'pending') continue;
    let path = item.path;
    const local = /local:([0-9a-f-]+)/.exec(path);
    if (local) {
      const id = visitIds[local[1]];
      if (!id) {
        item.status = 'conflict';
        item.error = 'Waiting for the opportunity it belongs to.';
        await outboxPut(item);
        continue;
      }
      path = path.replace(local[0], String(id));
    }
    let res: Response;
    try {
      res = await post({ ...item, path });
    } catch {
      break;
    }
    if (res.ok) {
      if (item.meta.kind === 'visit.create') {
        const created = (await res.json()) as { id: number };
        visitIds[item.meta.uuid] = created.id;
        await cacheSet(VISIT_MAP, visitIds);
      }
      await outboxDelete(item.id!);
    } else if (res.status === 401 || res.status >= 500) {
      break;
    } else {
      item.status = 'conflict';
      item.error = await errorMessage(res);
      await outboxPut(item);
    }
  }
  notify();
  await refreshBootstrap();
}

// A refused visit also holds up finishing it, so both come back together.
export async function retryItem(item: OutboxItem) {
  const items = await myItems();
  for (const i of items) {
    const depends = item.meta.kind === 'visit.create' && i.meta.kind === 'visit.complete' && i.meta.uuid === item.meta.uuid;
    if (i.id === item.id || depends) await outboxPut({ ...i, status: 'pending', error: undefined });
  }
  notify();
  return syncOutbox();
}

export async function discardItem(item: OutboxItem) {
  for (const i of await myItems()) {
    const depends = item.meta.kind === 'visit.create' && i.meta.kind === 'visit.complete' && i.meta.uuid === item.meta.uuid;
    if (i.id === item.id || depends) await outboxDelete(i.id!);
  }
  notify();
}

// ---------- what the device keeps for working offline ----------

const BOOTSTRAP = 'offline:bootstrap';

export interface Bootstrap {
  today: string;
  companies: (CompanySummary & { contacts: Contact[] })[];
  draft_visits: VisitDetail[];
}

export async function refreshBootstrap() {
  try {
    const res = await fetch('/api/offline/bootstrap', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = (await res.json()) as Bootstrap;
    await cacheSet(BOOTSTRAP, data);
    // So an unfinished visit can be opened and completed without signal.
    for (const v of data.draft_visits) await cacheSet(`GET:/visits/${v.id}`, { ...v, requirements: [], tasks: [] });
    // The main lists, so they work even if they weren't opened before the signal went.
    for (const path of ['/today', '/tasks?status=open', '/visits?limit=100', '/opportunities?status=open']) {
      const list = await fetch(`/api${path}`, { credentials: 'same-origin' });
      if (list.ok) await cacheSet(`GET:${path}`, await list.json());
    }
  } catch {
    // No connection: keep what's saved.
  }
}

export async function offlineCompanySearch(q: string): Promise<CompanySummary[]> {
  const data = await cacheGet<Bootstrap>(BOOTSTRAP);
  const term = q.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  return (data?.companies ?? [])
    .filter((c) => !term || c.name.toLowerCase().includes(term) || c.city?.toLowerCase().includes(term) || (digits.length >= 4 && c.phone?.replace(/\D/g, '').includes(digits)))
    .slice(0, 25);
}

export async function offlineCompany(id: number): Promise<CompanyDetail | null> {
  const company = (await cacheGet<Bootstrap>(BOOTSTRAP))?.companies.find((c) => c.id === id);
  if (!company) return null;
  return { address: null, email: null, gstin: null, category: null, contact_person: null, approved_by_username: null, approved_at: null, created_by_username: '', created_at: '', contact_log: [], parent: null, branches: [], visits: [], tasks: [], requirements: [], opportunities: [], ...company };
}

// ---------- showing waiting changes as though they had happened ----------

function applyToTasks(tasks: Task[], items: OutboxItem[], today: string): Task[] {
  let result = [...tasks];
  for (const { meta } of items) {
    if (meta.kind === 'task.done') result = result.filter((t) => t.id !== meta.taskId);
    if (meta.kind === 'task.due') result = result.map((t) => (t.id === meta.taskId ? { ...t, due_date: meta.dueDate, is_overdue: meta.dueDate < today } : t));
    if (meta.kind === 'task.create') result.push({ ...meta.task, is_overdue: meta.task.due_date < today });
  }
  return result.sort((a, b) => a.due_date.localeCompare(b.due_date));
}

export async function overlayTasks(tasks: Task[], status: string | undefined): Promise<Task[]> {
  if (status === 'done') return tasks;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return applyToTasks(tasks, await myItems(), today);
}

export async function overlayToday(data: TodayData): Promise<TodayData> {
  const items = await myItems();
  if (items.length === 0) return data;
  // A saved copy can be from an earlier day, so use the real date for what's due.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const tasks = applyToTasks([...data.overdue, ...data.due_today, ...data.upcoming], items, today);
  const finishedIds = items.flatMap((i) => (i.meta.kind === 'visit.complete' && i.meta.visitId ? [i.meta.visitId] : []));
  const finishedUuids = items.flatMap((i) => (i.meta.kind === 'visit.complete' && i.meta.uuid ? [i.meta.uuid] : []));
  const localDrafts = items.flatMap((i) =>
    i.meta.kind === 'visit.create' && !finishedUuids.includes(i.meta.uuid)
      ? [{ id: -(i.id ?? 0), local_uuid: i.meta.uuid, visited_at: i.meta.visit.visited_at, company_id: i.meta.visit.company_id, company_name: i.meta.visit.company_name, salesperson_name: i.meta.visit.salesperson_name }]
      : []
  );
  return {
    ...data,
    today,
    overdue: tasks.filter((t) => t.due_date < today),
    due_today: tasks.filter((t) => t.due_date === today),
    upcoming: tasks.filter((t) => t.due_date > today),
    draft_visits: [...localDrafts, ...data.draft_visits.filter((v) => !finishedIds.includes(v.id))],
  };
}

// ---------- for screens ----------

export function useOutbox() {
  const [online, setOnline] = useState(navigator.onLine);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const reload = useCallback(() => {
    myItems().then(setItems);
  }, []);
  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      syncOutbox();
    };
    const onOffline = () => setOnline(false);
    reload();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener(CHANGED, reload);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener(CHANGED, reload);
    };
  }, [reload]);
  return { online, items, waiting: items.filter((i) => i.status === 'pending').length, conflicts: items.filter((i) => i.status === 'conflict').length };
}

// The server's id for a visit started offline, once it has one.
export async function syncedVisitId(uuid: string) {
  return (await cacheGet<Record<string, number>>(VISIT_MAP))?.[uuid] ?? null;
}

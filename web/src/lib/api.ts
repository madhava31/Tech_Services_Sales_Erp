import type { Role } from './roles';

import { ApiError, OFFLINE_MESSAGE } from './apiError';
import { cacheGet, cacheSet } from './localStore';
import { offlineCompany, offlineCompanySearch, overlayTasks, overlayToday, sendOrQueue, SendResult } from './outbox';

export { ApiError };

// Pages read without signal come from the last copy saved on this device. Accounts and reports for
// managers aren't kept on phones.
const keepsOffline = (path: string) => !/^\/(auth|admin|team|handover|notifications|offline)/.test(path);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isGet = !init.method || init.method === 'GET';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    if (isGet && keepsOffline(path)) {
      const saved = await cacheGet<T>(`GET:${path}`);
      if (saved !== undefined) return saved;
    }
    throw new ApiError(OFFLINE_MESSAGE, 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error || `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  if (isGet && keepsOffline(path)) void cacheSet(`GET:${path}`, data);
  return data as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });

async function upload<T>(path: string, file: File): Promise<T> {
  return request<T>(path, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
}

export interface SessionUser {
  id: number;
  username: string;
  role: Role;
  salesperson_id: number | null;
}

export interface UserAccount {
  id: number;
  username: string;
  role: Role;
  is_active: boolean;
  deactivated_at: string | null;
  salesperson_id: number | null;
  salesperson_name: string | null;
  salesperson_code: string | null;
  manager_user_id: number | null;
  manager_username: string | null;
  created_at: string;
}

export interface UserAssignment {
  role: Role;
  salesperson_id: number | null;
  manager_user_id: number | null;
}

export interface Salesperson {
  id: number;
  employee_code: string;
  name: string;
  phone: string | null;
  email: string | null;
  is_active: boolean;
  erp_sales_engineer_id: number | null;
  user_id: number | null;
  username: string | null;
  user_is_active: boolean | null;
}

export type SalespersonInput = Pick<Salesperson, 'employee_code' | 'name' | 'phone' | 'email' | 'erp_sales_engineer_id'>;

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  entity_type: string;
  entity_id: number | null;
  summary: string | null;
  actor_username: string | null;
}

export const api = {
  auth: {
    me: () => request<{ needsSetup?: boolean; user?: SessionUser }>('/auth/me'),
    login: (username: string, password: string) => post<{ user: SessionUser }>('/auth/login', { username, password }),
    setup: (username: string, password: string) => post<{ user: SessionUser }>('/auth/setup', { username, password }),
    logout: () => post<{ ok: true }>('/auth/logout'),
  },
  users: {
    list: () => request<UserAccount[]>('/admin/users'),
    create: (data: { username: string; password: string } & UserAssignment) => post<UserAccount>('/admin/users', data),
    update: (id: number, data: UserAssignment) => put<UserAccount>(`/admin/users/${id}`, data),
    deactivate: (id: number, reason: string) => post<UserAccount>(`/admin/users/${id}/deactivate`, { reason }),
    reactivate: (id: number) => post<UserAccount>(`/admin/users/${id}/reactivate`),
    resetPassword: (id: number, password: string) => post<{ ok: true }>(`/admin/users/${id}/reset-password`, { password }),
  },
  salespeople: {
    list: () => request<Salesperson[]>('/admin/salespeople'),
    create: (data: SalespersonInput) => post<Salesperson>('/admin/salespeople', data),
    update: (id: number, data: Partial<SalespersonInput>) => put<Salesperson>(`/admin/salespeople/${id}`, data),
    deactivate: (id: number) => post<Salesperson>(`/admin/salespeople/${id}/deactivate`),
    reactivate: (id: number) => post<Salesperson>(`/admin/salespeople/${id}/reactivate`),
  },
  audit: {
    list: (params: { actor_user_id?: string; entity_type?: string; entity_id?: string; from?: string; to?: string; limit?: number } = {}) =>
      request<AuditEntry[]>(`/admin/audit${qs(params)}`),
  },
  today: () => request<TodayData>('/today').then(overlayToday),
  directory: {
    salespeople: (includeInactive = false) =>
      request<{ id: number; name: string; employee_code: string; is_active: boolean }[]>(`/salespeople${includeInactive ? '?include_inactive=1' : ''}`),
  },
  companies: {
    // Without signal, searches the company list saved on this device.
    search: (q: string) =>
      request<CompanySummary[]>(`/companies${qs({ q, limit: 25 })}`).catch((err) => {
        if (err instanceof ApiError && err.status === 0) return offlineCompanySearch(q);
        throw err;
      }),
    approvals: () => request<PendingCompany[]>('/companies/approvals'),
    approve: (id: number) => post<CompanyDetail>(`/companies/${id}/approve`),
    reject: (id: number, reason: string) => post<CompanyDetail>(`/companies/${id}/reject`, { reason }),
    checkDuplicates: (name: string, phone?: string | null, city?: string | null, parentId?: number | null) =>
      request<DuplicateCandidate[]>(`/companies/check-duplicates${qs({ name, phone, city, parent_company_id: parentId })}`),
    get: (id: number) =>
      request<CompanyDetail>(`/companies/${id}`).catch(async (err) => {
        const saved = err instanceof ApiError && err.status === 0 ? await offlineCompany(id) : null;
        if (saved) return saved;
        throw err;
      }),
    merge: (id: number, into_company_id: number, reason: string) =>
      post<{ into_company_id: number; into_company_name: string; moved: Record<string, number> }>(`/companies/${id}/merge`, { into_company_id, reason }),
    create: (data: CompanyInput & { confirm_new?: boolean; contact?: ContactInput; parent_company_id?: number | null }) =>
      post<CompanyDetail & { primary_contact_id: number | null }>('/companies', data),
    update: (id: number, data: Partial<CompanyInput> & { parent_company_id?: number | null }) => put<CompanyDetail>(`/companies/${id}`, data),
    addContact: (id: number, data: ContactInput) => post<Contact>(`/companies/${id}/contacts`, data),
  },
  contacts: {
    archive: (id: number) => post<{ ok: true }>(`/contacts/${id}/archive`),
  },
  visits: {
    list: (params: { status?: string; company_id?: number; limit?: number } = {}) => request<Visit[]>(`/visits${qs(params)}`),
    get: (id: number) => request<VisitDetail>(`/visits/${id}`),
    create: (data: {
      company_id: number;
      contact_id?: number | null;
      contact?: ContactInput;
      salesperson_id?: number | null;
      notes?: string;
      client_uuid?: string;
    }) => post<Visit>('/visits', data),
    // Keeps working without signal. Started offline, the visit waits on this device.
    start: (
      data: { company_id: number; contact_id?: number | null; contact?: ContactInput; salesperson_id?: number; client_uuid: string; visited_at: string },
      display: { company_name: string; company_city: string | null; contact_name: string | null; salesperson_id: number; salesperson_name: string; company_approval_status: ApprovalStatus }
    ): Promise<SendResult<Visit>> =>
      sendOrQueue<Visit>({
        method: 'POST',
        path: '/visits',
        body: data,
        label: `Opportunity to ${display.company_name}`,
        meta: { kind: 'visit.create', uuid: data.client_uuid, visit: { ...display, company_id: data.company_id, visited_at: data.visited_at, notes: null } },
      }),
    finish: (target: { id: number } | { uuid: string }, companyName: string, data: VisitCompletion): Promise<SendResult<VisitDetail>> =>
      sendOrQueue<VisitDetail>({
        method: 'POST',
        path: 'uuid' in target ? `/visits/local:${target.uuid}/complete` : `/visits/${target.id}/complete`,
        body: data,
        label: `Finish opportunity to ${companyName}`,
        meta: 'uuid' in target ? { kind: 'visit.complete', uuid: target.uuid } : { kind: 'visit.complete', visitId: target.id },
        queueOnly: 'uuid' in target,
      }),
    update: (id: number, data: { notes?: string | null; contact_id?: number | null }) => put<Visit>(`/visits/${id}`, data),
    complete: (
      id: number,
      data: {
        outcome: Outcome;
        notes?: string | null;
        requirements: RequirementInput[];
        follow_up?: TaskInput | null;
        opportunity?: { id: number } | DealInput | null;
      }
    ) => post<VisitDetail>(`/visits/${id}/complete`, data),
  },
  tasks: {
    list: (params: { status?: string; due?: string; company_id?: number } = {}) => request<Task[]>(`/tasks${qs(params)}`).then((tasks) => overlayTasks(tasks, params.status)),
    // These three keep working without signal.
    add: (data: TaskInput & { company_id: number; assignee_salesperson_id?: number }, display: { company_name: string; assignee_name: string }) =>
      sendOrQueue<Task>({
        method: 'POST',
        path: '/tasks',
        body: data,
        label: `New follow-up: ${data.title}`,
        meta: {
          kind: 'task.create',
          // Negative: not on the server yet, so it can't be acted on until it is.
          task: { ...data, id: -Date.now(), priority: data.priority ?? 'normal', is_overdue: false, company_name: display.company_name, assignee_name: display.assignee_name },
        },
      }),
    markDone: (task: Task, outcome_notes?: string) =>
      sendOrQueue<Task>({ method: 'POST', path: `/tasks/${task.id}/complete`, body: { outcome_notes }, label: `Done: ${task.title}`, meta: { kind: 'task.done', taskId: task.id } }),
    log: (task: Task, data: { channel: 'call' | 'whatsapp'; result: 'reached' | 'no_answer'; notes?: string; next_due_date?: string }) =>
      sendOrQueue<{ task: Task; next_task: Task | null }>({
        method: 'POST',
        path: `/tasks/${task.id}/log`,
        body: { ...data, expected_updated_at: task.updated_at },
        label: `${data.channel === 'call' ? 'Call' : 'WhatsApp'}: ${task.title}`,
        meta: data.result === 'reached' ? { kind: 'task.done', taskId: task.id } : { kind: 'task.due', taskId: task.id, dueDate: data.next_due_date ?? tomorrowIst() },
      }),
    bulk: (data: { ids: number[]; due_date?: string; complete?: boolean; assignee_salesperson_id?: number; outcome_notes?: string }) => post<BulkResult>('/tasks/bulk', data),
    reschedule: (task: Task, due_date: string) =>
      sendOrQueue<Task>({
        method: 'PUT',
        path: `/tasks/${task.id}`,
        body: { due_date, expected_updated_at: task.updated_at },
        label: `Reschedule: ${task.title}`,
        meta: { kind: 'task.due', taskId: task.id, dueDate: due_date },
      }),
    create: (data: TaskInput & { company_id: number; assignee_salesperson_id?: number | null }) => post<Task>('/tasks', data),
    update: (id: number, data: Partial<TaskInput>) => put<Task>(`/tasks/${id}`, data),
    complete: (id: number, outcome_notes?: string) => post<Task>(`/tasks/${id}/complete`, { outcome_notes }),
    cancel: (id: number, reason: string) => post<Task>(`/tasks/${id}/cancel`, { reason }),
  },
  opportunities: {
    list: (params: DealFilters = {}) => request<Opportunity[]>(`/opportunities${qs({ ...params })}`),
    exportUrl: (params: DealFilters = {}) => `/api/opportunities/export.xlsx${qs({ ...params })}`,
    erpQuotations: (id: number) => request<ErpQuotation[]>(`/opportunities/${id}/erp-quotations`),
    bulk: (data: { ids: number[]; expected_close_date?: string; stage?: Stage; to_salesperson_id?: number; reason?: string }) => post<BulkResult>('/opportunities/bulk', data),
    quotationRequests: () => request<Opportunity[]>('/opportunities/quotation-requests'),
    get: (id: number) => request<OpportunityDetail>(`/opportunities/${id}`),
    create: (data: DealInput & { company_id: number; stage?: Stage; owner_salesperson_id?: number | null }) => post<Opportunity>('/opportunities', data),
    update: (id: number, data: Partial<DealInput>) => put<Opportunity>(`/opportunities/${id}`, data),
    moveStage: (
      id: number,
      data: { stage: Stage; note?: string; won_value?: number; lost_reason?: LostReason; close_reason?: string }
    ) => post<Opportunity>(`/opportunities/${id}/stage`, data),
    addQuotation: (id: number, data: QuotationInput) => post<QuotationLink>(`/opportunities/${id}/quotations`, data),
    updateQuotation: (linkId: number, data: Partial<QuotationInput>) => put<QuotationLink>(`/quotation-links/${linkId}`, data),
  },
  products: {
    list: (params: { q?: string; oem_id?: number | ''; include_inactive?: number; limit?: number } = {}) => request<Product[]>(`/products${qs(params)}`),
    get: (id: number) => request<Product>(`/products/${id}`),
    create: (data: ProductInput) => post<Product>('/products', data),
    update: (id: number, data: Partial<ProductInput> & { is_active?: boolean }) => put<Product>(`/products/${id}`, data),
  },
  catalogue: {
    oems: (includeInactive = false) => request<NamedOption[]>(`/oems${includeInactive ? '?include_inactive=1' : ''}`),
    createOem: (name: string) => post<NamedOption>('/oems', { name }),
    updateOem: (id: number, data: { name?: string; is_active?: boolean }) => put<NamedOption>(`/oems/${id}`, data),
    segments: (includeInactive = false) => request<NamedOption[]>(`/market-segments${includeInactive ? '?include_inactive=1' : ''}`),
    createSegment: (name: string) => post<NamedOption>('/market-segments', { name }),
    updateSegment: (id: number, data: { name?: string; is_active?: boolean }) => put<NamedOption>(`/market-segments/${id}`, data),
  },
  analysis: {
    funnel: (params: { days?: number; salesperson_id?: number | ''; oem_id?: number | '' }) => request<Funnel>(`/analysis/funnel${qs(params)}`),
    forecast: (params: { salesperson_id?: number | ''; oem_id?: number | '' }) => request<Forecast>(`/analysis/forecast${qs(params)}`),
    stageSettings: () => request<StageSetting[]>('/analysis/stage-settings'),
    updateStageSetting: (stage: Stage, stuck_after_days: number) => put<StageSetting>(`/analysis/stage-settings/${stage}`, { stuck_after_days }),
  },
  tenders: {
    list: (view: 'open' | 'submitted' | 'emd' | 'all') => request<TenderRow[]>(`/tenders${qs({ view })}`),
    save: (opportunityId: number, data: TenderInput) => put<TenderRow>(`/tenders/deal/${opportunityId}`, data),
  },
  installed: {
    forCompany: (companyId: number) => request<Instrument[]>(`/installed-base${qs({ company_id: companyId })}`),
    renewals: () => request<Renewal[]>('/installed-base/renewals'),
    create: (data: InstrumentInput & { company_id: number; salesperson_id?: number | null; opportunity_id?: number | null }) => post<Instrument>('/installed-base', data),
    update: (id: number, data: Partial<InstrumentInput>) => put<Instrument>(`/installed-base/${id}`, data),
    retire: (id: number, reason: string) => post<Instrument>(`/installed-base/${id}/retire`, { reason }),
  },
  reorders: {
    list: (companyId?: number) => request<ReorderPlan[]>(`/reorders${qs({ company_id: companyId })}`),
    create: (data: ReorderInput & { company_id: number; salesperson_id?: number | null }) => post<ReorderPlan>('/reorders', data),
    update: (id: number, data: { next_due_date?: string; interval_days?: number }) => put<ReorderPlan>(`/reorders/${id}`, data),
    ordered: (id: number, data: { ordered_on?: string; value?: number | null }) => post<ReorderPlan>(`/reorders/${id}/ordered`, data),
    stop: (id: number, reason: string) => post<{ ok: true }>(`/reorders/${id}/stop`, { reason }),
  },
  reports: {
    list: () => request<{ email_configured: boolean; reports: ReportSummary[] }>('/reports'),
    get: (id: number) => request<WeeklyReport>(`/reports/${id}`),
    generate: () => post<{ created: boolean; id?: number }>('/reports/generate'),
    email: (id: number) => post<{ sent: number }>(`/reports/${id}/email`),
    recipients: () => request<ReportRecipient[]>('/reports/recipients'),
    addRecipient: (email: string) => post<ReportRecipient>('/reports/recipients', { email }),
    updateRecipient: (id: number, is_active: boolean) => put<ReportRecipient>(`/reports/recipients/${id}`, { is_active }),
  },
  erp: {
    status: () => request<ErpStatus>('/admin/erp'),
    run: () => post<unknown>('/admin/erp/run'),
    customers: () => request<ErpCustomer[]>('/admin/erp/customers'),
    link: (id: number, company_id: number) => post<unknown>(`/admin/erp/customers/${id}/link`, { company_id }),
    add: (id: number) => post<unknown>(`/admin/erp/customers/${id}/add`),
    ignore: (id: number) => post<unknown>(`/admin/erp/customers/${id}/ignore`),
  },
  imports: {
    preview: (kind: ImportKind, file: File) => upload<ImportResult>(`/admin/import/${kind}/preview`, file),
    commit: (kind: ImportKind, file: File) => upload<ImportResult & { imported: number }>(`/admin/import/${kind}/commit${qs({ name: file.name })}`, file),
  },
  notifications: {
    list: () => request<NotificationList>('/notifications'),
    readAll: () => post<{ ok: true }>('/notifications/read-all'),
    subscribe: (subscription: PushSubscriptionJSON) => post<{ ok: true }>('/notifications/push/subscribe', subscription),
    unsubscribe: (endpoint: string) => post<{ ok: true }>('/notifications/push/unsubscribe', { endpoint }),
  },
  performance: (params: { days?: number; from?: string; to?: string; salesperson_id?: number | '' } = {}) =>
    request<Performance>(`/performance${qs(params)}`),
  team: {
    performance: (days: number) => request<TeamPerformance>(`/team/performance${qs({ days })}`),
    insights: (days: number) => request<TeamInsights>(`/team/insights${qs({ days })}`),
  },
  handover: {
    preview: (fromId: number) => request<HandoverPreview>(`/handover/preview${qs({ from_salesperson_id: fromId })}`),
    run: (data: { from_salesperson_id: number; to_salesperson_id: number; reason: string; opportunity_ids?: number[]; include_loose_tasks?: boolean }) =>
      post<{ from: string; to: string; deals_moved: number; follow_ups_moved: number; instruments_moved: number; reorders_moved: number }>('/handover', data),
    transferDeal: (id: number, to_salesperson_id: number, reason: string) =>
      post<Opportunity>(`/opportunities/${id}/owner`, { to_salesperson_id, reason }),
  },
};

export interface StageSetting {
  stage: Stage;
  stuck_after_days: number;
}

export interface Funnel {
  days: number;
  today: string;
  total: number;
  lost_or_abandoned: number;
  stages: { stage: Stage; reached: number; reached_value: number; open_now: number; dropped: number; to_next_pct: number | null; avg_days: number | null }[];
  open_by_stage: { stage: Stage; deals: number; value: number }[];
}

export interface ForecastBucket {
  commit: number;
  best_case: number;
  pipeline: number;
  total: number;
  weighted: number;
  count: number;
  deals: { id: number; title: string; stage: Stage; estimated_value: number | null; probability: number; expected_close_date: string | null; company_name: string; owner_name: string }[];
}

export interface Forecast {
  today: string;
  months: (ForecastBucket & { month: string; won_value: number; won_deals: number })[];
  overdue: ForecastBucket;
  later: ForecastBucket;
  no_date: ForecastBucket;
  by_salesperson: (Omit<ForecastBucket, 'deals'> & { salesperson_id: number; name: string })[];
}

const tomorrowIst = () => new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export interface BulkResult {
  updated: number;
  skipped: { id: number; title: string; reason: string }[];
}

export interface ContactLogEntry {
  id: number;
  channel: 'call' | 'whatsapp';
  result: 'reached' | 'no_answer';
  contact_name: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
  salesperson_name: string;
}

export interface ReportSummary {
  id: number;
  week_start: string;
  week_end: string;
  emailed_at: string | null;
  email_error: string | null;
  created_at: string;
}

export interface ReportRecipient {
  id: number;
  email: string;
  name: string | null;
  is_active: boolean;
}

export interface WeeklyReport extends ReportSummary {
  data: {
    totals: Performance;
    previous: Performance;
    salespeople: { id: number; name: string; visits: number; deals_won: number; won_value: number; open_deals: number; pipeline_value: number; overdue_deals: number; stuck_deals: number; overdue_follow_ups: number }[];
    wins: { id: number; title: string; company_name: string; owner_name: string; value: number }[];
    closing: { id: number; title: string; company_name: string; owner_name: string; value: number; probability: number; date: string }[];
    at_risk: { id: number; title: string; company_name: string; owner_name: string; value: number; date: string; is_overdue: boolean; is_stuck: boolean; days_in_stage: number }[];
    tenders: { id: number; title: string; tender_number: string; company_name: string; owner_name: string; date: string }[];
    forecast_this_month: { commit: number; best_case: number; pipeline: number };
    companies_pending: number;
    emd_to_recover: number;
    renewals_30_days: number;
  };
}

export interface ErpStatus {
  problem: string | null;
  totals: { customers: number; linked: number; quotations: number; orders: number; products: number };
  runs: { id: number; started_at: string; status: string; counts: { unknown_makes?: string[]; quotations_mismatched?: number }; errors: { part: string; message: string }[] }[];
}

export interface ErpCustomer {
  id: number;
  name: string;
  state: string | null;
  gstin: string | null;
  phone: string | null;
  suggestions: { id: number; name: string; city: string | null }[];
}

export interface ErpQuotation {
  id: number;
  number: string;
  quote_date: string | null;
  status: string | null;
  total: number | null;
}

export type EmdStatus = 'not_required' | 'pending' | 'paid' | 'refunded' | 'forfeited';
export type BidStatus = 'preparing' | 'submitted' | 'won' | 'lost' | 'cancelled';

export interface TenderInput {
  tender_number: string;
  issuing_authority: string | null;
  bid_due_date: string;
  pre_bid_date: string | null;
  emd_amount: number | null;
  emd_status: EmdStatus;
  bid_status: BidStatus;
  document_url: string | null;
  notes: string | null;
}

export interface TenderDetails extends TenderInput {
  days_left: number;
  is_late: boolean;
}

export interface TenderRow extends TenderDetails {
  opportunity_id: number;
  deal_title: string;
  stage: Stage;
  estimated_value: number | null;
  company_id: number;
  company_name: string;
  owner_name: string;
  emd_to_recover: boolean;
}

export interface InstrumentInput {
  description: string;
  product_id: number | null;
  serial_number: string | null;
  contact_id: number | null;
  installed_on: string | null;
  warranty_end_date: string | null;
  amc_end_date: string | null;
  notes: string | null;
}

export interface Instrument extends InstrumentInput {
  id: number;
  company_id: number;
  company_name: string;
  product_name: string | null;
  part_number: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  salesperson_id: number;
  salesperson_name: string;
  is_active: boolean;
}

export interface Renewal {
  id: number;
  company_id: number;
  company_name: string;
  description: string;
  serial_number: string | null;
  salesperson_id: number;
  salesperson_name: string;
  salesperson_is_active: boolean;
  contact_name: string | null;
  contact_phone: string | null;
  kind: 'warranty' | 'amc';
  end_date: string;
  days_left: number;
}

export interface ReorderInput {
  item: string;
  product_id: number | null;
  contact_id: number | null;
  interval_days: number;
  last_order_date: string | null;
  typical_value: number | null;
}

export interface ReorderPlan extends ReorderInput {
  id: number;
  company_id: number;
  company_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  salesperson_id: number;
  salesperson_name: string;
  salesperson_is_active: boolean;
  next_due_date: string;
  days_left: number;
}

export type ImportKind = 'companies' | 'contacts' | 'deals';

export interface ImportResult {
  summary: { total: number; new: number; skip: number; error: number; warnings: number };
  rows: { row: number; label: string; status: 'new' | 'skip' | 'error'; errors: string[]; warnings: string[] }[];
  rows_hidden: number;
}

export interface NotificationList {
  items: { id: number; title: string; body: string; url: string; read_at: string | null; created_at: string }[];
  unread: number;
  push_public_key: string | null;
}

export interface VisitCompletion {
  outcome: Outcome;
  notes?: string | null;
  requirements: RequirementInput[];
  follow_up?: TaskInput | null;
  opportunity?: { id: number } | DealInput | null;
}

// ---------- Team & handover ----------

export interface TeamPerformance {
  from: string;
  to: string;
  totals: Performance;
  salespeople: { id: number; name: string; employee_code: string; is_active: boolean; metrics: Performance }[];
}

export interface TeamInsights {
  from: string;
  to: string;
  won_by_month: { month: string; deals_won: number; won_value: number }[];
  by_category: { category: string; deals_won: number; won_value: number; open_deals: number; pipeline_value: number }[];
  by_city: { city: string; deals_won: number; won_value: number; open_deals: number; pipeline_value: number }[];
  by_oem: { oem: string; deals_won: number; won_value: number; open_deals: number; pipeline_value: number }[];
  by_segment: { segment: string; deals_won: number; won_value: number; open_deals: number; pipeline_value: number }[];
  stale_deals: { id: number; title: string; stage: Stage; estimated_value: number | null; company_name: string; owner_name: string; idle_days: number }[];
  stale_after_days: number;
  orphaned: { salesperson_id: number; name: string; open_deals: number }[];
}

export interface HandoverPreview {
  salesperson: { id: number; name: string; is_active: boolean; username: string | null; user_is_active: boolean | null };
  deals: { id: number; title: string; stage: Stage; estimated_value: number | null; expected_close_date: string | null; company_name: string; open_tasks: number; is_overdue: boolean | null; is_stuck: boolean }[];
  loose_tasks: number;
  draft_visits: number;
  instruments: number;
  reorders: number;
}

// ---------- Pipeline ----------

export type Stage =
  | 'new_prospect'
  | 'visit_completed'
  | 'qualified'
  | 'quotation_requested'
  | 'quotation_sent'
  | 'negotiation'
  | 'won'
  | 'lost'
  | 'abandoned';
export type LostReason = 'price' | 'competitor' | 'no_budget' | 'no_requirement' | 'timing' | 'product_fit' | 'no_response' | 'other';
export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'rejected';

export interface Opportunity {
  id: number;
  company_id: number;
  company_name: string;
  company_city: string | null;
  title: string;
  owner_salesperson_id: number;
  owner_name: string;
  original_owner_salesperson_id: number;
  original_owner_name: string;
  stage: Stage;
  estimated_value: number | null;
  probability: number;
  probability_reason: string | null;
  tender: boolean;
  oem_id: number | null;
  oem_name: string | null;
  contact_id: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  products: { id: number; part_number: string; name: string; is_active: boolean }[];
  segments: { id: number; name: string; is_active: boolean }[];
  is_overdue: boolean;
  is_stuck: boolean;
  days_in_stage: number | null;
  stuck_after_days: number | null;
  expected_close_date: string | null;
  source_visit_id: number | null;
  notes: string | null;
  won_value: number | null;
  lost_reason: LostReason | null;
  close_reason: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  quotation_count: number;
}

export interface DealFilters {
  status?: 'open' | 'won' | 'lost' | 'abandoned' | 'closed' | 'all';
  stage?: string;
  company_id?: number;
  owner_id?: number | '';
  oem_id?: number | '';
  segment_id?: number | '';
  overdue?: 1 | '';
  stuck?: 1 | '';
}

export interface DealInput {
  title: string;
  oem_id: number;
  product_ids: number[];
  expected_close_date: string;
  estimated_value: number;
  probability: number;
  probability_reason: string | null;
  tender: boolean;
  segment_ids: number[];
  notes: string | null;
  contact_id: number | null;
  new_contact?: { phone: string; name: string; designation?: string; department?: string; email?: string };
}

export interface NamedOption {
  id: number;
  name: string;
  is_active: boolean;
  in_use: number;
}

export interface Product {
  id: number;
  part_number: string;
  name: string;
  oem_id: number;
  oem_name: string;
  category: string | null;
  key_features: string[];
  is_active: boolean;
}

export type ProductInput = Pick<Product, 'part_number' | 'name' | 'oem_id' | 'category' | 'key_features'>;

export interface QuotationLink {
  id: number;
  quotation_number: string;
  quotation_date: string | null;
  amount: number | null;
  status: QuotationStatus;
  document_url: string | null;
  source: 'manual' | 'erp';
  created_at: string;
}

export interface QuotationInput {
  quotation_number: string;
  quotation_date?: string | null;
  amount?: number | null;
  status?: QuotationStatus;
  document_url?: string | null;
  erp_quotation_id?: number;
}

export interface OpportunityDetail extends Opportunity {
  erp_orders: { id: number; number: string; order_date: string | null; client_po_ref: string | null; status: string | null; quotation_number: string }[];
  contact_log: ContactLogEntry[];
  tender_details: TenderDetails | null;
  history: { id: number; change_type: 'created' | 'stage' | 'owner' | 'field'; field: string | null; from_value: string | null; to_value: string; note: string | null; changed_at: string; changed_by_username: string }[];
  quotations: QuotationLink[];
  requirements: Requirement[];
  tasks: { id: number; title: string; task_type: TaskType; due_date: string; status: string; priority: string; assignee_name: string }[];
  visits: { id: number; visited_at: string; status: string; outcome: Outcome | null; salesperson_name: string }[];
}

export interface Performance {
  from: string;
  to: string;
  visits: number;
  companies_visited: number;
  new_prospects: number;
  deals_opened: number;
  quotation_requests: number;
  quotations_sent: number;
  deals_won: number;
  won_value: number;
  deals_lost: number;
  deals_abandoned: number;
  win_rate: number | null;
  avg_days_to_win: number | null;
  lost_reasons: { reason: LostReason; count: number }[];
  open_deals: number;
  overdue_deals: number;
  stuck_deals: number;
  pipeline_value: number;
  weighted_pipeline: number;
  overdue_follow_ups: number;
}

function qs(params: Record<string, string | number | undefined | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return q.size ? `?${q}` : '';
}

// ---------- Field CRM ----------

export interface CompanySummary {
  id: number;
  name: string;
  city: string | null;
  state?: string | null;
  phone: string | null;
  approval_status: ApprovalStatus;
  rejection_reason?: string | null;
  parent_company_id?: number | null;
  parent_name?: string | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface PendingCompany extends CompanySummary {
  category: string | null;
  contact_person: string | null;
  address: string | null;
  created_at: string;
  created_by_username: string;
}

export interface DuplicateCandidate extends CompanySummary {
  score: number;
  exact: boolean;
  same_phone: boolean;
}

export interface Contact {
  id: number;
  name: string;
  designation: string | null;
  department?: string | null;
  phone: string | null;
  email: string | null;
}

export type ContactInput = { name: string; designation?: string | null; department?: string | null; phone?: string | null; email?: string | null };

export interface CompanyInput {
  name: string;
  pincode?: string | null;
  city?: string | null;
  state?: string | null;
  contact_person?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  gstin?: string | null;
  category?: string | null;
}

export type Outcome = 'interested' | 'follow_up_needed' | 'quotation_requested' | 'not_interested' | 'no_meeting';
export type TaskType = 'call' | 'visit' | 'demo' | 'technical_discussion' | 'send_quotation' | 'renewal' | 'reorder' | 'other';
export type Urgency = 'low' | 'normal' | 'high' | 'urgent';

export interface Requirement {
  id: number;
  product_category: string | null;
  description: string;
  specification: string | null;
  quantity: number | null;
  unit: string | null;
  budget: number | null;
  urgency: Urgency;
  purchase_timeline: string | null;
  decision_maker: string | null;
  created_at: string;
  salesperson_name?: string;
}

export interface RequirementInput {
  product_category?: string;
  description: string;
  specification?: string;
  quantity?: number | null;
  unit?: string;
  budget?: number | null;
  urgency?: Urgency;
  purchase_timeline?: string;
  decision_maker?: string;
}

export interface Task {
  id: number;
  company_id: number;
  company_name: string;
  company_city?: string | null;
  assignee_salesperson_id?: number;
  assignee_name: string;
  task_type: TaskType;
  title: string;
  due_date: string;
  priority: 'normal' | 'high';
  status?: 'open' | 'done' | 'cancelled';
  notes?: string | null;
  outcome_notes?: string | null;
  completed_at?: string | null;
  updated_at?: string;
  is_overdue: boolean;
  contact_name?: string | null;
  contact_phone?: string | null;
}

export interface TaskInput {
  task_type: TaskType;
  title: string;
  due_date: string;
  priority?: 'normal' | 'high';
  notes?: string;
}

export interface Visit {
  id: number;
  company_id: number;
  company_name: string;
  company_city: string | null;
  company_approval_status: ApprovalStatus;
  contact_id: number | null;
  contact_name: string | null;
  contact_designation: string | null;
  contact_phone: string | null;
  salesperson_id: number;
  salesperson_name: string;
  visited_at: string;
  status: 'draft' | 'completed';
  outcome: Outcome | null;
  notes: string | null;
  completed_at: string | null;
  opportunity_id: number | null;
  opportunity_title: string | null;
  opportunity_stage: Stage | null;
}

export interface VisitDetail extends Visit {
  requirements: Requirement[];
  tasks: { id: number; title: string; task_type: TaskType; due_date: string; status: string }[];
}

export interface CompanyDetail extends CompanySummary {
  address: string | null;
  pincode?: string | null;
  email: string | null;
  gstin: string | null;
  category: string | null;
  contact_person: string | null;
  approved_by_username: string | null;
  approved_at: string | null;
  contact_log: ContactLogEntry[];
  parent: { id: number; name: string; city: string | null } | null;
  branches: { id: number; name: string; city: string | null; approval_status: ApprovalStatus; open_deals: number; pipeline_value: number }[];
  created_by_username: string;
  created_at: string;
  contacts: Contact[];
  visits: { id: number; visited_at: string; status: 'draft' | 'completed'; outcome: Outcome | null; notes: string | null; salesperson_name: string; contact_name: string | null }[];
  tasks: { id: number; title: string; task_type: TaskType; due_date: string; priority: string; assignee_name: string }[];
  requirements: Requirement[];
  opportunities: {
    id: number;
    title: string;
    stage: Stage;
    estimated_value: number | null;
    won_value: number | null;
    expected_close_date: string | null;
    closed_at: string | null;
    owner_name: string;
    is_overdue: boolean | null;
  }[];
}

export interface TodayData {
  today: string;
  overdue: Task[];
  overdue_deals: { id: number; title: string; stage: Stage; estimated_value: number | null; expected_close_date: string; company_name: string; owner_name: string }[];
  erp_orders: { id: number; title: string; company_name: string; owner_name: string; order_number: string; client_po_ref: string | null }[];
  tenders_due: { opportunity_id: number; tender_number: string; bid_due_date: string; days_left: number; title: string; company_name: string; owner_name: string }[];
  stuck_deals: { id: number; title: string; stage: Stage; estimated_value: number | null; company_name: string; owner_name: string; days_in_stage: number; stuck_after_days: number }[];
  due_today: Task[];
  upcoming: Task[];
  draft_visits: { id: number; local_uuid?: string; visited_at: string; company_id: number; company_name: string; salesperson_name: string }[];
  recent_visits: { id: number; visited_at: string; outcome: Outcome; company_id: number; company_name: string; salesperson_name: string }[];
  stats: { visits_this_week: number; companies_visited_30d: number; quotation_requests_30d: number; overdue_follow_ups: number };
}

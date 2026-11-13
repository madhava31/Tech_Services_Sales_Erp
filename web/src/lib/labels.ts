import type { BidStatus, Competitor, EmdStatus, LostReason, Outcome, QuotationStatus, Stage, TaskType, Urgency } from './api';

export const STAGE_LABELS: Record<Stage, string> = {
  create: 'Create',
  qualify: 'Qualify',
  develop: 'Develop',
  prove: 'Prove',
  negotiation: 'Negotiation',
  won: 'Won',
  lost: 'Lost',
};

export const OPEN_STAGES: Stage[] = ['create', 'qualify', 'develop', 'prove', 'negotiation'];

export const CLOSED_STAGES: Stage[] = ['won', 'lost'];

// Stages that need the quotation number.
export const QUOTED_STAGES: Stage[] = ['prove', 'negotiation'];

export const COMPETITOR_LABELS: Record<Competitor, string> = {
  no_idea: 'No idea',
  no_competitor: 'No competitor',
  other: 'Other',
};

export function competitorText(competitor: Competitor | null, note: string | null) {
  if (!competitor) return null;
  return competitor === 'other' ? note : COMPETITOR_LABELS[competitor];
}

export const LOST_REASON_LABELS: Record<LostReason, string> = {
  price: 'Price too high',
  competitor: 'Went with a competitor',
  no_budget: 'No budget',
  no_requirement: 'Need went away',
  timing: 'Not now / timing',
  product_fit: "Our product didn't fit",
  no_response: 'Customer stopped responding',
  other: 'Other',
};

export const QUOTATION_STATUS_LABELS: Record<QuotationStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

// ₹ with Indian grouping; large amounts as lakhs/crores ("₹4.5 L", "₹1.2 Cr") when compact.
export function formatMoney(value: number | null | undefined, { compact = false } = {}) {
  if (value === null || value === undefined) return '—';
  if (compact && value >= 1e7) return `₹${(value / 1e7).toFixed(value >= 1e8 ? 0 : 1)} Cr`;
  if (compact && value >= 1e5) return `₹${(value / 1e5).toFixed(value >= 1e6 ? 0 : 1)} L`;
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

// Digits as they are typed into an amount field: 6850000 → 68,50,000.
export function formatIndianDigits(digits: string) {
  return digits === '' ? '' : Number(digits).toLocaleString('en-IN');
}

export const BID_STATUS_LABELS: Record<BidStatus, string> = {
  preparing: 'Preparing',
  submitted: 'Submitted',
  won: 'Bid won',
  lost: 'Bid lost',
  cancelled: 'Cancelled',
};

export const EMD_STATUS_LABELS: Record<EmdStatus, string> = {
  not_required: 'Not required',
  pending: 'To be paid',
  paid: 'Paid',
  refunded: 'Refunded',
  forfeited: 'Forfeited',
};

// "in 3 days", "today", "2 days late", for deadlines.
export function daysLabel(days: number, past = 'late') {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 0) return `In ${days} days`;
  return `${-days} day${days === -1 ? '' : 's'} ${past}`;
}

// A WhatsApp chat with this number, opening the phone's own app. Ten-digit numbers are taken as Indian.
export function whatsappLink(phone: string, text: string) {
  const digits = phone.replace(/\D/g, '').replace(/^0+/, '');
  return `https://wa.me/${digits.length === 10 ? `91${digits}` : digits}?text=${encodeURIComponent(text)}`;
}

// A starting point: the person can change it in WhatsApp before sending.
export function whatsappMessage(task: { task_type: TaskType; company_name: string; contact_name?: string | null; assignee_name: string }) {
  const hello = task.contact_name ? `Hello ${task.contact_name}` : 'Hello';
  const body: Partial<Record<TaskType, string>> = {
    send_quotation: `I'm following up on the quotation for ${task.company_name}. Could we discuss it when convenient?`,
    renewal: `Your instrument's warranty or AMC at ${task.company_name} is coming up for renewal. Could we discuss renewing it?`,
    reorder: `It may be time to reorder your consumables at ${task.company_name}. Shall I arrange a quotation?`,
    demo: `I'd like to arrange a product demo at ${task.company_name}. What day suits you?`,
    visit: `I'd like to visit you at ${task.company_name}. What day suits you?`,
  };
  return `${hello}, this is ${task.assignee_name} from Technicon Services. ${body[task.task_type] ?? `I'm following up about ${task.company_name}. Is this a good time to talk?`}`;
}

export const OUTCOME_LABELS: Record<Outcome, string> = {
  interested: 'Interested',
  follow_up_needed: 'Needs follow-up',
  quotation_requested: 'Wants a quotation',
  not_interested: 'Not interested',
  no_meeting: "Couldn't meet",
};

export const OUTCOME_HELP: Record<Outcome, string> = {
  interested: 'Has a real need — capture it',
  follow_up_needed: 'Promising, needs another conversation',
  quotation_requested: 'Asked us for a price',
  not_interested: 'No need right now',
  no_meeting: 'Contact unavailable — try again',
};

// Mirrors the API rules in api/routes/visits.js.
export const OUTCOME_NEEDS_REQUIREMENT: Outcome[] = ['interested', 'follow_up_needed', 'quotation_requested'];
export const OUTCOME_NEEDS_FOLLOW_UP: Outcome[] = ['interested', 'follow_up_needed', 'quotation_requested', 'no_meeting'];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  call: 'Call',
  visit: 'Opportunity',
  demo: 'Product demo',
  technical_discussion: 'Technical discussion',
  send_quotation: 'Send quotation',
  renewal: 'Renewal',
  reorder: 'Reorder call',
  other: 'Other',
};

export const URGENCY_LABELS: Record<Urgency, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

// YYYY-MM-DD for today (+ offset) in the device's time zone.
export function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDate(value: string) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(value: string) {
  return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function dueLabel(dueDate: string, today = localDate()) {
  if (dueDate === today) return 'Today';
  const days = Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return `${-days} days overdue`;
  if (days < 7) return new Date(`${dueDate}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long' });
  return formatDate(dueDate);
}

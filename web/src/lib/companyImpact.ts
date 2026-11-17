export interface CompanyImpact {
  open_deals: number;
  closed_deals: number;
  visits: number;
  contacts: number;
  open_tasks: number;
  branches: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// What is attached to a company, for whoever decides on deleting it.
export function impactText(impact: CompanyImpact): string {
  const parts = [
    impact.open_deals > 0 && plural(impact.open_deals, 'open deal'),
    impact.closed_deals > 0 && plural(impact.closed_deals, 'closed deal'),
    impact.visits > 0 && plural(impact.visits, 'visit'),
    impact.contacts > 0 && plural(impact.contacts, 'contact'),
    impact.open_tasks > 0 && plural(impact.open_tasks, 'open follow-up'),
  ].filter(Boolean);
  return parts.length ? `It has ${parts.join(', ')}.` : 'It has no deals, visits or contacts.';
}

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SelectField } from './ui';

// Managers, office staff and admins open opportunities for a salesperson: this chooses whose it is
// (it decides the ID, TS-<their letters>-0001). A salesperson's own opportunities are always theirs,
// so they never see it.
export function useOwnerChoice() {
  const { user } = useAuth();
  // An admin's opportunities belong to the company (Technicon Services), so an admin is not asked.
  const chooses = Boolean(user && user.role !== 'salesperson' && user.role !== 'admin');
  const [ownerId, setOwnerId] = useState<number | ''>(user?.salesperson_id ?? '');
  return { chooses, ownerId, setOwnerId, ready: !chooses || ownerId !== '' };
}

export default function OwnerField({ value, onChange }: { value: number | ''; onChange: (id: number | '') => void }) {
  const [people, setPeople] = useState<{ id: number; name: string; employee_code: string }[]>([]);
  useEffect(() => {
    api.directory.salespeople().then(setPeople).catch(() => setPeople([]));
  }, []);
  return (
    <SelectField label="Salesperson" value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} hint="Whose opportunity this is." required>
      <option value="">Select…</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </SelectField>
  );
}

// Shown to an admin instead of the choice: what they open is the company's.
export function CompanyOwnerNote() {
  const { user } = useAuth();
  if (user?.role !== 'admin') return null;
  return (
    <p className="ts-box text-[13.5px] m-0">
      Opened by an admin, so this belongs to <b>Technicon Services</b> (the company), not a salesperson. It can be handed to a salesperson later.
    </p>
  );
}

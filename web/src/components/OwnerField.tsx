import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { SelectField } from './ui';

// Managers, office staff and admins open opportunities for a salesperson: this chooses whose it is
// (it decides the ID, TS-<their letters>-0001). A salesperson's own opportunities are always theirs,
// so they never see it.
export function useOwnerChoice() {
  const { user } = useAuth();
  const chooses = Boolean(user && user.role !== 'salesperson');
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

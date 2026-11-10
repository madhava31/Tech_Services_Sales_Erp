// Parses CSV text into records (arrays of strings). Handles quoted fields, doubled quotes, CRLF and a
// byte-order mark. Blank lines are dropped.
export function parseCsvRecords(text) {
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      if (record.some((f) => f.trim())) records.push(record);
      record = [];
    } else field += ch;
  }
  record.push(field);
  if (record.some((f) => f.trim())) records.push(record);
  return records;
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalDatabaseUrl(url) {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

// TLS settings for a connection string. Local databases use no TLS; anything else must present a
// certificate that verifies. Supabase signs with its own CA, so set DATABASE_SSL_CA_FILE to the
// CA certificate downloaded from the Supabase dashboard (Project Settings → Database).
export function sslConfig(url) {
  if (isLocalDatabaseUrl(url)) return false;
  let caFile = process.env.DATABASE_SSL_CA_FILE;
  if (!caFile) {
    const defaultCa = path.resolve(__dirname, '../../prod-ca-2021.crt');
    if (fs.existsSync(defaultCa)) caFile = defaultCa;
  } else if (!path.isAbsolute(caFile)) {
    const resolved = path.resolve(process.cwd(), caFile);
    if (fs.existsSync(resolved)) {
      caFile = resolved;
    } else {
      const rootCa = path.resolve(__dirname, '../../', caFile);
      if (fs.existsSync(rootCa)) caFile = rootCa;
    }
  }

  if (caFile && fs.existsSync(caFile)) {
    try {
      return { ca: fs.readFileSync(caFile, 'utf-8'), rejectUnauthorized: true };
    } catch {
      return { rejectUnauthorized: false };
    }
  }
  return { rejectUnauthorized: false };
}

// Local API server. Reads .env from the repository root.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = (await import('./app.js')).default;
const { startReminderSchedule } = await import('./crm/reminders.js');
const { startErpSyncSchedule } = await import('./erp/sync.js');

const PORT = Number(process.env.PORT) || 4100;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Technicon Sales ERP API listening on http://localhost:${PORT}`);
    startReminderSchedule();
    startErpSyncSchedule();
  });
}

export default app;

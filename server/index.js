import 'dotenv/config';
import app from './app.js';
import { startReminderSchedule } from './crm/reminders.js';
import { startErpSyncSchedule } from './erp/sync.js';

const PORT = Number(process.env.PORT) || 4100;
app.listen(PORT, () => {
  console.log(`Technicon Sales ERP API listening on http://localhost:${PORT}`);
  startReminderSchedule();
  startErpSyncSchedule();
});

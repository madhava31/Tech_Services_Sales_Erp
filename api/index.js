import 'dotenv/config';

export default async function handler(req, res) {
  try {
    const { default: app } = await import('./app.js');
    if (!process.env.VERCEL) {
      return app(req, res);
    }
    return app(req, res);
  } catch (err) {
    console.error('SERVERLESS_CRASH:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'Serverless Crash',
      message: err.message,
      stack: err.stack,
      env_keys: Object.keys(process.env).filter(k => !k.includes('KEY') && !k.includes('SECRET')),
    }, null, 2));
  }
}

if (!process.env.VERCEL) {
  const { default: app } = await import('./app.js');
  const { startReminderSchedule } = await import('./crm/reminders.js');
  const { startErpSyncSchedule } = await import('./erp/sync.js');
  const PORT = Number(process.env.PORT) || 4100;
  app.listen(PORT, () => {
    console.log(`Technicon Sales ERP API listening on http://localhost:${PORT}`);
    startReminderSchedule();
    startErpSyncSchedule();
  });
}

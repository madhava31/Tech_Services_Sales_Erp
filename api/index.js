import 'dotenv/config';

export default async function handler(req, res) {
  try {
    const { default: app } = await import('../server/app.js');
    return app(req, res);
  } catch (err) {
    console.error('SERVERLESS_CRASH:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'Serverless Crash',
      message: err.message,
      stack: err.stack,
    }, null, 2));
  }
}

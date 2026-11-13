import 'dotenv/config';

export default async function handler(req, res) {
  try {
    const { default: app } = await import('../server/app.js');
    return app(req, res);
  } catch (err) {
    // The details go to the server log (Vercel → Logs); the person who hit it sees a plain message.
    console.error('SERVERLESS_CRASH:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Something went wrong. Please try again.' }));
  }
}

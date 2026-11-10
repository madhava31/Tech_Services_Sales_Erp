// Catch-all serverless function for /api/* on Vercel if root directory is web/
import 'dotenv/config';
import app from '../../api/app.js';

export default app;

import express, { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { HttpError, sendError } from '../crm/access.js';
import { TEMPLATES, checkFile, isImportKind, runImport, summarize } from '../crm/import.js';

// Mounted at /api/admin/import behind requireAuth + requireAdmin. The file is sent as the raw request
// body: first to /preview, which changes nothing, then to /commit, which checks it again and imports
// the valid rows in one transaction.
const router = Router();

const fileBody = express.raw({ type: () => true, limit: '6mb' });

function kindFrom(req) {
  if (!isImportKind(req.params.kind)) throw new HttpError(404, 'Not found');
  return req.params.kind;
}

function fileFrom(req) {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Choose a file to import.');
  return req.body;
}

const csvCell = (value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

router.get('/:kind/template', (req, res) => {
  try {
    const kind = kindFrom(req);
    const { headers, example } = TEMPLATES[kind];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="technicon-${kind}-template.csv"`);
    res.send(`﻿${headers.map(csvCell).join(',')}\r\n${example.map(csvCell).join(',')}\r\n`);
  } catch (err) {
    sendError(res, err);
  }
});

// Only rows that need attention go back: a clean 5,000-row file needs no list.
function previewOf(results) {
  const notable = results.filter((r) => r.errors.length || r.warnings.length);
  return {
    summary: summarize(results),
    rows: notable.slice(0, 300).map(({ row, label, status, errors, warnings }) => ({ row, label, status, errors, warnings })),
    rows_hidden: Math.max(0, notable.length - 300),
  };
}

router.post('/:kind/preview', fileBody, async (req, res) => {
  try {
    res.json(previewOf(await checkFile(kindFrom(req), fileFrom(req))));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:kind/commit', fileBody, async (req, res) => {
  try {
    const kind = kindFrom(req);
    const buffer = fileFrom(req);
    const result = await db.transaction(async () => {
      // Checked again inside the transaction, in case the data changed since the preview.
      const results = await checkFile(kind, buffer);
      const ids = await runImport(kind, results, req.user.id);
      const summary = summarize(results);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'import.completed',
        entityType: 'import',
        summary: `Imported ${ids.length} ${kind}: ${summary.skip} skipped, ${summary.error} with errors`,
        after: { kind, ids, summary, file: typeof req.query.name === 'string' ? req.query.name.slice(0, 200) : null },
      });
      return { imported: ids.length, ...previewOf(results) };
    });
    res.json(result);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Some of this data was added while the import ran. Check the file again.' });
    sendError(res, err);
  }
});

export default router;

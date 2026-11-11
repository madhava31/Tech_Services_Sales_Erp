import { Router } from 'express';
import db from '../db/index.js';
import { recordAudit } from '../audit/log.js';
import { isAdminRole } from '../auth/roles.js';
import { HttpError, sendError } from '../crm/access.js';
import { optionalId, optionalText, requiredText } from '../crm/fields.js';
import { erpAdapter } from '../erp/adapter.js';

// Mounted at /api/products, /api/oems and /api/market-segments. Everyone signed in can read the
// catalogue. Rows are never deleted: anything in use is deactivated with is_active.

// Admin/MD and office staff keep the product list; only Admin/MD manage OEMs and segments.
const PRODUCT_ROLES = ['admin', 'managing_director', 'office_staff'];

function requireProductRole(req, res, next) {
  if (!PRODUCT_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Products are managed by the office or an administrator.' });
  next();
}

function requireCatalogueAdmin(req, res, next) {
  if (!isAdminRole(req.user.role)) return res.status(403).json({ error: 'Only an administrator can change this list.' });
  next();
}

function optionalActive(body, fallback) {
  if (body.is_active === undefined) return fallback;
  if (typeof body.is_active !== 'boolean') throw new HttpError(400, 'is_active must be true or false');
  return body.is_active;
}

function keyFeatures(body) {
  const list = body.key_features ?? [];
  if (!Array.isArray(list) || list.some((f) => typeof f !== 'string')) throw new HttpError(400, 'key_features must be a list of text');
  if (list.length > 30) throw new HttpError(400, 'At most 30 key features');
  return list.map((f) => f.trim().slice(0, 300)).filter(Boolean);
}

export const productsRouter = Router();

productsRouter.get('/', async (req, res) => {
  try {
    const canManage = PRODUCT_ROLES.includes(req.user.role);
    res.json(
      await erpAdapter().listProducts({
        q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '',
        oemId: optionalId(req.query, 'oem_id'),
        includeInactive: canManage && req.query.include_inactive === '1',
        limit: Math.min(Math.max(Number(req.query.limit) || 200, 1), 500),
      })
    );
  } catch (err) {
    sendError(res, err);
  }
});

productsRouter.get('/:id', async (req, res) => {
  try {
    const product = await erpAdapter().getProduct(Number(req.params.id));
    if (!product) throw new HttpError(404, 'Product not found');
    res.json(product);
  } catch (err) {
    sendError(res, err);
  }
});

async function productFields(body) {
  const oemId = optionalId(body, 'oem_id');
  if (!oemId) throw new HttpError(400, 'Choose the make (OEM).');
  if (!(await db.prepare(`SELECT id FROM oem WHERE id = ?`).get(oemId))) throw new HttpError(400, 'That OEM was not found.');
  return {
    part_number: requiredText(body, 'part_number', { max: 60 }),
    name: requiredText(body, 'name', { max: 200 }),
    oem_id: oemId,
    category: optionalText(body, 'category', { max: 100 }),
    key_features: keyFeatures(body),
  };
}

productsRouter.post('/', requireProductRole, async (req, res) => {
  try {
    const fields = await productFields(req.body);
    const id = await db.transaction(async () => {
      const info = await db
        .prepare(`INSERT INTO product (part_number, name, oem_id, category, key_features, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
        .run(fields.part_number, fields.name, fields.oem_id, fields.category, fields.key_features, req.user.id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'product.created',
        entityType: 'product',
        entityId: info.lastInsertRowid,
        summary: `Added product ${fields.part_number} (${fields.name})`,
        after: fields,
      });
      return info.lastInsertRowid;
    });
    res.status(201).json(await erpAdapter().getProduct(id));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That part number already exists.' });
    sendError(res, err);
  }
});

productsRouter.put('/:id', requireProductRole, async (req, res) => {
  try {
    const existing = await erpAdapter().getProduct(Number(req.params.id));
    if (!existing) throw new HttpError(404, 'Product not found');
    const fields = await productFields({ ...existing, ...req.body });
    const isActive = optionalActive(req.body, existing.is_active);
    await db.transaction(async () => {
      await db
        .prepare(`UPDATE product SET part_number = ?, name = ?, oem_id = ?, category = ?, key_features = ?, is_active = ?, updated_at = NOW() WHERE id = ?`)
        .run(fields.part_number, fields.name, fields.oem_id, fields.category, fields.key_features, isActive, existing.id);
      const pick = ({ part_number, name, oem_id, category, key_features, is_active }) => ({ part_number, name, oem_id, category, key_features, is_active });
      await recordAudit({
        actorUserId: req.user.id,
        action: 'product.updated',
        entityType: 'product',
        entityId: existing.id,
        summary: `Updated product ${fields.part_number}${isActive !== existing.is_active ? (isActive ? ' (reactivated)' : ' (deactivated)') : ''}`,
        before: pick(existing),
        after: pick({ ...fields, is_active: isActive }),
      });
    });
    res.json(await erpAdapter().getProduct(existing.id));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That part number already exists.' });
    sendError(res, err);
  }
});

// OEMs and market segments are the same shape: a name and an active flag.
function nameListRouter({ table, entity, label, inUseSql, ordered = false }) {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const includeInactive = req.query.include_inactive === '1' && isAdminRole(req.user.role);
      res.json(
        await db
          .prepare(
            `SELECT t.id, t.name, t.is_active, (${inUseSql})::int AS in_use FROM ${table} t
             ${includeInactive ? '' : 'WHERE t.is_active'} ORDER BY ${ordered ? 't.sort_order, ' : ''}t.name`
          )
          .all()
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/', requireCatalogueAdmin, async (req, res) => {
    try {
      const name = requiredText(req.body, 'name', { max: 100 });
      const row = await db.transaction(async () => {
        const info = ordered
          ? await db.prepare(`INSERT INTO ${table} (name, sort_order) VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ${table})) RETURNING id`).run(name)
          : await db.prepare(`INSERT INTO ${table} (name) VALUES (?) RETURNING id`).run(name);
        await recordAudit({ actorUserId: req.user.id, action: `${entity}.created`, entityType: entity, entityId: info.lastInsertRowid, summary: `Added ${label} ${name}` });
        return db.prepare(`SELECT id, name, is_active FROM ${table} WHERE id = ?`).get(info.lastInsertRowid);
      });
      res.status(201).json(row);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: `That ${label} already exists.` });
      sendError(res, err);
    }
  });

  router.put('/:id', requireCatalogueAdmin, async (req, res) => {
    try {
      const existing = await db.prepare(`SELECT id, name, is_active FROM ${table} WHERE id = ?`).get(Number(req.params.id));
      if (!existing) throw new HttpError(404, `That ${label} was not found`);
      const name = req.body.name !== undefined ? requiredText(req.body, 'name', { max: 100 }) : existing.name;
      const isActive = optionalActive(req.body, existing.is_active);
      const row = await db.transaction(async () => {
        await db.prepare(`UPDATE ${table} SET name = ?, is_active = ?, updated_at = NOW() WHERE id = ?`).run(name, isActive, existing.id);
        await recordAudit({
          actorUserId: req.user.id,
          action: `${entity}.updated`,
          entityType: entity,
          entityId: existing.id,
          summary: `Updated ${label} ${name}${isActive !== existing.is_active ? (isActive ? ' (reactivated)' : ' (deactivated)') : ''}`,
          before: { name: existing.name, is_active: existing.is_active },
          after: { name, is_active: isActive },
        });
        return db.prepare(`SELECT id, name, is_active FROM ${table} WHERE id = ?`).get(existing.id);
      });
      res.json(row);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: `That ${label} already exists.` });
      sendError(res, err);
    }
  });

  return router;
}

export const oemsRouter = nameListRouter({
  table: 'oem',
  entity: 'oem',
  label: 'OEM',
  inUseSql: `(SELECT COUNT(*) FROM opportunity o WHERE o.oem_id = t.id) + (SELECT COUNT(*) FROM product p WHERE p.oem_id = t.id)`,
});

export const segmentsRouter = nameListRouter({
  table: 'market_segment',
  entity: 'market_segment',
  label: 'market segment',
  ordered: true,
  inUseSql: `SELECT COUNT(*) FROM opportunity_segment os WHERE os.segment_id = t.id`,
});

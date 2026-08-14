import { Router } from 'express'
import { protectRoute } from '../middleware/auth.js'
import { isAdminRole } from '../constants/roles.js'
import { BarcodePattern } from '../models/BarcodePattern.js'
import {
  applySegments,
  buildStructureKey,
  normalizeSegments,
  serializePattern,
} from '../services/barcodePattern.js'

const router = Router()

function normalizeBarcode(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * POST /api/barcode-patterns
 * Teach a layout: sample barcode + highlight segments → field assignments.
 * Body: { sampleBarcode, segments: [{ start, end, field }], name? }
 */
router.post('/', protectRoute, async (req, res, next) => {
  try {
    const sampleBarcode = normalizeBarcode(req.body?.sampleBarcode ?? req.body?.barcode)
    const name = normalizeText(req.body?.name)
    const normalized = normalizeSegments(sampleBarcode, req.body?.segments)
    if (!normalized.ok) return res.status(400).json({ error: normalized.error })

    const structureKey = buildStructureKey(sampleBarcode)
    const pattern = await BarcodePattern.create({
      name: name || undefined,
      sampleBarcode,
      structureKey,
      segments: normalized.segments,
      createdBy: req.user._id,
      updatedBy: req.user._id,
      isActive: true,
    })

    res.status(201).json({
      pattern: serializePattern(pattern.toObject()),
      extracted: applySegments(sampleBarcode, normalized.segments),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/barcode-patterns
 * List taught patterns. Query: q, activeOnly (default true), limit, page
 */
router.get('/', protectRoute, async (req, res, next) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN
    const rawPage = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : NaN
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 100)
    const page = Math.max(Number.isNaN(rawPage) ? 1 : rawPage, 1)
    const skip = (page - 1) * limit

    const filter = {}
    const activeOnly = String(req.query.activeOnly ?? 'true').toLowerCase() !== 'false'
    if (activeOnly) filter.isActive = true

    const qRaw = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (qRaw) {
      const esc = qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(esc, 'i')
      filter.$or = [{ name: re }, { sampleBarcode: re }, { structureKey: re }]
    }

    const [patterns, total] = await Promise.all([
      BarcodePattern.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      BarcodePattern.countDocuments(filter),
    ])

    res.json({
      patterns: patterns.map((p) => serializePattern(p)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/barcode-patterns/apply
 * Resolve fields for a barcode using the newest matching active pattern.
 * Body: { barcode }
 * Must be registered before /:id routes that could collide — "apply" is literal.
 */
router.post('/apply', protectRoute, async (req, res, next) => {
  try {
    const barcode = normalizeBarcode(req.body?.barcode)
    if (!barcode) return res.status(400).json({ error: 'barcode is required' })

    const structureKey = buildStructureKey(barcode)
    const pattern = await BarcodePattern.findOne({ structureKey, isActive: true })
      .sort({ updatedAt: -1 })
      .lean()

    if (!pattern) {
      return res.json({
        barcode,
        structureKey,
        matched: false,
        pattern: null,
        extracted: null,
      })
    }

    if (barcode.length !== pattern.sampleBarcode.length) {
      return res.json({
        barcode,
        structureKey,
        matched: false,
        pattern: serializePattern(pattern),
        extracted: null,
        reason: 'Barcode length differs from taught sample',
      })
    }

    const extracted = applySegments(barcode, pattern.segments)
    res.json({
      barcode,
      structureKey,
      matched: true,
      pattern: serializePattern(pattern),
      extracted,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/barcode-patterns/:id
 */
router.get('/:id', protectRoute, async (req, res, next) => {
  try {
    const pattern = await BarcodePattern.findById(req.params.id).lean()
    if (!pattern) return res.status(404).json({ error: 'Pattern not found' })
    res.json({ pattern: serializePattern(pattern) })
  } catch (err) {
    next(err)
  }
})

/**
 * PUT /api/barcode-patterns/:id
 * Update name, segments, and/or sample barcode.
 */
router.put('/:id', protectRoute, async (req, res, next) => {
  try {
    const pattern = await BarcodePattern.findById(req.params.id)
    if (!pattern) return res.status(404).json({ error: 'Pattern not found' })

    const body = req.body || {}
    if (typeof body.name === 'string') {
      pattern.name = normalizeText(body.name) || undefined
    }
    if (typeof body.isActive === 'boolean') {
      pattern.isActive = body.isActive
    }

    const nextSample =
      body.sampleBarcode != null || body.barcode != null
        ? normalizeBarcode(body.sampleBarcode ?? body.barcode)
        : pattern.sampleBarcode

    if (!nextSample) return res.status(400).json({ error: 'sampleBarcode cannot be empty' })

    if (Array.isArray(body.segments)) {
      const normalized = normalizeSegments(nextSample, body.segments)
      if (!normalized.ok) return res.status(400).json({ error: normalized.error })
      pattern.segments = normalized.segments
    } else if (nextSample !== pattern.sampleBarcode) {
      const normalized = normalizeSegments(nextSample, pattern.segments)
      if (!normalized.ok) return res.status(400).json({ error: normalized.error })
      pattern.segments = normalized.segments
    }

    pattern.sampleBarcode = nextSample
    pattern.structureKey = buildStructureKey(nextSample)
    pattern.updatedBy = req.user._id
    await pattern.save()

    res.json({
      pattern: serializePattern(pattern.toObject()),
      extracted: applySegments(nextSample, pattern.segments),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * DELETE /api/barcode-patterns/:id
 * Soft-deactivate by default; ?hard=true for admins hard-deletes.
 */
router.delete('/:id', protectRoute, async (req, res, next) => {
  try {
    const hard = String(req.query.hard || '').toLowerCase() === 'true'
    if (hard) {
      if (!isAdminRole(req.user.role)) {
        return res.status(403).json({ error: 'Hard delete requires admin' })
      }
      const deleted = await BarcodePattern.findByIdAndDelete(req.params.id).lean()
      if (!deleted) return res.status(404).json({ error: 'Pattern not found' })
      return res.json({ deleted: true, hard: true, _id: deleted._id })
    }

    const pattern = await BarcodePattern.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false, updatedBy: req.user._id } },
      { new: true }
    ).lean()
    if (!pattern) return res.status(404).json({ error: 'Pattern not found' })
    res.json({ deleted: true, hard: false, pattern: serializePattern(pattern) })
  } catch (err) {
    next(err)
  }
})

export { router as barcodePatternsRouter }

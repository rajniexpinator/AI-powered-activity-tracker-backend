import { Router } from 'express'
import mongoose from 'mongoose'
import { protectRoute } from '../middleware/auth.js'
import { BarcodeBulkLot } from '../models/BarcodeBulkLot.js'
import { BarcodeMapping } from '../models/BarcodeMapping.js'
import { BarcodePattern } from '../models/BarcodePattern.js'
import { applySegments, buildStructureKey } from '../services/barcodePattern.js'

const router = Router()

function normalizeBarcode(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

const MAX_SERIAL_LIST_SIZE = 20000

function serializeLot(lot, { includeItems = true, includeSerialLists = false } = {}) {
  if (!lot) return null
  const items = Array.isArray(lot.items) ? lot.items : []
  const goodSerials = Array.isArray(lot.goodSerials) ? lot.goodSerials : []
  const badSerials = Array.isArray(lot.badSerials) ? lot.badSerials : []
  const base = {
    _id: lot._id,
    name: lot.name,
    description: lot.description || '',
    status: lot.status || 'open',
    createdBy: lot.createdBy,
    itemCount: items.length,
    goodSerialCount: goodSerials.length,
    badSerialCount: badSerials.length,
    hasSerialLists: goodSerials.length > 0 || badSerials.length > 0,
    createdAt: lot.createdAt,
    updatedAt: lot.updatedAt,
  }
  if (includeSerialLists) {
    base.goodSerials = goodSerials
    base.badSerials = badSerials
  }
  if (includeItems) {
    base.items = items.map((item) => ({
      _id: item._id,
      barcode: item.barcode,
      scannedAt: item.scannedAt,
      scannedBy: item.scannedBy,
      partName: item.partName || '',
      partNumber: item.partNumber || '',
      customer: item.customer || '',
      supplier: item.supplier || '',
      serialNumber: item.serialNumber || '',
      serialStatus: item.serialStatus || null,
      notes: item.notes || '',
      patternId: item.patternId || null,
      mappingId: item.mappingId || null,
    }))
  }
  return base
}

/**
 * Parse serials from body: { serials: string[] } and/or { text|csv: string }.
 * Splits on newlines, commas, tabs, or semicolons. Dedupes (case-sensitive).
 */
function parseSerialListFromBody(body) {
  const collected = []
  if (Array.isArray(body?.serials)) {
    for (const value of body.serials) {
      if (typeof value === 'string' && value.trim()) collected.push(value.trim())
      else if (value != null && typeof value !== 'object') {
        const s = String(value).trim()
        if (s) collected.push(s)
      }
    }
  }
  const text =
    typeof body?.text === 'string'
      ? body.text
      : typeof body?.csv === 'string'
        ? body.csv
        : ''
  if (text) {
    for (const part of text.split(/[\n\r,;\t]+/)) {
      const s = part.trim()
      // Skip common CSV header labels
      if (!s) continue
      if (/^(serial|serial[_ ]?number|good|bad|status)$/i.test(s)) continue
      collected.push(s)
    }
  }
  const seen = new Set()
  const unique = []
  for (const s of collected) {
    if (seen.has(s)) continue
    seen.add(s)
    unique.push(s)
  }
  return unique
}

function resolveSerialListMode(body) {
  const raw = typeof body?.mode === 'string' ? body.mode.trim().toLowerCase() : 'replace'
  if (raw === 'append' || raw === 'replace') return raw
  return null
}

/**
 * Apply upload to goodSerials or badSerials.
 * mode replace (default) or append. Returns { list, added, total }.
 */
function applySerialListUpload(lot, listKey, serials, mode) {
  const existing = Array.isArray(lot[listKey]) ? lot[listKey] : []
  let next
  if (mode === 'append') {
    const seen = new Set(existing)
    next = [...existing]
    for (const s of serials) {
      if (seen.has(s)) continue
      seen.add(s)
      next.push(s)
    }
  } else {
    next = serials
  }
  if (next.length > MAX_SERIAL_LIST_SIZE) {
    return { error: `Maximum ${MAX_SERIAL_LIST_SIZE} serials per list` }
  }
  lot[listKey] = next
  const added = mode === 'append' ? next.length - existing.length : next.length
  return { list: next, added, total: next.length }
}

function buildSerialLookupSets(lot) {
  const goodSerials = Array.isArray(lot.goodSerials) ? lot.goodSerials : []
  const badSerials = Array.isArray(lot.badSerials) ? lot.badSerials : []
  return {
    goodSet: new Set(goodSerials),
    badSet: new Set(badSerials),
    hasLists: goodSerials.length > 0 || badSerials.length > 0,
  }
}

/**
 * Lookup value: prefer extracted/override serial; fall back to raw barcode.
 * Bad list wins if a serial appears on both lists.
 * Returns null when no lists are loaded (verification inactive).
 */
function resolveSerialStatus(lookupValue, goodSet, badSet, hasLists) {
  if (!hasLists) return null
  const key = typeof lookupValue === 'string' ? lookupValue.trim() : ''
  if (!key) return 'not_found'
  if (badSet.has(key)) return 'bad'
  if (goodSet.has(key)) return 'good'
  return 'not_found'
}

function serialStatusLabel(status) {
  if (status === 'good') return 'Good'
  if (status === 'bad') return 'Bad'
  if (status === 'not_found') return 'Not found'
  return ''
}

function csvEscape(value) {
  if (value === null || value === undefined) return '""'
  const s = String(value).replace(/"/g, '""')
  return `"${s}"`
}

/**
 * Resolve fields for a bulk scan from exact mapping + taught pattern.
 * Pattern fills gaps; exact mapping wins for overlapping keys.
 */
async function resolveScanFields(barcode) {
  const mapping = await BarcodeMapping.findOne({ barcode }).lean()
  const structureKey = buildStructureKey(barcode)
  let pattern = null
  let extracted = null

  if (barcode) {
    pattern = await BarcodePattern.findOne({ structureKey, isActive: true })
      .sort({ updatedAt: -1 })
      .lean()
    if (pattern && barcode.length === pattern.sampleBarcode.length) {
      extracted = applySegments(barcode, pattern.segments)
    } else {
      pattern = null
    }
  }

  const fields = {
    partName: '',
    partNumber: '',
    customer: '',
    supplier: '',
    serialNumber: '',
    notes: '',
  }

  if (extracted) {
    if (extracted.partName) fields.partName = extracted.partName
    if (extracted.partNumber) fields.partNumber = extracted.partNumber
    if (extracted.customer) fields.customer = extracted.customer
    if (extracted.supplier) fields.supplier = extracted.supplier
    if (extracted.serialNumber) fields.serialNumber = extracted.serialNumber
    if (extracted.notes) fields.notes = extracted.notes
  }

  if (mapping) {
    if (mapping.partName || mapping.productName) {
      fields.partName = mapping.partName || mapping.productName || fields.partName
    }
    if (mapping.partNumber) fields.partNumber = mapping.partNumber
    if (mapping.customer) fields.customer = mapping.customer
    if (mapping.serialNumber) fields.serialNumber = mapping.serialNumber
    if (mapping.metadata?.notes && !fields.notes) {
      fields.notes = String(mapping.metadata.notes)
    }
  }

  return {
    fields,
    mappingId: mapping?._id || null,
    patternId: pattern?._id || null,
    mapping,
    pattern,
    extracted,
  }
}

/**
 * POST /api/barcode-bulk
 * Create a named bulk sheet/lot.
 * Body: { name, description? }
 */
router.post('/', protectRoute, async (req, res, next) => {
  try {
    const name = normalizeText(req.body?.name)
    if (!name) return res.status(400).json({ error: 'name is required' })
    const description = normalizeText(req.body?.description)

    const lot = await BarcodeBulkLot.create({
      name,
      description: description || undefined,
      createdBy: req.user._id,
      status: 'open',
      items: [],
    })

    res.status(201).json({ lot: serializeLot(lot.toObject()) })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/barcode-bulk
 * List sheets. Query: q (name search), status (open|closed|all), limit, page
 */
router.get('/', protectRoute, async (req, res, next) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN
    const rawPage = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : NaN
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 100)
    const page = Math.max(Number.isNaN(rawPage) ? 1 : rawPage, 1)
    const skip = (page - 1) * limit

    const filter = {}
    const statusRaw = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : 'all'
    if (statusRaw === 'open' || statusRaw === 'closed') filter.status = statusRaw

    const qRaw = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (qRaw) {
      const esc = qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.name = new RegExp(esc, 'i')
    }

    const [lots, total] = await Promise.all([
      BarcodeBulkLot.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('createdBy', 'name email')
        .select({
          name: 1,
          description: 1,
          status: 1,
          createdBy: 1,
          createdAt: 1,
          updatedAt: 1,
          items: 1,
          goodSerials: 1,
          badSerials: 1,
        })
        .lean(),
      BarcodeBulkLot.countDocuments(filter),
    ])

    res.json({
      lots: lots.map((lot) => serializeLot(lot, { includeItems: false })),
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
 * GET /api/barcode-bulk/:id/export.csv
 * Spreadsheet export for one lot (registered before generic :id if needed — path is distinct).
 */
router.get('/:id/export.csv', protectRoute, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lot id' })
    }
    const lot = await BarcodeBulkLot.findById(req.params.id).lean()
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })

    const header = [
      'scanned_at',
      'barcode',
      'part_name',
      'part_number',
      'customer',
      'supplier',
      'serial_number',
      'notes',
      // Two new columns on the right (after existing bulk-scan fields)
      'serial_status',
      'lookup_serial',
    ]
    const rows = (lot.items || []).map((item) => {
      const serialNumber = item.serialNumber || ''
      const lookupSerial = serialNumber || item.barcode || ''
      return [
        item.scannedAt ? new Date(item.scannedAt).toISOString() : '',
        item.barcode || '',
        item.partName || '',
        item.partNumber || '',
        item.customer || '',
        item.supplier || '',
        serialNumber,
        item.notes || '',
        serialStatusLabel(item.serialStatus),
        item.serialStatus ? lookupSerial : '',
      ]
    })

    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n')
    const safeName = String(lot.name || 'bulk-lot')
      .replace(/[^a-zA-Z0-9-_]+/g, '_')
      .slice(0, 60)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-export.csv"`)
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

/**
 * PUT|POST /api/barcode-bulk/:id/serial-lists/good
 * Load / replace (default) or append good serials.
 * Body: { serials?: string[], text?: string, csv?: string, mode?: 'replace'|'append' }
 */
async function uploadGoodSerialList(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lot id' })
    }
    const lot = await BarcodeBulkLot.findById(req.params.id)
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })

    const mode = resolveSerialListMode(req.body)
    if (!mode) return res.status(400).json({ error: "mode must be 'replace' or 'append'" })

    const serials = parseSerialListFromBody(req.body || {})
    if (serials.length === 0) {
      return res.status(400).json({ error: 'Provide serials via serials[], text, or csv' })
    }

    const result = applySerialListUpload(lot, 'goodSerials', serials, mode)
    if (result.error) return res.status(400).json({ error: result.error })

    await lot.save()
    res.json({
      lot: serializeLot(lot.toObject(), { includeItems: false }),
      list: 'good',
      mode,
      added: result.added,
      total: result.total,
    })
  } catch (err) {
    next(err)
  }
}

router.put('/:id/serial-lists/good', protectRoute, uploadGoodSerialList)
router.post('/:id/serial-lists/good', protectRoute, uploadGoodSerialList)

/**
 * PUT|POST /api/barcode-bulk/:id/serial-lists/bad
 * Load / replace (default) or append bad serials.
 * Body: { serials?: string[], text?: string, csv?: string, mode?: 'replace'|'append' }
 */
async function uploadBadSerialList(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lot id' })
    }
    const lot = await BarcodeBulkLot.findById(req.params.id)
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })

    const mode = resolveSerialListMode(req.body)
    if (!mode) return res.status(400).json({ error: "mode must be 'replace' or 'append'" })

    const serials = parseSerialListFromBody(req.body || {})
    if (serials.length === 0) {
      return res.status(400).json({ error: 'Provide serials via serials[], text, or csv' })
    }

    const result = applySerialListUpload(lot, 'badSerials', serials, mode)
    if (result.error) return res.status(400).json({ error: result.error })

    await lot.save()
    res.json({
      lot: serializeLot(lot.toObject(), { includeItems: false }),
      list: 'bad',
      mode,
      added: result.added,
      total: result.total,
    })
  } catch (err) {
    next(err)
  }
}

router.put('/:id/serial-lists/bad', protectRoute, uploadBadSerialList)
router.post('/:id/serial-lists/bad', protectRoute, uploadBadSerialList)

/**
 * DELETE /api/barcode-bulk/:id/serial-lists/good
 * Clear the good serial list.
 */
router.delete('/:id/serial-lists/good', protectRoute, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lot id' })
    }
    const lot = await BarcodeBulkLot.findById(req.params.id)
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })

    lot.goodSerials = []
    await lot.save()
    res.json({
      lot: serializeLot(lot.toObject(), { includeItems: false }),
      list: 'good',
      cleared: true,
      total: 0,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * DELETE /api/barcode-bulk/:id/serial-lists/bad
 * Clear the bad serial list.
 */
router.delete('/:id/serial-lists/bad', protectRoute, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lot id' })
    }
    const lot = await BarcodeBulkLot.findById(req.params.id)
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })

    lot.badSerials = []
    await lot.save()
    res.json({
      lot: serializeLot(lot.toObject(), { includeItems: false }),
      list: 'bad',
      cleared: true,
      total: 0,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * DELETE /api/barcode-bulk/:id/serial-lists
 * Clear both good and bad serial lists.
 */
router.delete('/:id/serial-lists', protectRoute, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lot id' })
    }
    const lot = await BarcodeBulkLot.findById(req.params.id)
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })

    lot.goodSerials = []
    lot.badSerials = []
    await lot.save()
    res.json({
      lot: serializeLot(lot.toObject(), { includeItems: false }),
      cleared: true,
      goodSerialCount: 0,
      badSerialCount: 0,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/barcode-bulk/:id
 * Open / resume a named sheet with all scans.
 * Query: includeSerialLists=1 to include full goodSerials / badSerials arrays.
 */
router.get('/:id', protectRoute, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lot id' })
    }
    const includeSerialLists =
      req.query.includeSerialLists === '1' ||
      req.query.includeSerialLists === 'true' ||
      req.query.includeSerialLists === 'yes'

    const lot = await BarcodeBulkLot.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('items.scannedBy', 'name email')
      .lean()
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })
    res.json({ lot: serializeLot(lot, { includeSerialLists }) })
  } catch (err) {
    next(err)
  }
})

/**
 * PATCH /api/barcode-bulk/:id
 * Rename, update description, or set status open|closed.
 */
router.patch('/:id', protectRoute, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lot id' })
    }
    const lot = await BarcodeBulkLot.findById(req.params.id)
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })

    const body = req.body || {}
    if (typeof body.name === 'string') {
      const name = normalizeText(body.name)
      if (!name) return res.status(400).json({ error: 'name cannot be empty' })
      lot.name = name
    }
    if (typeof body.description === 'string') {
      lot.description = normalizeText(body.description) || undefined
    }
    if (typeof body.status === 'string') {
      const status = body.status.trim().toLowerCase()
      if (status !== 'open' && status !== 'closed') {
        return res.status(400).json({ error: 'status must be open or closed' })
      }
      lot.status = status
    }

    await lot.save()
    res.json({ lot: serializeLot(lot.toObject()) })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/barcode-bulk/:id/scans
 * Add one (or many) scans to a sheet without creating AI logs.
 * Body: { barcode } or { barcodes: string[] }
 * Optional overrides: partName, partNumber, customer, supplier, serialNumber, notes
 * When good/bad lists are loaded, each scan gets serialStatus: good | bad | not_found.
 */
router.post('/:id/scans', protectRoute, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Invalid lot id' })
    }
    const lot = await BarcodeBulkLot.findById(req.params.id)
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })
    if (lot.status === 'closed') {
      return res.status(400).json({ error: 'This bulk sheet is closed. Re-open it to add scans.' })
    }

    const body = req.body || {}
    let barcodes = []
    if (Array.isArray(body.barcodes)) {
      barcodes = body.barcodes.map(normalizeBarcode).filter(Boolean)
    } else if (body.barcode) {
      barcodes = [normalizeBarcode(body.barcode)].filter(Boolean)
    }
    if (barcodes.length === 0) {
      return res.status(400).json({ error: 'barcode or barcodes is required' })
    }
    if (barcodes.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 barcodes per request' })
    }

    const override = {
      partName: typeof body.partName === 'string' ? normalizeText(body.partName) : '',
      partNumber: typeof body.partNumber === 'string' ? normalizeText(body.partNumber) : '',
      customer: typeof body.customer === 'string' ? normalizeText(body.customer) : '',
      supplier: typeof body.supplier === 'string' ? normalizeText(body.supplier) : '',
      serialNumber: typeof body.serialNumber === 'string' ? normalizeText(body.serialNumber) : '',
      notes: typeof body.notes === 'string' ? normalizeText(body.notes) : '',
    }

    const { goodSet, badSet, hasLists } = buildSerialLookupSets(lot)

    const added = []
    for (const barcode of barcodes) {
      const resolved = await resolveScanFields(barcode)
      const serialNumber = override.serialNumber || resolved.fields.serialNumber || ''
      const lookupValue = serialNumber || barcode
      const serialStatus = resolveSerialStatus(lookupValue, goodSet, badSet, hasLists)

      const item = {
        barcode,
        scannedAt: new Date(),
        scannedBy: req.user._id,
        partName: override.partName || resolved.fields.partName || undefined,
        partNumber: override.partNumber || resolved.fields.partNumber || undefined,
        customer: override.customer || resolved.fields.customer || undefined,
        supplier: override.supplier || resolved.fields.supplier || undefined,
        serialNumber: serialNumber || undefined,
        serialStatus: serialStatus || undefined,
        notes: override.notes || resolved.fields.notes || undefined,
        patternId: resolved.patternId || undefined,
        mappingId: resolved.mappingId || undefined,
      }
      lot.items.push(item)
      added.push(item)
    }

    await lot.save()

    // Return the newly added items with ids from the saved doc
    const savedItems = lot.items.slice(-added.length)
    res.status(201).json({
      lot: serializeLot(lot.toObject(), { includeItems: false }),
      added: savedItems.map((item) => ({
        _id: item._id,
        barcode: item.barcode,
        scannedAt: item.scannedAt,
        partName: item.partName || '',
        partNumber: item.partNumber || '',
        customer: item.customer || '',
        supplier: item.supplier || '',
        serialNumber: item.serialNumber || '',
        serialStatus: item.serialStatus || null,
        notes: item.notes || '',
        patternId: item.patternId || null,
        mappingId: item.mappingId || null,
      })),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * DELETE /api/barcode-bulk/:id/scans/:itemId
 * Remove one scan row from a sheet.
 */
router.delete('/:id/scans/:itemId', protectRoute, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.itemId)) {
      return res.status(400).json({ error: 'Invalid id' })
    }
    const lot = await BarcodeBulkLot.findById(req.params.id)
    if (!lot) return res.status(404).json({ error: 'Bulk lot not found' })

    const before = lot.items.length
    lot.items = lot.items.filter((item) => String(item._id) !== String(req.params.itemId))
    if (lot.items.length === before) {
      return res.status(404).json({ error: 'Scan item not found' })
    }
    await lot.save()
    res.json({ lot: serializeLot(lot.toObject(), { includeItems: false }), deleted: true })
  } catch (err) {
    next(err)
  }
})

export { router as barcodeBulkRouter }

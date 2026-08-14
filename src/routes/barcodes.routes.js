import { Router } from 'express'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { BarcodeMapping } from '../models/BarcodeMapping.js'
import { BarcodePattern } from '../models/BarcodePattern.js'
import { applySegments, buildStructureKey } from '../services/barcodePattern.js'
import { createChatCompletion, getAssistantContent, isOpenAIAvailable } from '../services/openai.js'

const router = Router()

function normalizeBarcode(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function serializeMapping(mapping) {
  if (!mapping) return null
  return {
    barcode: mapping.barcode,
    partName: mapping.partName || mapping.productName,
    partNumber: mapping.partNumber,
    productName: mapping.productName,
    customer: mapping.customer,
    serialNumber: mapping.serialNumber || '',
    scanCount: mapping.scanCount,
    metadata: mapping.metadata,
    updatedAt: mapping.updatedAt,
    createdAt: mapping.createdAt,
  }
}

async function findMatchingPattern(barcode) {
  const structureKey = buildStructureKey(barcode)
  const pattern = await BarcodePattern.findOne({ structureKey, isActive: true })
    .sort({ updatedAt: -1 })
    .lean()
  if (!pattern) return { structureKey, pattern: null, extracted: null }
  if (barcode.length !== pattern.sampleBarcode.length) {
    return { structureKey, pattern, extracted: null }
  }
  return {
    structureKey,
    pattern,
    extracted: applySegments(barcode, pattern.segments),
  }
}

async function buildClarificationPrompt({ barcode, mapping, extracted }) {
  const customer =
    mapping?.customer ||
    extracted?.customer ||
    extracted?.supplier ||
    ''
  const partName = mapping?.partName || mapping?.productName || extracted?.partName || ''
  const partNumber = mapping?.partNumber || extracted?.partNumber || ''
  const serialNumber = mapping?.serialNumber || extracted?.serialNumber || ''
  const partLabel = [partName, partNumber].filter(Boolean).join(' · ')
  const known = Boolean(mapping || extracted)

  if (!isOpenAIAvailable()) {
    if (known) {
      const label = [partLabel, customer, serialNumber ? `SN ${serialNumber}` : '']
        .filter(Boolean)
        .join(' · ') || barcode
      return {
        mode: 'known',
        prompt: `Any notes regarding this part? (${label})`,
        fields: ['notes'],
      }
    }
    return {
      mode: 'unknown',
      prompt:
        'This barcode is new. What customer, part number/product, and serial number is it? Any notes regarding this part?',
      fields: ['customer', 'partName', 'partNumber', 'serialNumber', 'notes'],
    }
  }

  const system = `
You are an internal assistant for a quality tracking app.
Given a scanned barcode and (optional) known mapping, write one short clarification question for the user.
Return ONLY plain text. Keep it concise.`.trim()

  const user = known
    ? `
Barcode: ${barcode}
Known mapping:
- Customer: ${customer || '(unknown)'}
- Part Name: ${partName || '(unknown)'}
- Part Number: ${partNumber || '(unknown)'}
- Serial number: ${serialNumber || '(unknown)'}

Ask a short follow-up question requesting notes for this known part.`
        .trim()
    : `
Barcode: ${barcode}
No mapping exists yet.

Ask a short question requesting:
1) the customer name, 2) the part number/product name, 3) serial number if known, then ask for any notes.`
        .trim()

  const completion = await createChatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { model: 'gpt-4o-mini', temperature: 0.2 }
  )

  const text = getAssistantContent(completion)?.trim()
  if (text) {
    return known
      ? { mode: 'known', prompt: text, fields: ['notes'] }
      : {
          mode: 'unknown',
          prompt: text,
          fields: ['customer', 'partName', 'partNumber', 'serialNumber', 'notes'],
        }
  }

  return known
    ? { mode: 'known', prompt: 'Any notes regarding this part?', fields: ['notes'] }
    : {
        mode: 'unknown',
        prompt: 'What customer, part name, part number, and serial number is this? Any notes?',
        fields: ['customer', 'partName', 'partNumber', 'serialNumber', 'notes'],
      }
}

// POST /api/barcodes/clarify
router.post('/clarify', protectRoute, async (req, res, next) => {
  try {
    const { barcode: rawBarcode } = req.body || {}
    const barcode = normalizeBarcode(rawBarcode)
    if (!barcode) return res.status(400).json({ error: 'barcode is required' })

    const mapping = await BarcodeMapping.findOne({ barcode }).lean()
    const { structureKey, pattern, extracted } = await findMatchingPattern(barcode)
    const clarification = await buildClarificationPrompt({ barcode, mapping, extracted })

    res.json({
      barcode,
      ...clarification,
      structureKey,
      mapping: serializeMapping(mapping),
      pattern: pattern
        ? {
            _id: pattern._id,
            name: pattern.name || '',
            sampleBarcode: pattern.sampleBarcode,
            structureKey: pattern.structureKey,
          }
        : null,
      extracted: extracted || null,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/barcodes/admin
router.get('/admin', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN
    const rawPage = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : NaN
    const limit = Math.min(Math.max(Number.isNaN(rawLimit) ? 20 : rawLimit, 1), 100)
    const page = Math.max(Number.isNaN(rawPage) ? 1 : rawPage, 1)
    const skip = (page - 1) * limit

    const qRaw = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const filter = {}
    if (qRaw) {
      const esc = qRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(esc, 'i')
      filter.$or = [
        { barcode: re },
        { customer: re },
        { partName: re },
        { partNumber: re },
        { productName: re },
        { serialNumber: re },
      ]
    }

    const [mappings, total] = await Promise.all([
      BarcodeMapping.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('lastScannedBy', 'name email')
        .lean(),
      BarcodeMapping.countDocuments(filter),
    ])

    const totalPages = Math.ceil(total / limit) || 1

    res.json({
      mappings: mappings.map((m) => ({
        _id: m._id,
        barcode: m.barcode,
        partName: m.partName || m.productName,
        partNumber: m.partNumber,
        productName: m.productName,
        customer: m.customer,
        serialNumber: m.serialNumber || '',
        scanCount: m.scanCount ?? 0,
        metadata: m.metadata,
        lastScannedBy: m.lastScannedBy
          ? {
              _id: m.lastScannedBy._id,
              name: m.lastScannedBy.name,
              email: m.lastScannedBy.email,
            }
          : null,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
      total,
      page,
      limit,
      totalPages,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/barcodes/:barcode
router.get('/:barcode', protectRoute, async (req, res, next) => {
  try {
    const barcode = normalizeBarcode(req.params.barcode)
    if (!barcode) return res.status(400).json({ error: 'barcode is required' })

    const mapping = await BarcodeMapping.findOne({ barcode }).lean()
    if (!mapping) return res.status(404).json({ error: 'Barcode not found' })

    res.json({ mapping: serializeMapping(mapping) })
  } catch (err) {
    next(err)
  }
})

// POST /api/barcodes/scan
router.post('/scan', protectRoute, async (req, res, next) => {
  try {
    const { barcode: rawBarcode } = req.body || {}
    const barcode = normalizeBarcode(rawBarcode)
    if (!barcode) return res.status(400).json({ error: 'barcode is required' })

    const mapping = await BarcodeMapping.findOneAndUpdate(
      { barcode },
      { $inc: { scanCount: 1 }, $set: { lastScannedBy: req.user._id } },
      { new: true }
    ).lean()

    if (!mapping) return res.status(404).json({ error: 'Barcode not found' })

    const { pattern, extracted } = await findMatchingPattern(barcode)

    res.json({
      mapping: serializeMapping(mapping),
      pattern: pattern
        ? { _id: pattern._id, name: pattern.name || '', structureKey: pattern.structureKey }
        : null,
      extracted: extracted || null,
    })
  } catch (err) {
    next(err)
  }
})

// PUT /api/barcodes/:barcode
router.put('/:barcode', protectRoute, async (req, res, next) => {
  try {
    const barcode = normalizeBarcode(req.params.barcode)
    if (!barcode) return res.status(400).json({ error: 'barcode is required' })

    const { customer, partName, partNumber, productName, serialNumber, metadata } = req.body || {}
    const update = {}
    if (typeof customer === 'string') update.customer = normalizeText(customer) || undefined
    if (typeof partName === 'string') update.partName = normalizeText(partName) || undefined
    if (typeof partNumber === 'string') update.partNumber = normalizeText(partNumber) || undefined
    if (typeof productName === 'string') update.productName = normalizeText(productName) || undefined
    if (typeof partName !== 'string' && typeof productName === 'string') {
      update.partName = normalizeText(productName) || undefined
    }
    if (typeof serialNumber === 'string') {
      update.serialNumber = normalizeText(serialNumber).slice(0, 128) || undefined
    }
    if (metadata !== undefined) update.metadata = metadata

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        error:
          'Provide at least one field: customer, partName, partNumber, productName, serialNumber, metadata',
      })
    }

    update.lastScannedBy = req.user._id

    const mapping = await BarcodeMapping.findOneAndUpdate(
      { barcode },
      { $set: update, $setOnInsert: { barcode }, $inc: { scanCount: 1 } },
      { new: true, upsert: true }
    ).lean()

    res.json({ mapping: serializeMapping(mapping) })
  } catch (err) {
    next(err)
  }
})

export { router as barcodesRouter }

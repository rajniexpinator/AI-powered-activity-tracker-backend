import { Router } from 'express'
import { protectRoute } from '../middleware/auth.js'
import { BarcodeMapping } from '../models/BarcodeMapping.js'
import { createChatCompletion, getAssistantContent, isOpenAIAvailable } from '../services/openai.js'

const router = Router()

function normalizeBarcode(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function buildClarificationPrompt({ barcode, mapping }) {
  const customer = mapping?.customer ? String(mapping.customer).trim() : ''
  const partName = mapping?.partName ? String(mapping.partName).trim() : ''
  const partNumber = mapping?.partNumber ? String(mapping.partNumber).trim() : ''
  const productName = mapping?.productName ? String(mapping.productName).trim() : ''
  const partLabel = [partName || productName, partNumber].filter(Boolean).join(' · ')

  if (!isOpenAIAvailable()) {
    if (mapping) {
      const label = [partLabel, customer].filter(Boolean).join(' · ') || barcode
      return {
        mode: 'known',
        prompt: `Any notes regarding this part? (${label})`,
        fields: ['notes'],
      }
    }
    return {
      mode: 'unknown',
      prompt: 'This barcode is new. What customer and part number/product is it? Any notes regarding this part?',
      fields: ['customer', 'partName', 'partNumber', 'notes'],
    }
  }

  const system = `
You are an internal assistant for a quality tracking app.
Given a scanned barcode and (optional) known mapping, write one short clarification question for the user.
Return ONLY plain text. Keep it concise.`.trim()

  const user = mapping
    ? `
Barcode: ${barcode}
Known mapping:
- Customer: ${customer || '(unknown)'}
- Part Name: ${partName || productName || '(unknown)'}
- Part Number: ${partNumber || '(unknown)'}

Ask a short follow-up question requesting notes for this known part.`
        .trim()
    : `
Barcode: ${barcode}
No mapping exists yet.

Ask a short question requesting:
1) the customer name and 2) the part number/product name, then ask for any notes.`
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
    return mapping
      ? { mode: 'known', prompt: text, fields: ['notes'] }
      : { mode: 'unknown', prompt: text, fields: ['customer', 'partName', 'partNumber', 'notes'] }
  }

  return mapping
    ? { mode: 'known', prompt: 'Any notes regarding this part?', fields: ['notes'] }
    : {
        mode: 'unknown',
        prompt: 'What customer, part name and part number is this? Any notes regarding this part?',
        fields: ['customer', 'partName', 'partNumber', 'notes'],
      }
}

// POST /api/barcodes/clarify
// Body: { barcode: string }
// Returns a follow-up prompt for the user (unknown vs known barcode).
router.post('/clarify', protectRoute, async (req, res, next) => {
  try {
    const { barcode: rawBarcode } = req.body || {}
    const barcode = normalizeBarcode(rawBarcode)
    if (!barcode) return res.status(400).json({ error: 'barcode is required' })

    const mapping = await BarcodeMapping.findOne({ barcode }).lean()
    const clarification = await buildClarificationPrompt({ barcode, mapping })

    res.json({
      barcode,
      ...clarification,
      mapping: mapping
        ? {
            barcode: mapping.barcode,
            partName: mapping.partName || mapping.productName,
            partNumber: mapping.partNumber,
            productName: mapping.productName,
            customer: mapping.customer,
            scanCount: mapping.scanCount,
            updatedAt: mapping.updatedAt,
            createdAt: mapping.createdAt,
          }
        : null,
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

    res.json({
      mapping: {
        barcode: mapping.barcode,
        partName: mapping.partName || mapping.productName,
        partNumber: mapping.partNumber,
        productName: mapping.productName,
        customer: mapping.customer,
        scanCount: mapping.scanCount,
        updatedAt: mapping.updatedAt,
        createdAt: mapping.createdAt,
      },
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/barcodes/scan
// Body: { barcode: string }
// Increments scanCount and sets lastScannedBy. Returns mapping if exists.
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

    res.json({
      mapping: {
        barcode: mapping.barcode,
        partName: mapping.partName || mapping.productName,
        partNumber: mapping.partNumber,
        productName: mapping.productName,
        customer: mapping.customer,
        scanCount: mapping.scanCount,
        updatedAt: mapping.updatedAt,
        createdAt: mapping.createdAt,
      },
    })
  } catch (err) {
    next(err)
  }
})

// PUT /api/barcodes/:barcode
// Creates or updates mapping.
// Body: { customer?: string, partName?: string, partNumber?: string, productName?: string, metadata?: any }
router.put('/:barcode', protectRoute, async (req, res, next) => {
  try {
    const barcode = normalizeBarcode(req.params.barcode)
    if (!barcode) return res.status(400).json({ error: 'barcode is required' })

    const { customer, partName, partNumber, productName, metadata } = req.body || {}
    const update = {}
    if (typeof customer === 'string') update.customer = normalizeText(customer) || undefined
    if (typeof partName === 'string') update.partName = normalizeText(partName) || undefined
    if (typeof partNumber === 'string') update.partNumber = normalizeText(partNumber) || undefined
    if (typeof productName === 'string') update.productName = normalizeText(productName) || undefined
    if (typeof partName !== 'string' && typeof productName === 'string') {
      update.partName = normalizeText(productName) || undefined
    }
    if (metadata !== undefined) update.metadata = metadata

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Provide at least one field: customer, partName, partNumber, productName, metadata' })
    }

    update.lastScannedBy = req.user._id

    const mapping = await BarcodeMapping.findOneAndUpdate(
      { barcode },
      { $set: update, $setOnInsert: { barcode }, $inc: { scanCount: 1 } },
      { new: true, upsert: true }
    ).lean()

    res.json({
      mapping: {
        barcode: mapping.barcode,
        partName: mapping.partName || mapping.productName,
        partNumber: mapping.partNumber,
        productName: mapping.productName,
        customer: mapping.customer,
        scanCount: mapping.scanCount,
        updatedAt: mapping.updatedAt,
        createdAt: mapping.createdAt,
      },
    })
  } catch (err) {
    next(err)
  }
})

export { router as barcodesRouter }


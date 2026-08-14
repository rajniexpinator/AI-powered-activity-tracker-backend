import mongoose from 'mongoose'

/**
 * Taught segment layout for a "kind" of barcode/QR string.
 * Users highlight ranges on a sample scan and assign fields; matching
 * barcodes (same structureKey) reuse those ranges later.
 */
const segmentSchema = new mongoose.Schema(
  {
    /** Inclusive start index into the sample / matching barcode string. */
    start: { type: Number, required: true, min: 0 },
    /** Exclusive end index. */
    end: { type: Number, required: true, min: 1 },
    /**
     * Target field for this highlight.
     * Multiple segments with the same field are joined in order with a space.
     */
    field: {
      type: String,
      required: true,
      enum: ['partNumber', 'partName', 'customer', 'supplier', 'serialNumber', 'notes'],
    },
  },
  { _id: false }
)

const barcodePatternSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    /** Exact sample string used when teaching the pattern. */
    sampleBarcode: { type: String, required: true, trim: true },
    /**
     * Structure fingerprint so similar barcodes match (token lengths + separators).
     * Example: "ABC 12-XY" → "A3 A2-A2"
     */
    structureKey: { type: String, required: true, trim: true, index: true },
    segments: { type: [segmentSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
)

barcodePatternSchema.index({ structureKey: 1, updatedAt: -1 })
barcodePatternSchema.index({ sampleBarcode: 1 })

export const BarcodePattern = mongoose.model('BarcodePattern', barcodePatternSchema)

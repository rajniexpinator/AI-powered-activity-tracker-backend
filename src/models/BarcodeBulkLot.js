import mongoose from 'mongoose'

const SERIAL_STATUS = ['good', 'bad', 'not_found']

const bulkScanItemSchema = new mongoose.Schema(
  {
    barcode: { type: String, required: true, trim: true },
    scannedAt: { type: Date, default: Date.now },
    scannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    partName: { type: String, trim: true },
    partNumber: { type: String, trim: true },
    customer: { type: String, trim: true },
    supplier: { type: String, trim: true },
    serialNumber: { type: String, trim: true },
    /** Set when good/bad lists are loaded: good | bad | not_found */
    serialStatus: { type: String, enum: SERIAL_STATUS },
    notes: { type: String, trim: true },
    patternId: { type: mongoose.Schema.Types.ObjectId, ref: 'BarcodePattern' },
    mappingId: { type: mongoose.Schema.Types.ObjectId, ref: 'BarcodeMapping' },
  },
  { _id: true }
)

/**
 * Named bulk-scan sheet/lot — separate from AI activity logs.
 * Users can create, leave, and resume the same sheet later.
 * Optional goodSerials / badSerials lists verify scans as good | bad | not_found.
 */
const barcodeBulkLotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Approved serial numbers for this sheet (VLOOKUP-style). */
    goodSerials: { type: [String], default: [] },
    /** Rejected serial numbers for this sheet. */
    badSerials: { type: [String], default: [] },
    items: { type: [bulkScanItemSchema], default: [] },
  },
  { timestamps: true }
)

barcodeBulkLotSchema.index({ name: 1 })
barcodeBulkLotSchema.index({ createdBy: 1, updatedAt: -1 })
barcodeBulkLotSchema.index({ status: 1, updatedAt: -1 })

export const SERIAL_STATUSES = SERIAL_STATUS
export const BarcodeBulkLot = mongoose.model('BarcodeBulkLot', barcodeBulkLotSchema)

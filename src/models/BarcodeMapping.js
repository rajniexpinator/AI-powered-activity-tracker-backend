import mongoose from 'mongoose'

const barcodeMappingSchema = new mongoose.Schema(
  {
    barcode: { type: String, required: true, unique: true, trim: true },
    productName: { type: String, trim: true },
    customer: { type: String, trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
    scanCount: { type: Number, default: 1 },
    lastScannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
)

barcodeMappingSchema.index({ barcode: 1 })

export const BarcodeMapping = mongoose.model('BarcodeMapping', barcodeMappingSchema)

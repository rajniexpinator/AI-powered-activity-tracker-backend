import mongoose from 'mongoose'

const whatsAppSessionSchema = new mongoose.Schema(
  {
    address: { type: String, required: true, trim: true, lowercase: true, unique: true },
    lastInboundAt: { type: Date, required: true },
  },
  { timestamps: true }
)

whatsAppSessionSchema.index({ address: 1 }, { unique: true })
whatsAppSessionSchema.index({ lastInboundAt: -1 })

export const WhatsAppSession = mongoose.model('WhatsAppSession', whatsAppSessionSchema)

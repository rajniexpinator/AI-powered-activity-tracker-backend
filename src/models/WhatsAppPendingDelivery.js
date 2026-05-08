import mongoose from 'mongoose'

const whatsAppPendingDeliverySchema = new mongoose.Schema(
  {
    address: { type: String, required: true, trim: true, lowercase: true, index: true },
    activityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity' },
    messages: [{ type: String, required: true }],
    status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending', index: true },
    lastError: { type: String, default: '' },
    sentAt: { type: Date },
  },
  { timestamps: true }
)

whatsAppPendingDeliverySchema.index({ address: 1, status: 1, createdAt: 1 })

export const WhatsAppPendingDelivery = mongoose.model('WhatsAppPendingDelivery', whatsAppPendingDeliverySchema)


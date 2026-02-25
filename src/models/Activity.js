import mongoose from 'mongoose'

const activitySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    customer: { type: String, trim: true },
    summary: { type: String },
    rawConversation: { type: String },
    structuredData: { type: mongoose.Schema.Types.Mixed },
    images: [{ type: String }],
    barcodeRef: { type: mongoose.Schema.Types.ObjectId, ref: 'BarcodeMapping' },
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date }
  },
  { timestamps: true }
)

activitySchema.index({ userId: 1, createdAt: -1 })
activitySchema.index({ customer: 1 })
activitySchema.index({ isArchived: 1 })

export const Activity = mongoose.model('Activity', activitySchema)

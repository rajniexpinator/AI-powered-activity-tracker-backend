import mongoose from 'mongoose'

const activitySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    customer: { type: String, trim: true },
    /** Resolved reporting plant/OEM stamped from the employee profile at log creation. */
    reportingPlant: { type: String, trim: true, default: undefined },
    /** Part / unit serial number from scan mapping or manual entry (replaces unused location). */
    serialNumber: {
      type: String,
      trim: true,
      maxlength: 128,
      default: undefined,
    },
    summary: { type: String },
    rawConversation: { type: String },
    structuredData: { type: mongoose.Schema.Types.Mixed },
    images: [{ type: String }],
    attachments: [
      {
        url: { type: String, required: true },
        name: { type: String, trim: true },
        mime: { type: String, trim: true },
        size: { type: Number },
      },
    ],
    barcodeRef: { type: mongoose.Schema.Types.ObjectId, ref: 'BarcodeMapping' },
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date },
    sharedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    collaborationNotes: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        text: { type: String, required: true, maxlength: 12000 },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
)

activitySchema.index({ userId: 1, createdAt: -1 })
activitySchema.index({ customer: 1 })
activitySchema.index({ reportingPlant: 1 })
activitySchema.index({ isArchived: 1 })
activitySchema.index({ sharedWith: 1, isArchived: 1 })
activitySchema.index({ serialNumber: 1 })

export const Activity = mongoose.model('Activity', activitySchema)

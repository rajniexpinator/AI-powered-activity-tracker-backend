import mongoose from 'mongoose'

const activitySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    customer: { type: String, trim: true },
    // Up to 5-character physical-location tag (e.g. "A12", "B-7", "ZN102").
    // Helps a manager walk to the spot when they read a log.
    location: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 5,
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
activitySchema.index({ isArchived: 1 })
activitySchema.index({ sharedWith: 1, isArchived: 1 })

export const Activity = mongoose.model('Activity', activitySchema)

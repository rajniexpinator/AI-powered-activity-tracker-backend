import mongoose from 'mongoose'

const reportSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    scopeRole: { type: String, enum: ['admin'], required: true },

    // Filters used to generate this report
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional filter for employee
    customer: { type: String, trim: true }, // optional single-customer report
    from: { type: Date },
    to: { type: Date },

    includeCustomerSummaries: { type: Boolean, default: false },

    /** Issue severity filter used when generating (structuredData.severity 1–3). */
    issueSeverityExact: { type: Number, min: 1, max: 3 },
    issueSeverityMin: { type: Number, min: 1, max: 3 },

    // Output
    content: { type: String, required: true },
    model: { type: String, default: 'gpt-4o-mini' },

    // Thumbnails: photos from included activities (https URLs only), for Reports UI and PDF attachment
    imageGallery: [
      {
        activityId: { type: mongoose.Schema.Types.ObjectId },
        customer: { type: String, default: '' },
        summary: { type: String, default: '' },
        createdAt: { type: Date },
        imageUrls: [{ type: String }],
      },
    ],

    // Basic stats
    activityCount: { type: Number, default: 0 },
  },
  { timestamps: true }
)

reportSchema.index({ createdBy: 1, createdAt: -1 })
reportSchema.index({ customer: 1, createdAt: -1 })
reportSchema.index({ userId: 1, createdAt: -1 })

export const Report = mongoose.model('Report', reportSchema)


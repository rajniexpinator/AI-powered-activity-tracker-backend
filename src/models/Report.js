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
    period: { type: String, trim: true },
    /** When "today", re-run uses the calendar day the user opens the report. */
    dateMode: { type: String, enum: ['fixed', 'today'], default: 'fixed' },
    aiQuestion: { type: String, trim: true },

    includeCustomerSummaries: { type: Boolean, default: false },

    reportSections: {
      customersVisited: { type: Boolean, default: true },
      visitSummary: { type: Boolean, default: true },
      keyActions: { type: Boolean, default: true },
      risks: { type: Boolean, default: true },
      nextSteps: { type: Boolean, default: true },
    },
    includeReportPictures: { type: Boolean, default: true },
    /** When true, severity is kept out of the report narrative. */
    hideSeverity: { type: Boolean, default: true },

    /** Issue severity filter used when generating (structuredData.severity 0–3). */
    issueSeverityExact: { type: Number, min: 0, max: 3 },
    issueSeverityMin: { type: Number, min: 0, max: 3 },

    /** OEM / reporting plant for this report (from activity logs). */
    oem: { type: String, trim: true },
    /** Cached display title, e.g. Quality Report for Piston at KTP */
    title: { type: String, trim: true },

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
reportSchema.index({ oem: 1, createdAt: -1 })

export const Report = mongoose.model('Report', reportSchema)


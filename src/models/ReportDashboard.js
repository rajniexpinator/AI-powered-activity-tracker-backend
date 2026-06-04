import mongoose from 'mongoose'

const reportDashboardSchema = new mongoose.Schema(
  {
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** admin = full reports; employee = simple personal reports only */
    scopeRole: { type: String, enum: ['admin', 'employee'], default: 'admin' },
    displayName: { type: String, required: true, trim: true },
    sourceReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'Report' },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    customer: { type: String, trim: true },
    from: { type: Date },
    to: { type: Date },
    period: { type: String, trim: true },
    dateMode: { type: String, enum: ['fixed', 'today'], default: 'fixed' },

    includeCustomerSummaries: { type: Boolean, default: false },
    issueSeverityExact: { type: Number, min: 0, max: 3 },
    issueSeverityMin: { type: Number, min: 0, max: 3 },

    aiQuestion: { type: String, trim: true },
  },
  { timestamps: true }
)

reportDashboardSchema.index({ createdBy: 1, scopeRole: 1, displayName: 1 }, { unique: true })
reportDashboardSchema.index({ scopeRole: 1, createdAt: -1 })
reportDashboardSchema.index({ createdBy: 1, createdAt: -1 })

export const ReportDashboard = mongoose.model('ReportDashboard', reportDashboardSchema)

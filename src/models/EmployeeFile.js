import mongoose from 'mongoose'

/**
 * HR / internal employee resources (handbooks, directory, policies).
 * Not used for quality-tracker or AI log attachments — those use Activity + upload routes.
 */
const employeeFileSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    storage: { type: String, enum: ['s3', 'local'], required: true },
    s3Key: { type: String, default: null },
    /** Filename under uploads/internal-hr-resources/ when storage === 'local' */
    localFilename: { type: String, default: null },
    originalName: { type: String, default: '' },
    mimeType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
)

employeeFileSchema.index({ createdAt: -1 })

export const EmployeeFile = mongoose.model('EmployeeFile', employeeFileSchema)

import mongoose from 'mongoose'

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
)

customerSchema.index({ name: 1 })
customerSchema.index({ email: 1 })

export const Customer = mongoose.model('Customer', customerSchema)


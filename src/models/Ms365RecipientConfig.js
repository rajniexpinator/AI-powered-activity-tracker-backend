import mongoose from 'mongoose'

const recipientConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
  },
  { timestamps: true }
)

export const Ms365RecipientConfig = mongoose.model('Ms365RecipientConfig', recipientConfigSchema)


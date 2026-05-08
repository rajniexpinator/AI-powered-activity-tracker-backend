import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true },
    role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
    isActive: { type: Boolean, default: true },
    whatsAppNumber: { type: String, trim: true, default: '' },
    whatsAppNotifications: {
      enabled: { type: Boolean, default: false },
      severityLevels: {
        type: [{ type: Number, enum: [1, 2, 3] }],
        default: [],
      },
    },
  },
  { timestamps: true }
)

userSchema.index({ email: 1 })
userSchema.index({ role: 1 })

export const User = mongoose.model('User', userSchema)

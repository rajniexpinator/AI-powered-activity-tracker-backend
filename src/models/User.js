import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true },
    role: { type: String, enum: ['admin', 'supervisor', 'employee'], default: 'employee' },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
)

userSchema.index({ email: 1 })
userSchema.index({ role: 1 })

export const User = mongoose.model('User', userSchema)

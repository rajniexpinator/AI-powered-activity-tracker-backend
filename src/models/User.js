import mongoose from 'mongoose'
import { PLANT_OPTIONS } from '../constants/plants.js'

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true },
    role: { type: String, enum: ['super_admin', 'admin', 'employee'], default: 'employee' },
    isActive: { type: Boolean, default: true },
    emailNotifications: {
      enabled: { type: Boolean, default: false },
      severityLevels: {
        type: [{ type: Number, enum: [1, 2, 3] }],
        default: [],
      },
    },
    teamsNotifications: {
      enabled: { type: Boolean, default: false },
      severityLevels: {
        type: [{ type: Number, enum: [1, 2, 3] }],
        default: [],
      },
    },
    /** Single reporting plant/OEM per employee (KTP, LAP, OHAP, Oakville, or Other). */
    assignedPlant: { type: String, enum: PLANT_OPTIONS, default: undefined },
    /** Custom plant name when assignedPlant is Other (e.g. KCAP). */
    assignedPlantOther: { type: String, trim: true, default: undefined },
    sharePreferences: {
      activityLog: {
        customer: { type: Boolean, default: true },
        createdAt: { type: Boolean, default: true },
        partName: { type: Boolean, default: true },
        partNumber: { type: Boolean, default: true },
        summary: { type: Boolean, default: true },
        photos: { type: Boolean, default: true },
        files: { type: Boolean, default: true },
      },
      report: {
        includeContent: { type: Boolean, default: true },
        includePictures: { type: Boolean, default: true },
      },
    },
  },
  { timestamps: true }
)

userSchema.index({ email: 1 })
userSchema.index({ role: 1 })

export const User = mongoose.model('User', userSchema)

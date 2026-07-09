import { User } from '../models/User.js'

/**
 * One-time bootstrap: if no super_admin exists, promote the oldest admin (or first user).
 */
export async function ensureSuperAdmin() {
  const superAdminCount = await User.countDocuments({ role: 'super_admin' })
  if (superAdminCount > 0) return

  const oldestAdmin = await User.findOne({ role: 'admin' }).sort({ createdAt: 1 })
  if (oldestAdmin) {
    oldestAdmin.role = 'super_admin'
    await oldestAdmin.save()
    console.log(`[roles] Promoted ${oldestAdmin.email} to super_admin`)
    return
  }

  const firstUser = await User.findOne().sort({ createdAt: 1 })
  if (firstUser && firstUser.role !== 'super_admin') {
    firstUser.role = 'super_admin'
    await firstUser.save()
    console.log(`[roles] Promoted ${firstUser.email} to super_admin`)
  }
}

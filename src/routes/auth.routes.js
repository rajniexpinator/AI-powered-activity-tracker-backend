import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { User } from '../models/User.js'
import { protectRoute, requireRole } from '../middleware/auth.js'

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production'
const JWT_EXPIRE = process.env.JWT_EXPIRE || '7d'

function signToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  )
}

function toUserResponse(user) {
  return {
    id: user._id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive
  }
}

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {}
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }
    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash')
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    if (!user.isActive) {
      return res.status(401).json({ error: 'Account is disabled' })
    }
    const match = await bcrypt.compare(password, user.passwordHash)
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    const token = signToken(user)
    res.json({
      token,
      user: toUserResponse(user)
    })
  } catch (err) {
    next(err)
  }
})

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body || {}
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }
    const normalizedEmail = email.trim().toLowerCase()
    const existing = await User.findOne({ email: normalizedEmail })
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' })
    }

    const isFirstUser = (await User.countDocuments()) === 0
    let assignedRole = 'employee'
    if (isFirstUser) {
      assignedRole = 'admin'
    } else {
      const authHeader = req.headers.authorization
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
      if (!token) {
        return res.status(401).json({ error: 'Only admins can register new users' })
      }
      let decoded
      try {
        decoded = jwt.verify(token, JWT_SECRET)
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' })
      }
      const adminUser = await User.findById(decoded.userId)
      if (!adminUser || adminUser.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can register new users' })
      }
      const r = role && ['admin', 'supervisor', 'employee'].includes(role) ? role : 'employee'
      assignedRole = r
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const user = await User.create({
      email: normalizedEmail,
      passwordHash,
      name: (name || '').trim() || undefined,
      role: assignedRole,
      isActive: true
    })
    const token = signToken(user)
    res.status(201).json({
      token,
      user: toUserResponse(user)
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/auth/me — current user (protected)
router.get('/me', protectRoute, (req, res) => {
  res.json({ user: toUserResponse(req.user) })
})

// GET /api/auth/users — list users (admin only)
router.get('/users', protectRoute, requireRole('admin'), async (_req, res, next) => {
  try {
    const users = await User.find().select('-passwordHash').sort({ createdAt: -1 })
    res.json({ users: users.map((u) => toUserResponse(u)) })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/auth/users/:id — update role or isActive (admin only)
router.patch('/users/:id', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { role, isActive } = req.body || {}
    const update = {}
    if (typeof isActive === 'boolean') update.isActive = isActive
    if (role && ['admin', 'supervisor', 'employee'].includes(role)) update.role = role
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Provide role and/or isActive' })
    }
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: true }
    ).select('-passwordHash')
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json({ user: toUserResponse(user) })
  } catch (err) {
    next(err)
  }
})

export { router as authRouter }

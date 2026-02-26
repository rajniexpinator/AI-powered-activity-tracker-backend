import jwt from 'jsonwebtoken'
import { User } from '../models/User.js'

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production'

/**
 * Verify JWT from Authorization: Bearer <token>, attach user to req.user. Responds 401 if invalid.
 */
export async function protectRoute(req, res, next) {
  try {
    const authHeader = req.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) {
      return res.status(401).json({ error: 'Not authorized — no token' })
    }
    const decoded = jwt.verify(token, JWT_SECRET)
    const user = await User.findById(decoded.userId).select('-passwordHash')
    if (!user) {
      return res.status(401).json({ error: 'User not found' })
    }
    if (!user.isActive) {
      return res.status(401).json({ error: 'Account is disabled' })
    }
    req.user = user
    next()
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }
    next(err)
  }
}

/**
 * Use after protectRoute. Restricts access to given roles. Responds 403 if role not allowed.
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authorized' })
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' })
    }
    next()
  }
}

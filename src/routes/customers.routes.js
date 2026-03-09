import { Router } from 'express'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { Customer } from '../models/Customer.js'

const router = Router()

// POST /api/customers
// Body: { name: string, email?: string, notes?: string }
router.post('/', protectRoute, async (req, res, next) => {
  try {
    const { name, email, notes } = req.body || {}
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' })
    }

    const customer = await Customer.create({
      name: name.trim(),
      email: typeof email === 'string' ? email.trim() : undefined,
      notes: typeof notes === 'string' ? notes.trim() : undefined,
      createdBy: req.user._id,
    })

    res.status(201).json({ customer })
  } catch (err) {
    next(err)
  }
})

// GET /api/customers
// Admin: returns all customers with createdBy (who added them).
// Non-admin: returns only customers created by the logged-in user.
router.get('/', protectRoute, async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin'
    const filter = isAdmin ? {} : { createdBy: req.user._id }
    const customers = await Customer.find(filter)
      .sort({ name: 1 })
      .populate('createdBy', 'name email role')
      .lean()
    res.json({ customers })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/customers/:id
// Body: { name?: string, email?: string, notes?: string }
router.patch('/:id', protectRoute, async (req, res, next) => {
  try {
    const { id } = req.params
    const { name, email, notes } = req.body || {}
    const update = {}
    if (typeof name === 'string' && name.trim()) update.name = name.trim()
    if (Object.prototype.hasOwnProperty.call(req.body, 'email')) {
      update.email = typeof email === 'string' && email.trim() ? email.trim() : undefined
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'notes')) {
      update.notes = typeof notes === 'string' && notes.trim() ? notes.trim() : undefined
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Provide at least one field to update: name, email, or notes' })
    }
    const customer = await Customer.findByIdAndUpdate(id, { $set: update }, { new: true }).lean()
    if (!customer) return res.status(404).json({ error: 'Customer not found' })
    res.json({ customer })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/customers/:id
// Admins can remove a customer record.
router.delete('/:id', protectRoute, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params
    const deleted = await Customer.findByIdAndDelete(id)
    if (!deleted) {
      return res.status(404).json({ error: 'Customer not found' })
    }
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

export { router as customersRouter }


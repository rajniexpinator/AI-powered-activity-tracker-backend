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
// Returns all customers (for now) sorted by name.
router.get('/', protectRoute, async (_req, res, next) => {
  try {
    const customers = await Customer.find().sort({ name: 1 }).lean()
    res.json({ customers })
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


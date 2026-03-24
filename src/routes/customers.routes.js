import { Router } from 'express'
import { protectRoute, requireRole } from '../middleware/auth.js'
import { Customer } from '../models/Customer.js'

const router = Router()


router.post('/', protectRoute, requireRole('admin'), async (req, res, next) => {
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


router.get('/', protectRoute, async (req, res, next) => {
  try {
    const isInternalRole = req.user.role === 'admin'
    const query = Customer.find({})
      .sort({ name: 1 })

    if (isInternalRole) {
      query.populate('createdBy', 'name email role')
    } else {
      // Employee view is read-only and should not expose internal metadata.
      query.select({ _id: 1, name: 1, email: 1, createdAt: 1 })
    }

    const customers = await query.lean()
    res.json({ customers })
  } catch (err) {
    next(err)
  }
})


router.patch('/:id', protectRoute, requireRole('admin'), async (req, res, next) => {
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
    const existing = await Customer.findById(id).select({ _id: 1 }).lean()
    if (!existing) return res.status(404).json({ error: 'Customer not found' })

    const customer = await Customer.findByIdAndUpdate(id, { $set: update }, { new: true })
      .populate('createdBy', 'name email role')
      .lean()
    res.json({ customer })
  } catch (err) {
    next(err)
  }
})


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


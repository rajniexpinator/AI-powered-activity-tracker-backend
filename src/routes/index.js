/**
 * Central route registry — import all route modules here.
 * Mount these in server.js: app.use('/health', healthRouter), app.use('/api', apiRouter)
 */
import { healthRouter } from './health.routes.js'
import { apiRouter } from './api.routes.js'

export { healthRouter, apiRouter }

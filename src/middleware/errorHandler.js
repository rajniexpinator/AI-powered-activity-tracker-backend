export function notFound(req, _res, next) {
  const err = new Error(`Not Found - ${req.originalUrl}`)
  err.statusCode = 404
  next(err)
}

export function errorHandler(err, _req, res, _next) {
  const status = err.statusCode || 500
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal Server Error'
    : (err.message || 'Internal Server Error')
  res.status(status).json({ error: message })
}

/**
 * Build display title: Quality Report for [Customer] at [OEM]
 */
export function buildQualityReportTitle({ customer, oem, title } = {}) {
  if (typeof title === 'string' && title.trim()) return title.trim()

  const cust = typeof customer === 'string' && customer.trim() ? customer.trim() : ''
  const plant = typeof oem === 'string' && oem.trim() ? oem.trim() : ''

  if (cust && plant) return `Quality Report for ${cust} at ${plant}`
  if (cust) return `Quality Report for ${cust}`
  if (plant) return `Quality Report at ${plant}`
  return 'Quality Report'
}

/** Most common reportingPlant among included activities. */
export function deriveReportOem(activities) {
  if (!Array.isArray(activities) || activities.length === 0) return undefined

  const counts = new Map()
  for (const a of activities) {
    const plant =
      typeof a.reportingPlant === 'string' && a.reportingPlant.trim()
        ? a.reportingPlant.trim()
        : typeof a.structuredData?.oem === 'string' && a.structuredData.oem.trim()
          ? a.structuredData.oem.trim()
          : typeof a.structuredData?.plant === 'string' && a.structuredData.plant.trim()
            ? a.structuredData.plant.trim()
            : ''
    if (!plant) continue
    counts.set(plant, (counts.get(plant) || 0) + 1)
  }

  if (counts.size === 0) return undefined

  let best = ''
  let bestCount = 0
  for (const [plant, count] of counts) {
    if (count > bestCount) {
      best = plant
      bestCount = count
    }
  }
  return best || undefined
}

export function safeQualityReportFilename(report) {
  const title = buildQualityReportTitle({
    customer: report?.customer,
    oem: report?.oem,
    title: report?.title,
  })
  const safe =
    title
      .replace(/[^\w.\-() ]+/g, '_')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'quality-report'
  const date = report?.createdAt ? new Date(report.createdAt).toISOString().slice(0, 10) : 'export'
  return `${safe}-${date}.pdf`
}

/**
 * Weekly activity timesheet Excel — one worksheet per customer, data from Activity logs.
 * Supports a single week or multiple weeks (same date range as the AI weekly report filters).
 */
import ExcelJS from 'exceljs'

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function pad2(n) {
  return String(n).padStart(2, '0')
}

function localDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function parseLocalDateFromIso(iso) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export function getMondayOfWeekContaining(anchor) {
  const d = new Date(anchor)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d
}

export function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

/** All Mondays whose week overlaps [fromDate, toDate] (inclusive, local midnight bounds). */
export function enumerateWeekMondays(fromDate, toDate) {
  const start = new Date(fromDate)
  start.setHours(0, 0, 0, 0)
  const end = new Date(toDate)
  end.setHours(23, 59, 59, 999)
  const firstMonday = getMondayOfWeekContaining(start)
  const mondays = []
  for (let m = new Date(firstMonday); m.getTime() <= end.getTime(); m = addDays(m, 7)) {
    const weekStart = new Date(m)
    weekStart.setHours(0, 0, 0, 0)
    const weekSun = addDays(m, 6)
    weekSun.setHours(23, 59, 59, 999)
    if (weekSun.getTime() >= start.getTime() && weekStart.getTime() <= end.getTime()) {
      mondays.push(new Date(m))
    }
  }
  return mondays
}

function formatWeekEndShort(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d.getDate()}-${months[d.getMonth()]}`
}

function formatUsShort(d) {
  const y = d.getFullYear() % 100
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${pad2(y)}`
}

function getStructured(a) {
  const s = a.structuredData
  return s && typeof s === 'object' ? s : {}
}

function employeeNamesFromActivities(activities) {
  const names = new Set()
  for (const a of activities) {
    const u = a.userId
    if (u && typeof u === 'object') {
      const n = (u.name || '').trim()
      const e = (u.email || '').trim()
      if (n) names.add(n)
      else if (e) names.add(e)
    }
  }
  if (names.size === 0) return '—'
  if (names.size === 1) return [...names][0]
  return [...names].join(', ')
}

function programLineFromActivities(activities, programOverride) {
  if (programOverride && String(programOverride).trim()) return String(programOverride).trim()
  const oems = new Set()
  for (const a of activities) {
    const o = getStructured(a).oem
    if (o && String(o).trim()) oems.add(String(o).trim())
  }
  if (oems.size === 0) return ''
  return [...oems].join(', ')
}

function siteLineFromCustomerSheet(customerKey, activities) {
  if (!customerKey || customerKey === '—') {
    const plants = new Set()
    for (const a of activities) {
      const p = getStructured(a).plant
      if (p && String(p).trim()) plants.add(String(p).trim())
    }
    return plants.size ? [...plants].join(', ') : '—'
  }
  const plants = new Set()
  for (const a of activities) {
    const p = getStructured(a).plant
    if (p && String(p).trim()) plants.add(String(p).trim())
  }
  if (plants.size === 0) return customerKey
  return `${customerKey} — ${[...plants].join(', ')}`
}

function hoursFromActivity(a) {
  const m = getStructured(a).time_info?.duration_minutes
  if (typeof m === 'number' && m > 0 && !Number.isNaN(m)) {
    return Math.round((m / 60) * 10) / 10
  }
  return null
}

/**
 * Same field as API / "All employee activity" list: `activity.summary` first.
 * Fallback only if missing: structured.summary, then rawConversation snippet.
 * Never substitute issue/intent — those are separate columns / concern context.
 */
function activitySummaryForExport(a) {
  const st = getStructured(a)

  let text = typeof a.summary === 'string' ? a.summary.trim() : ''
  if (!text && typeof st.summary === 'string') {
    text = st.summary.trim()
  }
  if (!text && typeof a.rawConversation === 'string' && a.rawConversation.trim()) {
    text = a.rawConversation.trim().slice(0, 500)
  }

  if (!text) return '—'
  return text.replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ').trim()
}

function sanitizeSheetName(name) {
  const s = String(name || 'Sheet')
    .replace(/[:\\/?*[\]]/g, '-')
    .trim()
    .slice(0, 31)
  return s || 'Customer'
}

function filterActivitiesInWeek(activities, weekMonday) {
  const ws = new Date(weekMonday)
  ws.setHours(0, 0, 0, 0)
  const we = addDays(ws, 6)
  we.setHours(23, 59, 59, 999)
  const t0 = ws.getTime()
  const t1 = we.getTime()
  return activities.filter((a) => {
    const t = new Date(a.createdAt).getTime()
    return t >= t0 && t <= t1
  })
}

/**
 * Write one week block (metadata + day grid + total + meetings). Returns next row index.
 */
function writeWeekBlock(ws, startRow, customerKey, weekActivities, weekMonday, program) {
  const sunday = addDays(weekMonday, 6)
  sunday.setHours(23, 59, 59, 999)
  const weekEndLabel = formatWeekEndShort(sunday)

  const dayKeys = []
  for (let i = 0; i < 7; i++) {
    dayKeys.push(localDateKey(addDays(weekMonday, i)))
  }

  let row = startRow

  ws.mergeCells(`A${row}:G${row}`)
  ws.getCell(row, 1).value = `Week ending ${weekEndLabel} (${formatUsShort(weekMonday)} – ${formatUsShort(sunday)})`
  ws.getCell(row, 1).font = { bold: true, size: 11 }
  row += 1

  const employee = employeeNamesFromActivities(weekActivities)
  const programLine = programLineFromActivities(weekActivities, program)
  const siteLine = siteLineFromCustomerSheet(customerKey, weekActivities)

  ws.getCell(row, 1).value = 'Employee'
  ws.getCell(row, 2).value = employee
  row += 1
  ws.getCell(row, 1).value = 'Program / OEM'
  ws.getCell(row, 2).value = programLine
  row += 1
  ws.getCell(row, 1).value = 'Customer / site'
  ws.getCell(row, 2).value = siteLine
  row += 1
  ws.getCell(row, 1).value = 'Week ending'
  ws.getCell(row, 2).value = weekEndLabel
  row += 1

  for (let r = startRow + 1; r < row; r++) {
    ws.getCell(r, 1).font = { bold: true }
  }

  row += 1

  const headers = ['Day', 'Date', 'Part number', 'Location', 'Concern / QR number', 'Activity summary', 'Hours']
  headers.forEach((h, i) => {
    const cell = ws.getCell(row, i + 1)
    cell.value = h
    cell.font = { bold: true }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8E8E8' },
    }
  })
  row += 1

  let totalHours = 0
  const byDay = new Map()
  for (const a of weekActivities) {
    const created = parseLocalDateFromIso(a.createdAt)
    if (!created) continue
    const key = localDateKey(created)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(a)
  }

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(weekMonday, i)
    const key = dayKeys[i]
    const dayActs = byDay.get(key) || []

    if (dayActs.length === 0) {
      ws.getCell(row, 1).value = DAY_LABELS[i]
      ws.getCell(row, 2).value = formatUsShort(dayDate)
      ws.getCell(row, 3).value = ''
      ws.getCell(row, 4).value = ''
      ws.getCell(row, 5).value = ''
      ws.getCell(row, 6).value = ''
      ws.getCell(row, 7).value = ''
      row += 1
      continue
    }

    for (const a of dayActs) {
      const st = getStructured(a)
      const part = st.part_name || st.part_number || ''
      const location = (a.location || st.location || '').toString().toUpperCase()
      const concern = st.concern_id || st.dtc_code || ''
      const activityText = activitySummaryForExport(a)
      const h = hoursFromActivity(a)
      if (h != null) totalHours += h

      ws.getCell(row, 1).value = DAY_LABELS[i]
      ws.getCell(row, 2).value = formatUsShort(dayDate)
      ws.getCell(row, 3).value = part
      ws.getCell(row, 4).value = location
      ws.getCell(row, 5).value = concern
      ws.getCell(row, 6).value = activityText
      ws.getCell(row, 7).value = h != null ? h : ''
      row += 1
    }
  }

  ws.getCell(row, 6).value = 'Total for period'
  ws.getCell(row, 6).font = { bold: true }
  ws.getCell(row, 7).value = totalHours > 0 ? Math.round(totalHours * 10) / 10 : ''
  ws.getCell(row, 7).font = { bold: true }
  row += 2

  ws.getCell(row, 1).value = 'Quality meetings & related notes'
  ws.getCell(row, 1).font = { bold: true, size: 12 }
  row += 1

  const meetings = weekActivities.filter((a) => getStructured(a).source_type === 'quality-meeting')
  if (meetings.length === 0) {
    ws.getCell(row, 1).value = ''
  } else {
    const lines = meetings.map((a) => {
      const t = activitySummaryForExport(a)
      const when = a.createdAt ? formatUsShort(parseLocalDateFromIso(a.createdAt)) : ''
      return when && t !== '—' ? `${when}: ${t}` : t
    })
    ws.mergeCells(`A${row}:G${row}`)
    ws.getCell(row, 1).value = lines.join('\n')
    ws.getCell(row, 1).alignment = { wrapText: true, vertical: 'top' }
  }
  row += 1

  return row + 1
}

/**
 * @param {object} params
 * @param {Record<string, any[]>} params.byCustomer
 * @param {Date[]} params.weekMondays - one or more week start Mondays
 * @param {string} [params.program]
 * @param {string} [params.periodSummary] - e.g. "Same filters as AI weekly report"
 */
export async function buildWeeklyActivityExcelBuffer({ byCustomer, weekMondays, program, periodSummary }) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'AI Activity Tracker'
  wb.created = new Date()

  const customers = Object.keys(byCustomer).sort((a, b) => a.localeCompare(b))
  if (customers.length === 0) {
    const ws = wb.addWorksheet('No activities')
    ws.getCell('A1').value = 'No activities matched the selected filters and date range.'
    const buf = await wb.xlsx.writeBuffer()
    return Buffer.from(buf)
  }

  for (const customer of customers) {
    const allForCustomer = byCustomer[customer] || []
    const sheetName = sanitizeSheetName(customer)
    const ws = wb.addWorksheet(sheetName)

    let row = 1
    ws.mergeCells(`A${row}:G${row}`)
    ws.getCell(row, 1).value = 'Weekly activity report'
    ws.getCell(row, 1).font = { bold: true, size: 14 }
    ws.getCell(row, 1).alignment = { horizontal: 'center' }
    row += 1

    ws.mergeCells(`A${row}:G${row}`)
    ws.getCell(row, 1).value =
      'Timesheet layout — one tab per customer — from saved AI activity logs (matches Activity filters).'
    ws.getCell(row, 1).font = { size: 11 }
    ws.getCell(row, 1).alignment = { horizontal: 'center' }
    row += 1

    if (periodSummary) {
      ws.mergeCells(`A${row}:G${row}`)
      ws.getCell(row, 1).value = periodSummary
      ws.getCell(row, 1).font = { size: 10, italic: true }
      ws.getCell(row, 1).alignment = { horizontal: 'center' }
      row += 1
    }

    row += 1

    for (const wm of weekMondays) {
      const weekActs = filterActivitiesInWeek(allForCustomer, wm)
      row = writeWeekBlock(ws, row, customer, weekActs, wm, program)
    }

    ws.columns = [
      { width: 12 },
      { width: 11 },
      { width: 28 },
      { width: 9 },
      { width: 16 },
      { width: 50 },
      { width: 10 },
    ]
  }

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}

export function groupActivitiesByCustomer(activities) {
  /** @type {Record<string, any[]>} */
  const out = {}
  for (const a of activities) {
    const key = (a.customer && String(a.customer).trim()) || '—'
    if (!out[key]) out[key] = []
    out[key].push(a)
  }
  return out
}

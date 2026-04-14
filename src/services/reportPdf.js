import PDFDocument from 'pdfkit'

const MAX_PDF_IMAGES = 36
const FETCH_TIMEOUT_MS = 12000
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

async function fetchImageBuffer(url) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_IMAGE_BYTES) return null
    return buf
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/**
 * @param {{ title?: string, content?: string, imageGallery?: Array<{ customer?: string, summary?: string, imageUrls?: string[] }> }} opts
 */
export async function renderWeeklyReportPdf({ title, content, imageGallery }) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: {
      Title: title || 'Weekly quality report',
    },
  })

  const chunks = []
  doc.on('data', (c) => chunks.push(c))

  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  const safeTitle = title || 'Weekly quality report'
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text(safeTitle)
  doc.moveDown(0.8)
  doc.font('Helvetica').fontSize(11).fillColor('#111111')

  const body = typeof content === 'string' ? content : ''
  doc.text(body, { lineGap: 2 })

  const gallery = Array.isArray(imageGallery) ? imageGallery : []
  let used = 0

  outer: for (const entry of gallery) {
    const urls = Array.isArray(entry?.imageUrls) ? entry.imageUrls : []
    for (const rawUrl of urls) {
      if (used >= MAX_PDF_IMAGES) break outer
      if (typeof rawUrl !== 'string' || !/^https?:\/\//i.test(rawUrl.trim())) continue
      const buf = await fetchImageBuffer(rawUrl.trim())
      if (!buf) continue

      doc.addPage()
      doc.x = doc.page.margins.left
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111')
      doc.text(String(entry.customer || 'Activity').slice(0, 120))
      doc.moveDown(0.35)
      if (entry.summary) {
        doc.font('Helvetica').fontSize(9).fillColor('#444444')
        doc.text(String(entry.summary).slice(0, 450), { lineGap: 1 })
        doc.moveDown(0.45)
      }
      doc.fillColor('#111111')
      doc.font('Helvetica').fontSize(11)
      try {
        doc.image(buf, {
          fit: [500, 340],
          align: 'center',
        })
      } catch {
        doc.font('Helvetica').fontSize(9).text('(Image could not be embedded in PDF)')
      }
      used++
    }
  }

  doc.end()
  return await done
}

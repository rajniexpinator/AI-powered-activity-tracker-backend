import PDFDocument from 'pdfkit'

export async function renderWeeklyReportPdf({ title, content }) {
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

  doc.end()
  return await done
}

